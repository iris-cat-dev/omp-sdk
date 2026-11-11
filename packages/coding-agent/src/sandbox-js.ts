import releaseSync from "@jitl/quickjs-ng-wasmfile-release-sync";
import { TraversalError, type as arkType } from "@oh-my-pi/omptype";
import {
	newQuickJSWASMModuleFromVariant,
	newVariant,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSRuntime,
} from "quickjs-emscripten-core";
import type { ToolDefinition } from "./extensibility/extensions/types";
import { sandboxFetch } from "./sandbox-fetch";
import type { SandboxFs } from "./sandbox-fs";
import sandboxJsDescription from "./prompts/tools/sandbox-js.md" with { type: "text" };

const SOURCE_BYTES = 64 * 1024;
const MEMORY_BYTES = 32 * 1024 * 1024;
// Conservative across host engines: a native WASM stack trap cannot unwind QuickJS safely.
const STACK_BYTES = 128 * 1024;
const RESULT_BYTES = 256 * 1024;
const LOG_BYTES = 64 * 1024;
const FILE_BYTES = 1024 * 1024;
const CPU_MS = 5_000;
const WALL_MS = 30_000;
const MAX_PENDING_FETCHES = 16;
const parameters = arkType({ code: "string" });

class SandboxJsInputError extends Error {}
class SandboxJsStopped extends Error {}

// This code executes only inside QuickJS. Its closures retain guest values and
// narrow guest-native callbacks, never host objects or host JS functions.
const BOOTSTRAP = `(() => {
	"use strict";
	const read = globalThis.__sandboxRead;
	const write = globalThis.__sandboxWrite;
	const list = globalThis.__sandboxList;
	const log = globalThis.__sandboxLog;
	const request = globalThis.__sandboxFetch;
	const finish = globalThis.__sandboxResult;
	delete globalThis.__sandboxRead;
	delete globalThis.__sandboxWrite;
	delete globalThis.__sandboxList;
	delete globalThis.__sandboxLog;
	delete globalThis.__sandboxFetch;
	delete globalThis.__sandboxResult;
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const string = String;
	const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
	const text = value => typeof value === "string" ? value : stringify(value) ?? string(value);
	Object.defineProperty(globalThis, "sandbox", { value: Object.freeze({
		read(path) { return read(path); },
		write(path, content) { write(path, content); },
		list(path = ".") { return parse(list(path)); },
	}) });
	Object.defineProperty(globalThis, "console", { value: Object.freeze({
		log(...values) { log(values.map(text).join(" ")); },
	}) });
	if (request) Object.defineProperty(globalThis, "fetch", { value: async (url, init = {}) => {
		if (typeof url !== "string" || !init || typeof init !== "object") throw new TypeError("fetch requires a URL string and optional options object");
		for (const key of Object.keys(init)) {
			if (key !== "method" && key !== "headers" && key !== "body") throw new TypeError("Unsupported fetch option: " + key);
		}
		const response = parse(await request(stringify({ url, method: init.method, headers: init.headers, body: init.body })));
		const body = response.body;
		const headers = Object.freeze(response.headers);
		return Object.freeze({
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			url: response.url,
			headers,
			async text() { return body; },
			async json() { return parse(body); },
		});
	} });
	return async code => {
		const value = await new AsyncFunction("\\"use strict\\";\\n" + code)();
		const result = stringify(value === undefined ? null : value);
		if (result === undefined) throw new TypeError("JavaScript result must be JSON serializable");
		finish(result);
	};
})()`;

function toolResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

/** Every invocation owns a new WASM module, runtime, context and HTTP lifetime. */
export function sandboxJsTool(files: SandboxFs, networkEnabled: boolean): ToolDefinition {
	return {
		name: "sandbox_js",
		label: "Run sandbox JavaScript",
		description: sandboxJsDescription,
		parameters,
		execute: async (_id, args, signal) => {
			let code: string;
			try {
				code = parameters.assert(args).code;
			} catch (error) {
				if (!(error instanceof TraversalError)) throw new Error("Sandbox JavaScript parameter validation failed", { cause: error });
				return toolResult("sandbox_js requires a string code parameter", true);
			}
			if (Buffer.byteLength(code) > SOURCE_BYTES) return toolResult("JavaScript source exceeds 64 KiB", true);
			return runGuest(files, networkEnabled, code, signal);
		},
	};
}

