import { afterEach, expect, it, mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";
import { RpcOutputError, RpcOutputWriter } from "../src/modes/rpc/rpc-output";
import { handleRpcOutputFailure } from "../src/modes/rpc/rpc-output-failure";

afterEach(() => {
	mock.restore();
	vi.useRealTimers();
});

it("drains RPC command responses after stdin EOF while the real stdout pipe is backpressured", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "../src/cli.ts"),
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--no-session",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: import.meta.dir,
			env: { ...process.env, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const chunks: Uint8Array[] = [];
	try {
		const ready = await reader.read();
		if (ready.done) throw new Error(`RPC exited before ready: ${await stderr}`);
		chunks.push(ready.value);
		for (let id = 0; id < 128; id++) {
			child.stdin.write(`${JSON.stringify({ type: "get_state", id: `${id}:${"x".repeat(32768)}` })}\n`);
		}
		await child.stdin.flush();
		child.stdin.end();
		await Bun.sleep(300);
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			chunks.push(next.value);
		}
		const output = Buffer.concat(chunks).toString();
		const replies: { id: string; type: string; success?: boolean }[] = output
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(replies.filter(reply => reply.type === "response").map(reply => reply.id.split(":")[0])).toEqual(
			Array.from({ length: 128 }, (_, id) => String(id)),
		);
		expect(await child.exited).toBe(0);
	} finally {
		reader.releaseLock();
		child.kill();
		await child.exited.catch(() => {});
		await stderr;
	}
}, 30_000);

it("delivers ordered v1 and chunked v2 frames through a slow sink before close completes", async () => {
	const chunks: Buffer[] = [];
	const sink = new Writable({
		highWaterMark: 1024,
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			void Bun.sleep(1).then(() => callback());
		},
	});
	const errors: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => errors.push(error));
	const encoder = new RpcFrameEncoder();
	const expected: object[] = [{ type: "ready" }, { type: "response", command: "negotiate_protocol", success: true }];
	for (const frame of expected) writer.write(encoder.encodeFrames(frame));
	encoder.setProtocolVersion(2);
	for (let id = 0; id < 32; id++) {
		const frame = { type: "response", id, data: `${id}:${"🌍".repeat(id === 4 ? 300_000 : 8192)}` };
		expected.push(frame);
		writer.write(encoder.encodeFrames(frame));
	}
	const final = { type: "agent_end", messages: [] };
	expected.push(final);
	writer.write(encoder.encodeFrames(final));
	await writer.close();
	const decoder = new RpcFrameDecoder();
	const actual = Buffer.concat(chunks)
		.toString()
		.trimEnd()
		.split("\n")
		.map(line => decoder.push(JSON.parse(line)))
		.filter(frame => frame !== undefined);
	expect(actual).toEqual(expected);
	expect(errors).toEqual([]);
});

it("fails promptly and removes spilled output when the reader disconnects", async () => {
	await using dir = await TempDir.create("@rpc-output-disconnect-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failure = Promise.withResolvers<Error>();
	const writer = new RpcOutputWriter(sink, failure.resolve);
	writer.write(["first\n", "pending\n"]);
	const closed = writer.close();
	const cause = Object.assign(new Error("reader disconnected"), { code: "EPIPE", syscall: "write" });
	sink.destroy(cause);
	await expect(closed).rejects.toThrow("stage=stdout code=EPIPE syscall=write");
	expect(await failure.promise).toMatchObject({ stage: "stdout", cause });
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
});

it("reports disk exhaustion and removes the partial spool instead of silently dropping accepted output", async () => {
	await using dir = await TempDir.create("@rpc-output-enospc-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	const cause = Object.assign(new Error("disk full /private/session/secret"), { code: "ENOSPC", syscall: "write" });
	spyOn(fs, "writeSync").mockImplementation(() => {
		throw cause;
	});
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failures: Error[] = [];
	const diagnostics: string[] = [];
	const stderr = new Writable({
		write(chunk, _encoding, callback) {
			diagnostics.push(chunk.toString());
			callback();
		},
	});
	const reported = Promise.withResolvers<void>();
	const writer = new RpcOutputWriter(sink, error => {
		failures.push(error);
		void handleRpcOutputFailure(error, {
			stderr,
			log: () => {
				throw new Error("logger unavailable");
			},
			dispose: async () => {},
			exit: () => reported.resolve(),
		});
	});
	writer.write(["first\n", "pending\n"]);
	await expect(writer.close()).rejects.toThrow("stage=spool-write code=ENOSPC syscall=write");
	await reported.promise;
	expect(diagnostics).toEqual(["[OMP_RPC_FATAL] RPC output failed (stage=spool-write code=ENOSPC syscall=write)\n"]);
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({ stage: "spool-write", code: "ENOSPC", syscall: "write", cause });
	expect(failures[0]?.message).not.toContain("/private/session/secret");
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
	sink.destroy();
});

it("reports a truncated spool during delivery instead of completing a partial protocol stream", async () => {
	await using dir = await TempDir.create("@rpc-output-truncated-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	let release: (() => void) | undefined;
	const sink = new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, callback) {
			release = callback;
		},
	});
	const failures: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => failures.push(error));
	writer.write(["first\n", "pending\n"]);
	const closed = writer.close();
	fs.truncateSync(dir.join("output"), 0);
	release?.();
	await expect(closed).rejects.toThrow("stage=spool-read");
	expect(failures).toHaveLength(1);
	expect(failures[0]?.cause).toMatchObject({ message: "RPC output spool ended before delivery completed" });
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
	sink.destroy();
});

