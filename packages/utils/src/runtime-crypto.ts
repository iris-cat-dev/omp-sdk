import { createHash, createHmac, getHashes, type BinaryToTextEncoding, type Hash, type Hmac } from "node:crypto";
import { hashBytes, type HashInput } from "./runtime-hash";

const hashByteLengths = new Map<string, number>();

class NodeCryptoHash {
	readonly algorithm: string;
	readonly byteLength: number;
	readonly #key: string | Uint8Array | undefined;
	#hash: Hash | Hmac;
	#hmacChunks: Buffer[] | undefined;
	constructor(algorithm: string, hmacKey?: string | Uint8Array) {
		this.algorithm = algorithm;
		this.#key = hmacKey;
		this.#hash = hmacKey === undefined ? createHash(algorithm) : createHmac(algorithm, hmacKey);
		let byteLength = hashByteLengths.get(algorithm);
		if (byteLength === undefined) {
			byteLength = createHash(algorithm).digest().length;
			hashByteLengths.set(algorithm, byteLength);
		}
		this.byteLength = byteLength;
		if (hmacKey !== undefined) this.#hmacChunks = [];
	}
	update(input: HashInput, inputEncoding?: BufferEncoding): this {
		if (typeof input === "string") this.#hash.update(input, inputEncoding);
		else this.#hash.update(hashBytes(input));
		// OpenSSL does not expose HMAC state cloning; retain only HMAC inputs for copy().
		if (this.#hmacChunks)
			this.#hmacChunks.push(
				typeof input === "string" ? Buffer.from(input, inputEncoding) : Buffer.from(hashBytes(input)),
			);
		return this;
	}
	copy(): NodeCryptoHasher {
		const copy = new NodeCryptoHasher(this.algorithm, this.#key);
		if (this.#hmacChunks) {
			for (const chunk of this.#hmacChunks) copy.update(chunk);
		} else copy.#hash = (this.#hash as Hash).copy();
		return copy;
	}
	digest(): Buffer;
	digest(encoding: BinaryToTextEncoding): string;
	digest<T extends ArrayBufferView>(into: T): T;
	digest(encoding?: BinaryToTextEncoding | ArrayBufferView): Buffer | string | ArrayBufferView {
		const bytes = this.#hash.digest();
		this.#hash = this.#key === undefined ? createHash(this.algorithm) : createHmac(this.algorithm, this.#key);
		if (this.#hmacChunks) this.#hmacChunks.length = 0;
		if (typeof encoding === "string") return bytes.toString(encoding);
		if (encoding) {
			if (encoding.byteLength < bytes.length) throw new RangeError("Hash destination is too small");
			new Uint8Array(encoding.buffer, encoding.byteOffset, encoding.byteLength).set(bytes);
			return encoding;
		}
		return bytes;
	}
}

export class NodeCryptoHasher extends NodeCryptoHash {
	static hash(algorithm: string, input: HashInput): Buffer;
	static hash(algorithm: string, input: HashInput, encoding: BinaryToTextEncoding): string;
	static hash<T extends ArrayBufferView>(algorithm: string, input: HashInput, into: T): T;
	static hash(
		algorithm: string,
		input: HashInput,
		encoding?: BinaryToTextEncoding | ArrayBufferView,
	): Buffer | string | ArrayBufferView {
		const hasher = new NodeCryptoHasher(algorithm).update(input);
		if (typeof encoding === "string") return hasher.digest(encoding);
		if (encoding) return hasher.digest(encoding);
		return hasher.digest();
	}
	static readonly algorithms = getHashes();
}

export class NodeSHA256 extends NodeCryptoHash {
	constructor() {
		super("sha256");
	}
	static readonly byteLength = 32;
	static hash(input: HashInput): Buffer;
	static hash(input: HashInput, encoding: BinaryToTextEncoding): string;
	static hash<T extends ArrayBufferView>(input: HashInput, into: T): T;
	static hash(input: HashInput, encoding?: BinaryToTextEncoding | ArrayBufferView): Buffer | string | ArrayBufferView {
		const hasher = new NodeSHA256().update(input);
		if (typeof encoding === "string") return hasher.digest(encoding);
		if (encoding) return hasher.digest(encoding);
		return hasher.digest();
	}
}

export type UUIDv5Input = string | ArrayBufferView | ArrayBuffer;
export type UUIDv5Namespace = UUIDv5Input | "dns" | "url" | "oid" | "x500";
export type UUIDv5Encoding = "hex" | "base64" | "base64url" | "buffer";

const UUIDV5_PREDEFINED_NAMESPACES: Readonly<Record<string, Uint8Array>> = {
	dns: Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"),
	url: Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"),
	oid: Buffer.from("6ba7b8129dad11d180b400c04fd430c8", "hex"),
	x500: Buffer.from("6ba7b8149dad11d180b400c04fd430c8", "hex"),
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveUUIDv5Namespace(namespace: UUIDv5Namespace): Uint8Array {
	if (typeof namespace === "string") {
		const predefined = UUIDV5_PREDEFINED_NAMESPACES[namespace];
		if (predefined) return predefined;
		if (!UUID_PATTERN.test(namespace)) {
			throw new TypeError("Invalid UUID format for namespace");
		}
		return Buffer.from(namespace.replaceAll("-", ""), "hex");
	}
	const bytes = hashBytes(namespace);
	if (bytes.byteLength !== 16) {
		throw new TypeError("Namespace must be exactly 16 bytes");
	}
	return bytes;
}

export function nodeRandomUUIDv5(
	name: UUIDv5Input,
	namespace: UUIDv5Namespace,
	encoding?: "hex" | "base64" | "base64url",
): string;
export function nodeRandomUUIDv5(name: UUIDv5Input, namespace: UUIDv5Namespace, encoding: "buffer"): Buffer;
export function nodeRandomUUIDv5(
	name: UUIDv5Input,
	namespace: UUIDv5Namespace,
	encoding?: UUIDv5Encoding,
): string | Buffer {
	const nsBytes = resolveUUIDv5Namespace(namespace);
	const hasher = createHash("sha1").update(nsBytes);
	if (typeof name === "string") hasher.update(name, "utf8");
	else hasher.update(hashBytes(name));
	const digest = hasher.digest();
	const bytes = Buffer.allocUnsafe(16);
	digest.copy(bytes, 0, 0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	if (encoding === "buffer") return bytes;
	if (encoding === "base64" || encoding === "base64url") return bytes.toString(encoding);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