async function runGuest(files: SandboxFs, networkEnabled: boolean, code: string, signal?: AbortSignal) {
	const controller = new AbortController();
	const deadline = performance.now() + WALL_MS;
	const cancel = () => controller.abort();
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	let failure: string | undefined;
	let hostFailure: Error | undefined;
	let executionFailure: Error | undefined;
	const timer = setTimeout(() => {
		failure = "JavaScript wall deadline exceeded (30 s)";
		cancel();
	}, WALL_MS);
	let runtime: QuickJSRuntime | undefined;
	let vm: QuickJSContext | undefined;
	let entry: QuickJSHandle | undefined;
	let execution: QuickJSHandle | undefined;
	let closed = false;
	let cpuMs = 0;
	let activeSince: number | undefined;
	let wake: (() => void) | undefined;
	const notify = () => wake?.();
	controller.signal.addEventListener("abort", notify);
	const pending = new Set<QuickJSDeferredPromise>();
	const tasks = new Set<Promise<void>>();
	const logs: string[] = [];
	let logBytes = 0;
	let result: string | undefined;
	const stopped = () => {
		if (failure || hostFailure) return true;
		if (controller.signal.aborted) failure = "JavaScript execution cancelled";
		else if (performance.now() >= deadline) failure = "JavaScript wall deadline exceeded (30 s)";
		else if (cpuMs + (activeSince === undefined ? 0 : performance.now() - activeSince) >= CPU_MS) failure = "JavaScript CPU budget exceeded (5 s)";
		return failure !== undefined;
	};
	const enter = <T>(operation: () => T): T => {
		if (hostFailure) throw hostFailure;
		if (stopped()) throw new SandboxJsStopped(failure);
		if (activeSince !== undefined) return operation();
		activeSince = performance.now();
		try {
			return operation();
		} finally {
			cpuMs += performance.now() - activeSince;
			activeSince = undefined;
		}
	};
	try {
		if (stopped()) return toolResult(failure!, true);
		// Bound actual WASM linear memory, including ArrayBuffers and VM overhead,
		// independently of the engine allocator's cumulative memory accounting.
		const memory = new WebAssembly.Memory({ initial: 256, maximum: MEMORY_BYTES / 65_536 });
		const module = await newQuickJSWASMModuleFromVariant(newVariant(releaseSync, { wasmMemory: memory }));
		if (module.getWasmMemory() !== memory) throw new Error("QuickJS did not use the bounded WASM memory");
		if (stopped()) return toolResult(failure!, true);
		runtime = module.newRuntime();
		runtime.setMemoryLimit(MEMORY_BYTES);
		runtime.setMaxStackSize(STACK_BYTES);
		runtime.removeModuleLoader();
		runtime.setInterruptHandler(stopped);
		const context = runtime.newContext();
		vm = context;
		const guestError = (message: string) => ({ error: context.newError(message) });
		const stringArgument = (handle: QuickJSHandle | undefined, limit: number): string => {
			if (!handle || context.typeof(handle) !== "string") throw new SandboxJsInputError("Expected a string argument");
			const value = context.getString(handle);
			if (Buffer.byteLength(value) > limit) throw new SandboxJsInputError("Sandbox argument byte limit exceeded");
			return value;
		};
		const reportGuestError = (handle: QuickJSHandle) => {
			try {
				if (failure) return toolResult(failure, true);
				if (hostFailure) throw hostFailure;
				let text: string;
				if (context.typeof(handle) === "string") text = context.getString(handle);
				else {
					const message = enter(() => context.getProp(handle, "message"));
					try { text = context.typeof(message) === "string" ? context.getString(message) : "JavaScript guest threw a non-error value"; }
					finally { message.dispose(); }
					const name = enter(() => context.getProp(handle, "name"));
					try {
						if (context.typeof(name) === "string") {
							const kind = context.getString(name);
							if (kind && kind !== "Error") text = `${kind}: ${text}`;
						}
					} finally { name.dispose(); }
				}
				return toolResult(Buffer.byteLength(text) <= 8192 ? text : "JavaScript error message exceeds 8 KiB", true);
			} finally { handle.dispose(); }
		};
		const bind = (name: string, callback: (...args: QuickJSHandle[]) => QuickJSHandle | { error: QuickJSHandle } | void) => {
			const handle = context.newFunction(name, (...args) => {
				try { return callback(...args); }
				catch (error) {
					hostFailure ??= new Error("Sandbox JavaScript host callback failed", { cause: error });
					return guestError(hostFailure.message);
				}
			});
			try { context.setProp(context.global, name, handle); } finally { handle.dispose(); }
		};
		bind("__sandboxRead", path => {
			let text: string;
			try { text = files.read(stringArgument(path, SOURCE_BYTES), FILE_BYTES).toString("utf8"); }
			catch (error) {
				if (error instanceof SandboxJsInputError || (error instanceof Error && error.message === "Sandbox file access denied")) return guestError("Sandbox file access denied");
				throw new Error("Sandbox JavaScript file read failed", { cause: error });
			}
			return context.newString(text);
		});
		bind("__sandboxWrite", (path, content) => {
			try { files.write(stringArgument(path, SOURCE_BYTES), Buffer.from(stringArgument(content, FILE_BYTES))); }
			catch (error) {
				if (error instanceof SandboxJsInputError || (error instanceof Error && error.message === "Sandbox file access denied")) return guestError("Sandbox file access denied");
				throw new Error("Sandbox JavaScript file write failed", { cause: error });
			}
		});
		bind("__sandboxList", path => {
			let entries: string;
			try { entries = JSON.stringify(files.list(stringArgument(path, SOURCE_BYTES))); }
			catch (error) {
				if (error instanceof SandboxJsInputError || (error instanceof Error && error.message === "Sandbox file access denied")) return guestError("Sandbox file access denied");
				throw new Error("Sandbox JavaScript file list failed", { cause: error });
			}
			return context.newString(entries);
		});
		bind("__sandboxLog", value => {
			try {
				const text = stringArgument(value, LOG_BYTES);
				logBytes += Buffer.byteLength(text) + 1;
				if (logBytes > LOG_BYTES) { failure = "JavaScript logs exceed 64 KiB"; return guestError(failure); }
				logs.push(text);
			} catch (error) {
				if (!(error instanceof SandboxJsInputError)) throw error;
				failure = "JavaScript logs exceed 64 KiB";
				return guestError(failure);
			}
		});
		bind("__sandboxResult", value => {
			try { result = stringArgument(value, RESULT_BYTES); }
			catch (error) {
				if (!(error instanceof SandboxJsInputError)) throw error;
				failure = "JavaScript result exceeds 256 KiB";
				return guestError(failure);
			}
		});
		if (networkEnabled) bind("__sandboxFetch", value => {
			let input: unknown;
			try { input = JSON.parse(stringArgument(value, 6 * FILE_BYTES + SOURCE_BYTES)); }
			catch (error) {
				if (!(error instanceof SyntaxError) && !(error instanceof SandboxJsInputError)) throw error;
				return guestError("Invalid sandbox fetch request");
			}
			if (pending.size >= MAX_PENDING_FETCHES) return guestError("At most 16 sandbox fetches may be pending");
			const deferred = context.newPromise();
			pending.add(deferred);
			const task: Promise<void> = sandboxFetch(input, controller.signal).then(response => {
				if (closed || stopped()) return;
				enter(() => {
					const handle = context.newString(JSON.stringify(response));
					try { deferred.resolve(handle); } finally { handle.dispose(); }
				});
			}, error => {
				if (closed || stopped()) return;
				enter(() => {
					// HTTP errors are public, sanitized by sandboxFetch; no host stack crosses the bridge.
					const handle = context.newError(error instanceof Error ? error.message : "Sandbox HTTP request failed");
					try { deferred.reject(handle); } finally { handle.dispose(); }
				});
			}).catch(error => {
				if (!(error instanceof SandboxJsStopped)) hostFailure ??= new Error("Sandbox JavaScript promise settlement failed", { cause: error });
			}).finally(() => {
				try {
					if (!closed) { pending.delete(deferred); deferred.dispose(); }
				} catch (error) {
					hostFailure ??= new Error("Sandbox JavaScript promise cleanup failed", { cause: error });
				} finally {
					tasks.delete(task);
					notify();
				}
			});
			tasks.add(task);
			return deferred.handle.dup();
		});
		const setup = enter(() => context.evalCode(BOOTSTRAP, "sandbox-bootstrap.js", { type: "global" }));
		if (setup.error) {
			const error = reportGuestError(setup.error);
			if (failure) return error;
			throw new Error("Sandbox JavaScript guest initialization failed", { cause: new Error(error.content[0]!.text) });
		}
		entry = setup.value;
		const source = context.newString(code);
		try {
			const start = enter(() => context.callFunction(entry!, context.undefined, source));
			if (start.error) return reportGuestError(start.error);
			execution = start.value;
		} finally { source.dispose(); }
		while (!stopped()) {
			const jobs = enter(() => runtime!.executePendingJobs(64));
			if (jobs.error) return reportGuestError(jobs.error);
			const state = context.getPromiseState(execution);
			if (state.type === "fulfilled") {
				state.value.dispose();
				if (stopped()) break;
				if (result === undefined) throw new Error("Completed guest omitted its serialized result");
				return toolResult(`{"result":${result},"logs":${JSON.stringify(logs)}}`);
			}
			if (state.type === "rejected") return reportGuestError(state.error);
			if (runtime.hasPendingJob()) {
				// Yield between job batches so cancellation can reach a busy microtask loop.
				const turn = Promise.withResolvers<void>();
				setTimeout(turn.resolve, 0);
				await turn.promise;
			} else {
				const ready = Promise.withResolvers<void>();
				wake = ready.resolve;
				if (stopped()) ready.resolve();
				await ready.promise;
				wake = undefined;
			}
		}
		if (hostFailure) throw hostFailure;
		return toolResult(failure!, true);
	} catch (error) {
		if (error instanceof SandboxJsStopped) return toolResult(error.message, true);
		executionFailure = new Error("Sandbox JavaScript host execution failed", { cause: error });
		throw executionFailure;
	} finally {
		closed = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		controller.signal.removeEventListener("abort", notify);
		controller.abort();
		try {
			for (const deferred of pending) deferred.dispose();
			pending.clear();
			execution?.dispose();
			entry?.dispose();
			vm?.dispose();
			runtime?.dispose();
		} catch (error) {
			const cause = executionFailure ? new AggregateError([executionFailure, error], "Sandbox JavaScript execution and cleanup both failed") : error;
			throw new Error("Sandbox JavaScript resource cleanup failed", { cause });
		} finally {
			await Promise.allSettled(tasks);
		}
		if (hostFailure) throw hostFailure;
	}
}