it("preserves spool-create ENOSPC when removing its partial directory also fails", async () => {
	await using dir = await TempDir.create("@rpc-output-create-failure-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	const cause = Object.assign(new Error("full"), { code: "ENOSPC", syscall: "open" });
	spyOn(fs, "openSync").mockImplementation(() => {
		throw cause;
	});
	const remove = spyOn(dir, "removeSync").mockImplementation(() => {
		throw new Error("cleanup failed");
	});
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failures: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => failures.push(error));
	writer.write(["first\n", "spilled\n"]);
	sink.emit("error", Object.assign(new Error("later stdout failure"), { code: "EPIPE" }));
	await expect(writer.close()).rejects.toBe(failures[0]);
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({ stage: "spool-create", code: "ENOSPC", syscall: "open", cause });
	remove.mockRestore();
	sink.destroy();
});

it("retains spool-write failure and its cause even when cleanup and stdout later fail", async () => {
	await using dir = await TempDir.create("@rpc-output-first-failure-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	const cause = Object.assign(new Error("full"), { code: "ENOSPC" });
	spyOn(fs, "writeSync").mockImplementation(() => {
		throw cause;
	});
	const remove = spyOn(dir, "removeSync").mockImplementation(() => {
		throw new Error("cleanup failed");
	});
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failures: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => failures.push(error));
	writer.write(["first\n", "spilled\n"]);
	sink.emit("error", new Error("late pipe failure"));
	await expect(writer.close()).rejects.toBe(failures[0]);
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({ stage: "spool-write", code: "ENOSPC", cause });
	remove.mockRestore();
	sink.destroy();
});

it("mirrors a stdout callback failure independently even if logging throws and disposal writes output", async () => {
	const cause = Object.assign(new Error("secret frame"), { code: "EPIPE", syscall: "write" });
	let stdoutWrites = 0;
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			stdoutWrites++;
			callback(cause);
		},
	});
	const diagnostics: string[] = [];
	const stderr = new Writable({
		write(chunk, _encoding, callback) {
			diagnostics.push(chunk.toString());
			callback();
		},
	});
	const completed = Promise.withResolvers<void>();
	const exits: number[] = [];
	let disposed = 0;
	const writer = new RpcOutputWriter(sink, error => {
		void handleRpcOutputFailure(error, {
			stderr,
			log: () => {
				throw new Error("logger failed");
			},
			dispose: async () => {
				disposed++;
				writer.write(["must not recurse\n"]);
			},
			exit: code => {
				exits.push(code);
				completed.resolve();
			},
		});
	});
	writer.write(["first\n"]);
	await completed.promise;
	await expect(writer.close()).rejects.toMatchObject({ stage: "stdout", cause });
	expect(stdoutWrites).toBe(1);
	expect(disposed).toBe(1);
	expect(exits).toEqual([1]);
	expect(diagnostics).toEqual(["[OMP_RPC_FATAL] RPC output failed (stage=stdout code=EPIPE syscall=write)\n"]);
});

