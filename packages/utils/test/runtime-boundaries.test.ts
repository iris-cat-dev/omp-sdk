import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeCryptoHasher, NodeSHA256, nodeRandomUUIDv5 } from "../src/runtime-crypto";
import { NodeRuntimeFile, writeNodeFile, fileBlob } from "../src/runtime-file";
import { crc32, wyhash, xxHash32, xxHash64 } from "../src/runtime-hash";
import { parseJsonlChunk } from "../src/runtime-parsers";
import { runtime } from "../src/runtime";

describe("portable runtime boundaries", () => {
	it("preserves Bun identity hashes across short, block and Unicode boundaries", () => {
		expect(wyhash("hello world")).toBe(0x668d5e431c3b2573n);
		expect(xxHash32("hello world")).toBe(0xcebb6622);
		expect(xxHash64("hello world")).toBe(0x45ab6734b21e6968n);
		expect(crc32("hello world")).toBe(0x0d4a1185);
		for (const length of [0, 1, 3, 4, 8, 15, 16, 17, 31, 32, 33, 47, 48, 49, 64, 96, 97, 1024]) {
			const input = Uint8Array.from({ length }, (_, index) => (index * 191 + 17) & 255);
			for (const seed of [0n, 1n, 0xabcdef01n, 0xffffffffffffffffn]) {
				expect(wyhash(input, seed)).toBe(Bun.hash.wyhash(input, seed));
				expect(xxHash64(input, seed)).toBe(Bun.hash.xxHash64(input, seed));
				expect(xxHash32(input, Number(seed & 0xffffffffn))).toBe(
					Bun.hash.xxHash32(input, Number(seed & 0xffffffffn)),
				);
			}
		}
		for (const input of ["路径/凭据", "🙂/session", "é", "\ud800"])
			expect(wyhash(input)).toBe(Bun.hash.wyhash(input));
		const padded = Buffer.from("prefix-persisted-identity-suffix");
		const window = padded.subarray(7, 25);
		expect(wyhash(window)).toBe(Bun.hash.wyhash(window));
		expect(crc32(Buffer.from("world"), crc32(Buffer.from("hello ")))).toBe(crc32("hello world"));
	});

	it("resets cryptographic digests and copies independent incremental state", () => {
		const hash = new NodeCryptoHasher("sha256").update("persisted");
		const copy = hash.copy().update("-copy");
		expect(hash.digest("hex")).toBe(Bun.SHA256.hash("persisted", "hex"));
		expect(copy.digest("hex")).toBe(Bun.SHA256.hash("persisted-copy", "hex"));
		expect(hash.update("session").digest("hex")).toBe(Bun.SHA256.hash("session", "hex"));
		const destination = new Uint8Array(32);
		expect(NodeSHA256.hash("session", destination)).toBe(destination);
		expect(Buffer.from(destination).toString("hex")).toBe(Bun.SHA256.hash("session", "hex"));
		const hmac = new NodeCryptoHasher("sha256", "key").update("credential");
		expect(hmac.copy().digest("hex")).toBe(new Bun.CryptoHasher("sha256", "key").update("credential").digest("hex"));
	});

	it("writes complete sinks, closes descriptors and serves ranged file bytes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-"));
		try {
			const filename = path.join(directory, "nested", "session.jsonl");
			const file = new NodeRuntimeFile(filename);
			expect(await file.exists()).toBeFalse();
			const sink = file.writer({ highWaterMark: 4 });
			expect(sink.write("one\n")).toBe(4);
			expect(sink.write(Buffer.from("two\n"))).toBe(4);
			expect(sink.flush()).toBe(8);
			expect(sink.end()).toBe(0);
			expect(() => sink.write("late")).toThrow();
			expect(file.size).toBe(8);
			expect((await file.stat()).size).toBe(8);
			expect(await file.slice(4).text()).toBe("two\n");
			expect(await file.slice(-4).text()).toBe("two\n");
			expect(await new Response(file.stream()).text()).toBe("one\ntwo\n");
			expect(await new Blob([await fileBlob(file)]).text()).toBe("one\ntwo\n");
			await writeNodeFile(filename, new Response("rewritten"));
			expect(await file.text()).toBe("rewritten");
			const upload = new NodeRuntimeFile(path.join(directory, "upload.png"));
			expect(upload.type).toBe("image/png");
			await file.unlink();
			expect(await file.exists()).toBeFalse();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("does not mistake directories or file-as-parent paths for existing files", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-file-kind-"));
		try {
			const filename = path.join(directory, "regular");
			await fs.writeFile(filename, "content");
			expect(await new NodeRuntimeFile(directory).exists()).toBeFalse();
			expect(await new NodeRuntimeFile(filename).exists()).toBeTrue();
			expect(await new NodeRuntimeFile(path.join(filename, "child")).exists()).toBeFalse();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps JSONL byte offsets, incomplete tails and prior values on malformed records", () => {
		const valid = Buffer.from('{"text":"凭据🙂"}\n');
		const input = Buffer.concat([Buffer.from("prefix"), valid, Buffer.from('{"pending":')]);
		const result = parseJsonlChunk(input, 6);
		expect(result.values).toEqual([{ text: "凭据🙂" }]);
		expect(result.read).toBe(6 + valid.length);
		expect(result.done).toBeFalse();
		expect(result.error).toBeNull();
		const malformed = parseJsonlChunk('{"ok":1}\n{bad}\n{"ok":2}\n');
		expect(malformed.values).toEqual([{ ok: 1 }]);
		expect(malformed.read).toBe(9);
		expect(malformed.error).toBeInstanceOf(SyntaxError);
		expect(parseJsonlChunk('{"ok":true}').done).toBeTrue();
	});

	it("matches Bun.randomUUIDv5 across predefined, UUID, buffer namespaces and encodings", () => {
		// codex-rs base_instructions vector: uuid5(uuid5(NAMESPACE_OID, "thread-1"), "sys")
		const threadUuid = nodeRandomUUIDv5("thread-1", "oid");
		expect(threadUuid).toBe(Bun.randomUUIDv5("thread-1", "oid"));
		expect(nodeRandomUUIDv5("sys", threadUuid)).toBe("6e6ddc8f-32b3-592b-a5b6-b5f2aface174");
		expect(runtime.randomUUIDv5("sys", runtime.randomUUIDv5("thread-1", "oid"))).toBe(
			"6e6ddc8f-32b3-592b-a5b6-b5f2aface174",
		);

		for (const ns of ["dns", "url", "oid", "x500"] as const) {
			for (const name of ["", "example.com", "路径/凭据🙂"]) {
				expect(nodeRandomUUIDv5(name, ns)).toBe(Bun.randomUUIDv5(name, ns));
				expect(nodeRandomUUIDv5(name, ns, "base64")).toBe(Bun.randomUUIDv5(name, ns, "base64"));
				expect(nodeRandomUUIDv5(name, ns, "base64url")).toBe(Bun.randomUUIDv5(name, ns, "base64url"));
				expect(nodeRandomUUIDv5(name, ns, "buffer")).toEqual(Bun.randomUUIDv5(name, ns, "buffer"));
			}
		}

		const nsBytes = Buffer.from("6ba7b8129dad11d180b400c04fd430c8", "hex");
		expect(nodeRandomUUIDv5(new TextEncoder().encode("sys"), nsBytes)).toBe(
			Bun.randomUUIDv5(new TextEncoder().encode("sys"), nsBytes),
		);
		expect(nodeRandomUUIDv5("sys", "6BA7B812-9DAD-11D1-80B4-00C04FD430C8")).toBe(
			Bun.randomUUIDv5("sys", "6BA7B812-9DAD-11D1-80B4-00C04FD430C8"),
		);
		expect(() => nodeRandomUUIDv5("sys", "not-a-uuid")).toThrow(TypeError);
		expect(() => nodeRandomUUIDv5("sys", new Uint8Array(15))).toThrow(TypeError);
	});
});
