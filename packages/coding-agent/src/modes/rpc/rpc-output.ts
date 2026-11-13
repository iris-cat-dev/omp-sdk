import * as fs from "node:fs";
import type { Writable } from "node:stream";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { runtime, type RuntimeFile } from "@oh-my-pi/pi-utils/runtime";

const READ_BYTES = 64 * 1024;

export type RpcOutputFailureStage = "stdout" | "spool-create" | "spool-write" | "spool-read" | "cleanup";

function safeErrorField(cause: unknown, field: "code" | "syscall"): string | undefined {
	try {
		const value = (cause as NodeJS.ErrnoException | undefined)?.[field];
		return typeof value === "string" && (field === "code" ? /^[A-Z0-9_]{1,64}$/ : /^[a-zA-Z0-9_]{1,64}$/).test(value)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

/** Only operation metadata goes on stderr; the original exception may contain private paths or frames. */
export class RpcOutputError extends Error {
	readonly code: string | undefined;
	readonly syscall: string | undefined;

	constructor(
		readonly stage: RpcOutputFailureStage,
		cause: unknown,
	) {
		const code = safeErrorField(cause, "code");
		const syscall = safeErrorField(cause, "syscall");
		super(`RPC output failed (stage=${stage}${code ? ` code=${code}` : ""}${syscall ? ` syscall=${syscall}` : ""})`, {
			cause,
		});
		this.name = "RpcOutputError";
		this.code = code;
		this.syscall = syscall;
	}
}

interface Spool {
	dir: TempDir;
	file: RuntimeFile;
	fd: number;
	read: number;
	written: number;
}

/** Synchronous event producers spill to disk while the RPC reader applies backpressure. */
export class RpcOutputWriter {
	#spool: Spool | undefined;
	#blocked = false;
	#pumping = false;
	#pendingWrites = 0;
	#failure: Error | undefined;
	#closing = false;
	#completion: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined;

	constructor(
		private readonly sink: Writable,
		private readonly onFailure: (error: Error) => void,
	) {
		sink.on("drain", this.#onDrain);
		sink.on("error", this.#onError);
		sink.on("close", this.#onClose);
		process.once("exit", this.#onExit);
	}

	write(frames: Iterable<string>): void {
		if (this.#failure || this.#closing) return;
		try {
			for (const line of frames) {
				if (this.#failure) break;
				if (this.#blocked || this.#pumping || this.#spool) this.#append(line);
				else this.#write(line);
			}
		} catch (error) {
			this.#fail(error instanceof RpcOutputError ? error : new RpcOutputError("stdout", error));
		}
	}

	async close(): Promise<void> {
		this.#closing = true;
		if (this.#failure) throw this.#failure;
		if (this.#pendingWrites || this.#spool || this.#pumping) {
			this.#completion ??= Promise.withResolvers<void>();
			await this.#completion.promise;
		}
		this.sink.off("drain", this.#onDrain);
		this.sink.off("error", this.#onError);
		this.sink.off("close", this.#onClose);
		process.off("exit", this.#onExit);
	}

	#write(bytes: string | Uint8Array): void {
		this.#pendingWrites++;
		try {
			this.#blocked = !this.sink.write(bytes, error => {
				this.#pendingWrites--;
				if (error) this.#fail(new RpcOutputError("stdout", error));
				else this.#settle();
			});
		} catch (error) {
			this.#pendingWrites--;
			throw new RpcOutputError("stdout", error);
		}
	}

	#append(line: string): void {
		if (!this.#spool) {
			let dir: TempDir | undefined;
			try {
				dir = TempDir.createSync("@omp-rpc-output-");
				const file = dir.join("output");
				const handle = runtime.file(file);
				const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
				this.#spool = { dir, file: handle, fd, read: 0, written: 0 };
			} catch (error) {
				try {
					dir?.removeSync();
				} catch {
					// Cleanup must never replace the operation that first failed.
				}
				throw new RpcOutputError("spool-create", error);
			}
		}
		const spool = this.#spool;
		const bytes = Buffer.from(line);
		let offset = 0;
		// Event callbacks cannot await a disk write without retaining an unbounded queue.
		try {
			while (offset < bytes.length) {
				const written = fs.writeSync(spool.fd, bytes, offset, bytes.length - offset, spool.written);
				if (written === 0) throw new Error("RPC output spool write made no progress");
				offset += written;
				spool.written += written;
			}
		} catch (error) {
			throw new RpcOutputError("spool-write", error);
		}
	}

	#onDrain = (): void => {
		this.#blocked = false;
		void this.#pump();
	};

	#onError = (error: Error): void => this.#fail(new RpcOutputError("stdout", error));
	#onClose = (): void =>
		this.#fail(new RpcOutputError("stdout", new Error("RPC output closed before delivery completed")));
	#onExit = (): void => {
		try {
			this.#removeSpool();
		} catch (error) {
			try {
				logger.warn("RPC output spool cleanup failed", { error: String(error) });
			} catch {
				// Exit cleanup is best effort.
			}
		}
	};

	async #pump(): Promise<void> {
		if (this.#pumping || this.#failure) return;
		this.#pumping = true;
		try {
			while (this.#spool && !this.#blocked && !this.#failure) {
				const spool = this.#spool;
				const end = Math.min(spool.written, spool.read + READ_BYTES);
				let bytes: Uint8Array;
				try {
					bytes = await spool.file.slice(spool.read, end).bytes();
					if (bytes.length !== end - spool.read)
						throw new Error("RPC output spool ended before delivery completed");
				} catch (error) {
					throw new RpcOutputError("spool-read", error);
				}
				if (this.#failure) break;
				spool.read = end;
				this.#write(bytes);
				if (spool.read === spool.written) this.#removeSpool();
			}
		} catch (error) {
			this.#fail(error);
		} finally {
			this.#pumping = false;
			this.#settle();
		}
	}

	#removeSpool(): void {
		const spool = this.#spool;
		if (!spool) return;
		this.#spool = undefined;
		try {
			try {
				fs.closeSync(spool.fd);
			} catch (error) {
				try {
					spool.dir.removeSync();
				} catch {
					// Preserve the first cleanup failure.
				}
				throw error;
			}
			spool.dir.removeSync();
		} catch (error) {
			throw new RpcOutputError("cleanup", error);
		}
	}

	#settle(): void {
		if (!this.#pendingWrites && !this.#spool && !this.#pumping && !this.#failure) this.#completion?.resolve();
	}

	#fail(error: unknown): void {
		if (this.#failure) return;
		this.#failure = error instanceof Error ? error : new Error(String(error));
		try {
			this.#removeSpool();
		} catch {
			// Retain the first failure (and its original cause), not a cleanup aggregate.
		}
		this.#completion?.reject(this.#failure);
		process.off("exit", this.#onExit);
		this.onFailure(this.#failure);
	}
}