it("still disposes and exits within a bound when stderr never completes its write", async () => {
	vi.useFakeTimers();
	const stderr = new Writable({ write() {} });
	const disposed = mock(async () => {});
	const exit = mock(() => {});
	const reporting = handleRpcOutputFailure(new RpcOutputError("spool-write", { code: "ENOSPC" }), {
		stderr,
		log: () => {},
		dispose: disposed,
		exit,
	});
	vi.advanceTimersByTime(499);
	await Promise.resolve();
	expect(exit).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	await reporting;
	expect(disposed).toHaveBeenCalledTimes(1);
	expect(exit).toHaveBeenCalledWith(1);
	stderr.destroy();
});

it("still disposes and exits when the independent stderr sink fails", async () => {
	const stderr = new Writable({
		write(_chunk, _encoding, callback) {
			callback(Object.assign(new Error("stderr closed"), { code: "EPIPE" }));
		},
	});
	const disposed = mock(async () => {});
	const exit = mock(() => {});
	await handleRpcOutputFailure(new RpcOutputError("stdout", { code: "EPIPE" }), {
		stderr,
		log: () => {},
		dispose: disposed,
		exit,
	});
	expect(disposed).toHaveBeenCalledTimes(1);
	expect(exit).toHaveBeenCalledWith(1);
});

it("classifies spool cleanup errors without losing the underlying filesystem cause", async () => {
	await using dir = await TempDir.create("@rpc-output-cleanup-failure-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	const cause = Object.assign(new Error("remove denied"), { code: "EACCES", syscall: "unlink" });
	const remove = spyOn(dir, "removeSync").mockImplementation(() => {
		throw cause;
	});
	let release: (() => void) | undefined;
	const sink = new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, callback) {
			release = callback;
		},
	});
	const failure = Promise.withResolvers<Error>();
	const writer = new RpcOutputWriter(sink, failure.resolve);
	writer.write(["first\n", "spilled\n"]);
	const closed = writer.close();
	release?.();
	await expect(closed).rejects.toThrow("stage=cleanup code=EACCES syscall=unlink");
	expect(await failure.promise).toMatchObject({ stage: "cleanup", cause });
	remove.mockRestore();
	sink.destroy();
});

it("does not let a stuck disposal strand fatal output shutdown", async () => {
	vi.useFakeTimers();
	const stderr = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	const disposal = Promise.withResolvers<void>();
	const exit = mock(() => {});
	const reporting = handleRpcOutputFailure(new RpcOutputError("stdout", { code: "EPIPE" }), {
		stderr,
		log: () => {},
		dispose: () => disposal.promise,
		exit,
	});
	vi.advanceTimersByTime(2_000);
	await reporting;
	expect(exit).toHaveBeenCalledWith(1);
	disposal.resolve();
	stderr.destroy();
});

it("guards a late stderr write error after the mirror timeout until disposal finishes", async () => {
	vi.useFakeTimers();
	let release: ((error?: Error | null) => void) | undefined;
	const diagnostics: string[] = [];
	const stderr = new Writable({
		write(chunk, _encoding, callback) {
			diagnostics.push(chunk.toString());
			release = callback;
		},
	});
	const closed = Promise.withResolvers<void>();
	stderr.once("close", closed.resolve);
	const disposal = Promise.withResolvers<void>();
	const exit = mock(() => {});
	const cause = Object.assign(new Error("full"), { code: "ENOSPC", syscall: "write" });
	const failure = new RpcOutputError("spool-write", cause);
	const reporting = handleRpcOutputFailure(failure, {
		stderr,
		log: () => {},
		dispose: () => disposal.promise,
		exit,
	});
	vi.advanceTimersByTime(500);
	await Promise.resolve();
	expect(stderr.listenerCount("error")).toBe(1);
	expect(exit).not.toHaveBeenCalled();
	release?.(Object.assign(new Error("late stderr failure"), { code: "EPIPE" }));
	await closed.promise;
	expect(exit).not.toHaveBeenCalled();
	expect(failure).toMatchObject({ stage: "spool-write", code: "ENOSPC", cause });
	expect(diagnostics).toEqual(["[OMP_RPC_FATAL] RPC output failed (stage=spool-write code=ENOSPC syscall=write)\n"]);
	disposal.resolve();
	await reporting;
	expect(exit).toHaveBeenCalledWith(1);
	expect(stderr.listenerCount("error")).toBe(0);
});
