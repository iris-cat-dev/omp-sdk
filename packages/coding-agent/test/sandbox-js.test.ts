import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "../src/extensibility/extensions/types";
import { openSandboxFs, type SandboxFs } from "../src/sandbox-fs";
import { sandboxJsTool } from "../src/sandbox-js";
import { sandboxHttpFixture } from "./fixtures/sandbox-http-fixture";

const fixtures: Array<{ directory: string; files: SandboxFs }> = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const { directory, files } of fixtures.splice(0)) {
		files.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

async function fixture() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-js-")));
	const root = path.join(directory, "root");
	await fs.mkdir(root);
	const files = await openSandboxFs({ root });
	fixtures.push({ directory, files });
	return { directory, root, files };
}

async function execute(files: SandboxFs, code: string, network = false, signal?: AbortSignal) {
	const result = await sandboxJsTool(files, network).execute("js", { code }, signal, undefined, {} as ExtensionContext);
	const text = result.content.map(item => item.type === "text" ? item.text : "").join("");
	return { ...result, text };
}

async function httpFixture(handler: http.RequestListener) {
	const fixture = await sandboxHttpFixture(handler);
	cleanups.push(() => fixture.close());
	return fixture;
}

describe.skipIf(process.platform === "win32")("sandbox_js isolated QuickJS behavior", () => {
	test("return, await, UTF-8 files and bounded logs use only the supplied filesystem", async () => {
		const { files } = await fixture();
		const result = await execute(files, `
			sandbox.write("note.txt", "你好");
			console.log("written", { bytes: 6 });
			return { text: await Promise.resolve(sandbox.read("note.txt")), files: sandbox.list().map(entry => entry.name) };
		`);
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.text)).toEqual({ result: { text: "你好", files: ["note.txt"] }, logs: ['written {"bytes":6}'] });
		expect(files.read("note.txt").toString("utf8")).toBe("你好");
	});

	test("host globals, function constructors, callbacks and imports cannot escape", async () => {
		const { files } = await fixture();
		const globals = await execute(files, `return [typeof process, typeof require, typeof Bun, typeof Buffer, typeof module, typeof fetch, typeof __sandboxRead, typeof WebAssembly];`);
		expect(JSON.parse(globals.text).result).toEqual(Array(8).fill("undefined"));
		// Dynamic imports intentionally exercise the guest module-loading boundary.
		for (const attempt of [
			`return globalThis.constructor.constructor("return process")();`,
			`return sandbox.read.constructor("return require")();`,
			`return console.log.constructor("return Bun")();`,
			`return await import("node:fs");`,
			`return await import("file:///etc/passwd");`,
			`return await import("./sandbox-fs.ts");`,
		]) {
			const denied = await execute(files, attempt);
			expect(denied.isError).toBe(true);
			expect(denied.text).not.toContain(process.cwd());
			expect(denied.text).not.toContain(os.homedir());
		}
		expect(JSON.parse((await execute(files, `return Object.keys(sandbox).sort();`)).text).result).toEqual(["list", "read", "write"]);
	});

	test("globals and guest prototype mutations never survive the next invocation", async () => {
		const { files } = await fixture();
		expect((await execute(files, `globalThis.secret = 123; Object.prototype.leak = 456; return secret;`)).isError).not.toBe(true);
		expect(JSON.parse((await execute(files, `return [typeof secret, typeof ({}).leak];`)).text).result).toEqual(["undefined", "undefined"]);
	});

	test("absolute/traversal paths, links and host-only filesystem operations fail closed", async () => {
		const { directory, root, files } = await fixture();
		const outside = path.join(directory, "outside");
		await fs.writeFile(outside, "outside-secret");
		await fs.symlink(outside, path.join(root, "symlink"));
		await fs.link(outside, path.join(root, "hardlink"));
		for (const denied of [outside, "../outside", "file:///etc/passwd", "symlink", "hardlink"]) {
			for (const operation of [`sandbox.read(${JSON.stringify(denied)})`, `sandbox.write(${JSON.stringify(denied)}, "tampered")`]) {
				const result = await execute(files, `${operation}; return "unexpected";`);
				expect(result.isError).toBe(true);
				expect(result.text).toBe("Sandbox file access denied");
			}
		}
		expect(await fs.readFile(outside, "utf8")).toBe("outside-secret");
		const operations = await execute(files, `return [typeof sandbox.close, typeof sandbox.mkdir, typeof sandbox.remove, typeof sandbox.stat];`);
		expect(JSON.parse(operations.text).result).toEqual(Array(4).fill("undefined"));
	});

	test("source, result, log and file-byte overflows remain real tool errors", async () => {
		const { files } = await fixture();
		for (const [code, message] of [
			[" ".repeat(64 * 1024 + 1), "source exceeds"],
			["//" + "你".repeat(22_000), "source exceeds"],
			[`return "x".repeat(256 * 1024);`, "result exceeds"],
			[`try { console.log("x".repeat(64 * 1024 + 1)); } catch {} return "ignored";`, "logs exceed"],
			[`for (let i = 0; i < 1000; i++) console.log("x".repeat(100)); return true;`, "logs exceed"],
			[`sandbox.write("large", "x".repeat(1024 * 1024 + 1)); return true;`, "Sandbox file access denied"],
		]) {
			const result = await execute(files, code!);
			expect(result.isError).toBe(true);
			expect(result.text).toContain(message!);
		}
	});

	test("cancelled unresolved guest promises and microtask loops release the VM", async () => {
		const { files } = await fixture();
		files.write("ready", Buffer.from("ready"));
		for (const code of [`return await new Promise(() => {});`, `while (true) await Promise.resolve();`]) {
			const entered = Promise.withResolvers<void>();
			// Observe a real native read to cancel only after guest execution begins.
			const observedFiles: SandboxFs = {
				...files,
				read(path, limit) {
					const bytes = files.read(path, limit);
					entered.resolve();
					return bytes;
				},
			};
			const controller = new AbortController();
			const running = execute(observedFiles, `sandbox.read("ready"); ${code}`, false, controller.signal);
			await entered.promise;
			controller.abort();
			const failure = await running;
			expect(failure.isError).toBe(true);
			expect(failure.text).toContain("cancelled");
			expect(JSON.parse((await execute(files, `return 9;`)).text).result).toBe(9);
		}
	});

	test("infinite loop hits CPU budget and the next fresh guest remains usable", async () => {
		const { files } = await fixture();
		const loop = await execute(files, `while (true) {}`);
		expect(loop.isError).toBe(true);
		expect(loop.text).toContain("CPU budget exceeded");
		expect(JSON.parse((await execute(files, `return 42;`)).text).result).toBe(42);
	}, 15_000);

	test.each([
		["Uint8Array memory", `const arrays = []; for (let i = 0; i < 100; i++) arrays.push(new Uint8Array(1024 * 1024)); return arrays.length;`],
		["ArrayBuffer memory", `const buffers = []; for (let i = 0; i < 40; i++) buffers.push(new ArrayBuffer(1024 * 1024)); return buffers.length;`],
		["recursive stack", `function recurse() { return recurse(); } return recurse();`],
	])("%s exhaustion is a guest error, with recovery on the next call", async (_name, code) => {
		const { files } = await fixture();
		const failure = await execute(files, code);
		expect(failure.isError).toBe(true);
		expect(failure.text).not.toContain("CPU budget");
		expect(failure.text).not.toContain(process.cwd());
		expect(JSON.parse((await execute(files, `return "recovered";`)).text).result).toBe("recovered");
	});

	test("standard ArrayBuffer and typed-array allocation remain available below the memory ceiling", async () => {
		const { files } = await fixture();
		const result = await execute(files, `
			const buffer = new ArrayBuffer(1024 * 1024);
			const bytes = new Uint8Array(buffer);
			bytes[0] = 7;
			bytes[bytes.length - 1] = 9;
			return { size: buffer.byteLength, first: bytes[0], last: bytes[bytes.length - 1] };
		`);
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.text).result).toEqual({ size: 1024 * 1024, first: 7, last: 9 });
	});

	test("guest exceptions and syntax errors are errors without host stacks", async () => {
		const { files } = await fixture();
		for (const code of [`throw new Error("guest failure");`, `throw "guest failure";`, `return (;`]) {
			const failure = await execute(files, code);
			expect(failure.isError).toBe(true);
			expect(failure.text).not.toContain(process.cwd());
			expect(failure.text).not.toContain("at runGuest");
		}
		expect((await execute(files, `throw new Error("guest failure");`)).text).toBe("guest failure");
	});

	test("unexpected host failures preserve their cause even when guest code catches the public error", async () => {
		const { files } = await fixture();
		const cause = new Error("Host invariant failed at /private/host-only-path");
		const failingFiles: SandboxFs = { ...files, read() { throw cause; } };
		const failure = await execute(failingFiles, `try { sandbox.read("note"); } catch {} return "ignored";`).then(() => undefined, error => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toBe("Sandbox JavaScript host callback failed");
		expect(failure.message).not.toContain("/private/host-only-path");
		expect(failure.cause.cause).toBe(cause);
		expect(JSON.parse((await execute(files, `return "recovered";`)).text).result).toBe("recovered");
	});

	test("only validator failures become invalid-parameter results", async () => {
		const { files } = await fixture();
		const tool = sandboxJsTool(files, false);
		const invalid = await tool.execute("invalid", { code: 123 }, undefined, undefined, {} as ExtensionContext);
		expect(invalid.isError).toBe(true);
		const cause = new Error("Unexpected caller getter failure");
		const failure = await tool.execute("unexpected", { get code() { throw cause; } }, undefined, undefined, {} as ExtensionContext).then(() => undefined, error => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toBe("Sandbox JavaScript parameter validation failed");
		expect(failure.cause).toBe(cause);
	});

	test("disabled fetch is absent; enabled fetch retains the real URL restrictions", async () => {
		const { files } = await fixture();
		expect(JSON.parse((await execute(files, `return typeof fetch;`)).text).result).toBe("undefined");
		expect((await execute(files, `return await fetch("http://127.0.0.1");`)).isError).toBe(true);
		for (const url of ["http://127.0.0.1", "http://localhost", "http://[::1]", "http://169.254.169.254", "file:///etc/passwd", "https://user:password@example.com"]) {
			const denied = await execute(files, `return await fetch(${JSON.stringify(url)});`, true);
			expect(denied.isError).toBe(true);
			expect(denied.text).not.toContain(process.cwd());
		}
	});

	test("HTTP rejection remains consumable and its parsed error is saved in the controlled namespace", async () => {
		const { files } = await fixture();
		const server = await httpFixture((_request, response) => {
			response.writeHead(422, { "content-type": "application/json" });
			response.end('{"message":"请修改数据"}');
		});
		const result = await execute(files, `
			const response = await fetch(${JSON.stringify(server.url("/submit"))}, { method: "POST", body: "submitted data" });
			if (response.ok) throw new Error("Expected a readable rejection");
			if (!response.headers["content-type"].includes("application/json")) throw new Error("Cannot consume server error as JSON");
			const error = await response.json();
			sandbox.write("server-error.json", JSON.stringify({ status: response.status, message: error.message }));
			return { status: response.status, ok: response.ok, saved: sandbox.read("server-error.json") };
		`, true);
		expect(result.isError).not.toBe(true);
		const saved = '{"status":422,"message":"请修改数据"}';
		expect(JSON.parse(result.text).result).toEqual({ status: 422, ok: false, saved });
		expect(files.read("server-error.json").toString("utf8")).toBe(saved);
	});

	test("invalid response JSON is a guest parse error and cannot create a success artifact", async () => {
		const { files } = await fixture();
		const server = await httpFixture((_request, response) => response.end("not JSON"));
		const result = await execute(files, `
			const response = await fetch(${JSON.stringify(server.url())});
			const parsed = await response.json();
			sandbox.write("parsed.json", JSON.stringify(parsed));
			return "saved";
		`, true);
		expect(result.isError).toBe(true);
		expect(result.text).not.toContain(process.cwd());
		expect(files.list(".")).toEqual([]);
	});

	test("public redirects can be consumed into files while private redirects cannot create artifacts", async () => {
		const { files } = await fixture();
		const server = await httpFixture((request, response) => {
			if (request.url === "/start") { response.writeHead(302, { location: "/final" }); response.end(); }
			else if (request.url === "/private") { response.writeHead(302, { location: "http://127.0.0.1/secret" }); response.end(); }
			else response.end("public result");
		});
		const result = await execute(files, `
			const response = await fetch(${JSON.stringify(server.url("/start"))});
			sandbox.write("download.txt", await response.text());
			return response.url;
		`, true);
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.text).result).toBe(server.url("/final"));
		expect(files.read("download.txt").toString()).toBe("public result");
		const denied = await execute(files, `
			const response = await fetch(${JSON.stringify(server.url("/private"))});
			sandbox.write("private.txt", await response.text());
			return "saved";
		`, true);
		expect(denied.isError).toBe(true);
		expect(files.list(".").map(entry => entry.name)).toEqual(["download.txt"]);
	});

	test("network waiting consumes wall time, not the five-second guest CPU budget", async () => {
		const { files } = await fixture();
		const realNow = performance.now.bind(performance);
		let elapsed = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => realNow() + elapsed);
		cleanups.push(() => clock.mockRestore());
		const server = await httpFixture((_request, response) => {
			// Move the platform clock only while the guest is awaiting real HTTP.
			elapsed = 6_000;
			response.end("waited");
		});
		const result = await execute(files, `return await (await fetch(${JSON.stringify(server.url())})).text();`, true);
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.text).result).toBe("waited");
	});

	test("wall deadline closes HTTP and fails even if guest CPU is idle", async () => {
		const { files } = await fixture();
		const realNow = performance.now.bind(performance);
		let elapsed = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => realNow() + elapsed);
		cleanups.push(() => clock.mockRestore());
		const server = await httpFixture((_request, response) => {
			elapsed = 30_001;
			response.end("too late");
		});
		const result = await execute(files, `return await fetch(${JSON.stringify(server.url())});`, true);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("wall deadline exceeded");
	});

	test("guest fetch rejects unsupported ambient options and caps pending requests", async () => {
		const { files } = await fixture();
		const server = await httpFixture((_request, response) => response.end("not reached"));
		for (const code of [
			`return await fetch(${JSON.stringify(server.url())}, { credentials: "include" });`,
			`return await Promise.all(Array.from({ length: 17 }, () => fetch(${JSON.stringify(server.url())})));`,
		]) {
			const failure = await execute(files, code, true);
			expect(failure.isError).toBe(true);
		}
	});

	test("pre-cancelled calls and cancellation while waiting close owned HTTP resources", async () => {
		const { files } = await fixture();
		const cancelled = new AbortController();
		cancelled.abort();
		expect((await execute(files, `sandbox.write("should-not-exist", "bad");`, false, cancelled.signal)).isError).toBe(true);
		expect(files.list(".")).toEqual([]);
		const received = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const { url } = await httpFixture((request, _response) => {
			request.socket.once("close", closed.resolve);
			received.resolve();
		});
		const controller = new AbortController();
		const running = execute(files, `return await fetch(${JSON.stringify(url())});`, true, controller.signal);
		await received.promise;
		controller.abort();
		const failure = await running;
		expect(failure.isError).toBe(true);
		expect(failure.text).toContain("cancelled");
		await closed.promise;
		expect(JSON.parse((await execute(files, `return 7;`)).text).result).toBe(7);
	});

	test("completion aborts an unawaited fetch and safely discards its pending promise", async () => {
		const { files } = await fixture();
		const received = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const { url } = await httpFixture((request, response) => {
			if (request.url === "/pending") {
				request.socket.once("close", closed.resolve);
				received.resolve();
			} else {
				void received.promise.then(() => response.end("ready"));
			}
		});
		const result = await execute(files, `
			void fetch(${JSON.stringify(url("/pending"))});
			await (await fetch(${JSON.stringify(url("/barrier"))})).text();
			return "done";
		`, true);
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.text).result).toBe("done");
		await closed.promise;
		expect(JSON.parse((await execute(files, `return "next";`)).text).result).toBe("next");
	});
});
