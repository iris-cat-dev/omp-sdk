import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { inspect, isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { isMainThread } from "node:worker_threads";
import * as zlib from "node:zlib";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { sleepLong } from "./async";
import { isExecutable } from "./executable";
import {
	NodeCryptoHasher,
	NodeSHA256,
	nodeRandomUUIDv5,
	type UUIDv5Encoding,
	type UUIDv5Input,
	type UUIDv5Namespace,
} from "./runtime-crypto";
import {
	NodeRuntimeFile,
	writeNodeFile,
	fileBlob,
	type RuntimeFile,
	type RuntimeFilePath,
	type RuntimeWriteData,
} from "./runtime-file";
import { RuntimeGlob } from "./runtime-glob";
import { crc32, wyhash, xxHash32, xxHash64, hashBytes, nonSharedBytes, type HashInput } from "./runtime-hash";
import { JSON5, JSONC, JSONL, TOML, YAML, semver } from "./runtime-parsers";
import { $, shell, spawn, spawnSync, serve } from "./runtime-process";

export { $, shell, spawn, spawnSync, serve, fileBlob, RuntimeGlob, JSON5, JSONC, JSONL, TOML, YAML };
export type { RuntimeFile, RuntimeFilePath, RuntimeFileSink, RuntimeWriteData } from "./runtime-file";
export type { RuntimeGlobScanOptions } from "./runtime-glob";
export type {
	RuntimeServer,
	RuntimeServerWebSocket,
	RuntimeServeOptions,
	RuntimeShellExpression,
	RuntimeShellPromise,
	RuntimeShellResult,
	RuntimeSubprocess,
} from "./runtime-process";
export type { HashInput } from "./runtime-hash";

const skipPrototype = { skipPrototype: true };
const bun = typeof Bun === "undefined" ? undefined : Bun;
export const runtimeCapabilities = Object.freeze({
	backend: bun ? ("bun" as const) : ("node" as const),
	bun: bun !== undefined,
	node: bun === undefined,
	electron: Boolean(process.versions.electron),
	ffi: bun !== undefined,
	sqlite: true,
	zstd: bun !== undefined || typeof zlib.zstdCompressSync === "function",
});

export interface RuntimeWhichOptions {
	cwd?: string;
	PATH?: string;
}
function which(command: string, options?: RuntimeWhichOptions): string | null {
	if (bun) return bun.which(command, options);
	const cwd = options?.cwd ?? process.cwd();
	const extensions =
		process.platform === "win32" && !path.extname(command)
			? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
			: [""];
	const directories =
		command.includes("/") || command.includes("\\")
			? [cwd]
			: (options?.PATH ?? process.env.PATH ?? "").split(path.delimiter);
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = path.resolve(cwd, directory || ".", command + extension);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return null;
}

const sleepWord = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(milliseconds: number): void {
	if (bun) {
		bun.sleepSync(milliseconds);
		return;
	}
	if (!(milliseconds >= 0) || !Number.isFinite(milliseconds))
		throw new RangeError("Sleep duration must be finite and nonnegative");
	Atomics.wait(sleepWord, 0, 0, milliseconds);
}

let lastUuidTimestamp = 0;
let uuidSequence = 0;
function randomUUIDv7(encoding?: "hex" | "base64" | "base64url" | "buffer", timestamp = Date.now()): string | Buffer {
	if (bun) return bun.randomUUIDv7(encoding as "hex", timestamp);
	if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff)
		throw new RangeError("UUIDv7 timestamp must fit in 48 bits");
	const bytes = randomBytes(16);
	if (timestamp === lastUuidTimestamp) {
		uuidSequence++;
		if (uuidSequence > 0xfff) {
			timestamp++;
			uuidSequence = 0;
		}
	} else uuidSequence = bytes.readUInt16BE(6) & 0xfff;
	lastUuidTimestamp = timestamp;
	bytes.writeUIntBE(timestamp, 0, 6);
	bytes.writeUInt16BE(0x7000 | uuidSequence, 6);
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	if (encoding === "buffer") return bytes;
	if (encoding === "base64" || encoding === "base64url") return bytes.toString(encoding);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomUUIDv5(
	name: UUIDv5Input,
	namespace: UUIDv5Namespace,
	encoding?: UUIDv5Encoding,
): string | Buffer {
	if (bun) {
		const bunName = typeof name === "string" ? name : nonSharedBytes(name);
		const bunNamespace = typeof namespace === "string" ? namespace : nonSharedBytes(namespace);
		if (encoding === "buffer") return bun.randomUUIDv5(bunName, bunNamespace, "buffer");
		return bun.randomUUIDv5(bunName, bunNamespace, encoding);
	}
	if (encoding === "buffer") return nodeRandomUUIDv5(name, namespace, "buffer");
	return nodeRandomUUIDv5(name, namespace, encoding);
}

interface RuntimeHash {
	(input: HashInput, seed?: number | bigint): number | bigint;
	wyhash(input: HashInput, seed?: number | bigint): bigint;
	xxHash32(input: HashInput, seed?: number): number;
	xxHash64(input: HashInput, seed?: number | bigint): bigint;
	crc32(input: HashInput, seed?: number): number;
}
const hash: RuntimeHash = Object.assign(
	(input: HashInput, seed?: number | bigint) =>
		bun ? bun.hash(typeof input === "string" ? input : hashBytes(input), seed) : wyhash(input, seed),
	{
		wyhash: (input: HashInput, seed?: number | bigint) =>
			bun
				? bun.hash.wyhash(
						typeof input === "string" ? input : hashBytes(input),
						seed === undefined ? undefined : BigInt(seed),
					)
				: wyhash(input, seed),
		xxHash32: (input: HashInput, seed?: number) =>
			bun ? bun.hash.xxHash32(typeof input === "string" ? input : hashBytes(input), seed) : xxHash32(input, seed),
		xxHash64: (input: HashInput, seed?: number | bigint) =>
			bun
				? bun.hash.xxHash64(
						typeof input === "string" ? input : hashBytes(input),
						seed === undefined ? undefined : BigInt(seed),
					)
				: xxHash64(input, seed),
		crc32: (input: HashInput, seed?: number) =>
			bun ? bun.hash.crc32(typeof input === "string" ? input : hashBytes(input), seed) : crc32(input, seed),
	},
);

function file(target: RuntimeFilePath, options?: { type?: string }): RuntimeFile {
	if (!bun) return new NodeRuntimeFile(target, options);
	return (typeof target === "number"
		? bun.file(target, options)
		: bun.file(target, options)) as unknown as RuntimeFile;
}
async function write(
	target: RuntimeFilePath | RuntimeFile,
	data: RuntimeWriteData,
	options?: { mode?: number; createPath?: boolean },
): Promise<number> {
	if (bun) return bun.write(target as Bun.BunFile, data as Bun.BlobOrStringOrBuffer, options);
	return writeNodeFile(target, data, options);
}

function zstdCompressSync(input: HashInput, options?: { level?: number }): Buffer {
	if (bun) return bun.zstdCompressSync(hashBytes(input), options);
	return zlib.zstdCompressSync(
		hashBytes(input),
		options?.level === undefined
			? undefined
			: { params: { [zlib.constants.ZSTD_c_compressionLevel]: options.level } },
	);
}
function zstdDecompressSync(input: HashInput): Buffer {
	return bun ? bun.zstdDecompressSync(hashBytes(input)) : zlib.zstdDecompressSync(hashBytes(input));
}
async function zstdCompress(input: HashInput, options?: { level?: number }): Promise<Buffer> {
	if (bun) return bun.zstdCompress(hashBytes(input), options);
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	zlib.zstdCompress(
		hashBytes(input),
		options?.level === undefined ? {} : { params: { [zlib.constants.ZSTD_c_compressionLevel]: options.level } },
		(error, output) => (error ? reject(error) : resolve(output)),
	);
	return promise;
}
async function zstdDecompress(input: HashInput): Promise<Buffer> {
	if (bun) return bun.zstdDecompress(hashBytes(input));
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	zlib.zstdDecompress(hashBytes(input), (error, output) => (error ? reject(error) : resolve(output)));
	return promise;
}

/** Explicit shared primitives; never installs a Bun global or imports the Bun runtime on Node. */
export const runtime = {
	capabilities: runtimeCapabilities,
	env: process.env,
	main: bun?.main ?? process.argv[1] ?? "",
	version: bun?.version ?? process.versions.node,
	isMainThread,
	file,
	fileBlob,
	write,
	sleep: (duration: number | Date): Promise<void> =>
		bun ? bun.sleep(duration) : sleepLong(duration instanceof Date ? duration.getTime() - Date.now() : duration),
	sleepSync,
	hash,
	CryptoHasher: (bun?.CryptoHasher ?? NodeCryptoHasher) as unknown as typeof NodeCryptoHasher,
	SHA256: (bun?.SHA256 ?? NodeSHA256) as unknown as typeof NodeSHA256,
	randomUUIDv5: randomUUIDv5 as {
		(name: UUIDv5Input, namespace: UUIDv5Namespace, encoding?: "hex" | "base64" | "base64url"): string;
		(name: UUIDv5Input, namespace: UUIDv5Namespace, encoding: "buffer"): Buffer;
	},
	randomUUIDv7: randomUUIDv7 as {
		(encoding?: "hex" | "base64" | "base64url", timestamp?: number): string;
		(encoding: "buffer", timestamp?: number): Buffer;
	},
	Glob: RuntimeGlob,
	which,
	stringWidth: (text: string, options?: { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean }) =>
		bun ? bun.stringWidth(text, options) : stringWidth(text, options),
	wrapAnsi: (
		text: string,
		columns: number,
		options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean; ambiguousIsNarrow?: boolean },
	) => (bun ? bun.wrapAnsi(text, columns, options) : wrapAnsi(text, columns, options)),
	stripANSI: (text: string) => (bun ? bun.stripANSI(text) : stripVTControlCharacters(text)),
	inspect: bun?.inspect ?? inspect,
	deepEquals: (a: unknown, b: unknown, strict = false) =>
		bun ? bun.deepEquals(a, b, strict) : strict ? isDeepStrictEqual(a, b) : isDeepStrictEqual(a, b, skipPrototype),
	gc: bun?.gc ?? (globalThis as typeof globalThis & { gc?: (force?: boolean) => void }).gc,
	JSON5,
	JSONC,
	JSONL,
	TOML,
	YAML,
	semver,
	zstdCompress,
	zstdCompressSync,
	zstdDecompress,
	zstdDecompressSync,
	gunzipSync: (input: HashInput) => (bun ? bun.gunzipSync(nonSharedBytes(input)) : zlib.gunzipSync(hashBytes(input))),
	gzipSync: (input: HashInput) => (bun ? bun.gzipSync(nonSharedBytes(input)) : zlib.gzipSync(hashBytes(input))),
	spawn,
	spawnSync,
	serve,
	$,
	shell,
};
