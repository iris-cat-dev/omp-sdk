import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { openSandboxFs, type SandboxFs } from "../src/sandbox-fs";
import { sandboxTools, SANDBOX_SYSTEM_PROMPT } from "../src/sandbox";
import type { ExtensionContext } from "../src/extensibility/extensions/types";

const fixtures: Array<{ directory: string; files: SandboxFs }> = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) { fixture.files.close(); await fs.rm(fixture.directory, { recursive: true, force: true }); }
});
async function fixture() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-test-")));
	const root = path.join(directory, "root");
	await fs.mkdir(root);
	const files = await openSandboxFs({ root });
	fixtures.push({ directory, files });
	return { directory, root, files };
}

describe.skipIf(process.platform === "win32")("native descriptor-bound sandbox", () => {
	test("inside read/write/list; exclusive writes; stat/mkdir/remove are host-only", async () => {
		const { files } = await fixture();
		files.mkdir("nested");
		files.write("nested/note.txt", Buffer.from("hello"), { exclusive: true });
		expect(files.read("nested/note.txt").toString()).toBe("hello");
		expect(files.list(".").map(entry => [entry.name, entry.isDirectory])).toEqual([["nested", true]]);
		expect(files.stat("nested/note.txt")).toMatchObject({ isDirectory: false, size: 5 });
		expect(() => files.write("nested/note.txt", Buffer.from("overwrite"), { exclusive: true })).toThrow("denied");
		expect(files.read("nested/note.txt").toString()).toBe("hello");
		files.remove("nested/note.txt");
		expect(files.list("nested")).toEqual([]);
		expect(sandboxTools(files).map(tool => tool.name)).toEqual(["sandbox_read", "sandbox_write", "sandbox_list"]);
	});
	test("absolute, traversal, drive, UNC, URI and NUL are refused for reads and writes", async () => {
		const { directory, files } = await fixture();
		await fs.writeFile(path.join(directory, "outside"), "outside-secret");
		for (const denied of [path.join(directory, "outside"), "../outside", "nested/../../outside", "C:\\outside", "\\\\host\\share", "file:///outside", "local://outside", "ssh://host/outside", "a\0b", "a//b"]) {
			expect(() => files.read(denied)).toThrow("denied");
			expect(() => files.write(denied, Buffer.from("tamper"))).toThrow("denied");
		}
		expect(await fs.readFile(path.join(directory, "outside"), "utf8")).toBe("outside-secret");
	});
	test("leaf/parent symlinks and hardlinks cannot disclose or overwrite outside bytes", async () => {
		const { directory, root, files } = await fixture();
		await fs.mkdir(path.join(directory, "outside-dir"));
		const outside = path.join(directory, "outside-dir", "secret");
		await fs.writeFile(outside, "outside-secret");
		await fs.symlink(outside, path.join(root, "leaf"));
		await fs.symlink(path.dirname(outside), path.join(root, "parent"));
		await fs.link(outside, path.join(root, "hardlink"));
		for (const denied of ["leaf", "parent/secret", "hardlink"]) {
			expect(() => files.read(denied)).toThrow("denied");
			expect(() => files.write(denied, Buffer.from("tamper"))).toThrow("denied");
		}
		expect(() => files.list("parent")).toThrow("denied");
		expect(await fs.readFile(outside, "utf8")).toBe("outside-secret");
	});
	test("root replacement does not rebind the held directory descriptor", async () => {
		const { directory, root, files } = await fixture();
		files.write("note", Buffer.from("original"));
		const oldRoot = path.join(directory, "original-root");
		await fs.rename(root, oldRoot);
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, "note"), "replacement-secret");
		expect(files.read("note").toString()).toBe("original");
		files.write("note", Buffer.from("still-original"));
		expect(await fs.readFile(path.join(root, "note"), "utf8")).toBe("replacement-secret");
	});
	test("parent replacement symlink after prior access cannot redirect descriptor-relative opens", async () => {
		const { directory, root, files } = await fixture();
		files.mkdir("nested"); files.write("nested/file", Buffer.from("inside"));
		expect(files.read("nested/file").toString()).toBe("inside");
		await fs.rename(path.join(root, "nested"), path.join(root, "old-nested"));
		await fs.mkdir(path.join(directory, "outside-dir"));
		await fs.writeFile(path.join(directory, "outside-dir", "file"), "outside-secret");
		await fs.symlink(path.join(directory, "outside-dir"), path.join(root, "nested"));
		expect(() => files.read("nested/file")).toThrow("denied");
		expect(() => files.write("nested/file", Buffer.from("tamper"))).toThrow("denied");
		expect(await fs.readFile(path.join(directory, "outside-dir", "file"), "utf8")).toBe("outside-secret");
	});
	test("concurrent parent symlink swaps cannot redirect native reads or writes", async () => {
		const { directory, root, files } = await fixture();
		const outside = path.join(directory, "outside-dir");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "file"), "outside-secret");
		files.mkdir("nested"); files.write("nested/file", Buffer.from("inside"));
		const control = new SharedArrayBuffer(8);
		const state = new Int32Array(control);
		const worker = new Worker(new URL("./fixtures/sandbox-parent-racer.ts", import.meta.url), { workerData: { root, outside, control } });
		const exited = once(worker, "exit");
		try {
			await once(worker, "message");
			for (let index = 0; index < 2000; index++) {
				try { expect(["inside", "safe-update"]).toContain(files.read("nested/file").toString()); }
				catch (error) { expect(String(error)).toContain("Sandbox file access denied"); }
				try { files.write("nested/file", Buffer.from("safe-update")); }
				catch (error) { expect(String(error)).toContain("Sandbox file access denied"); }
			}
		} finally { Atomics.store(state, 0, 1); await exited; }
		expect(Atomics.load(state, 1)).toBeGreaterThan(0);
		expect(await fs.readFile(path.join(outside, "file"), "utf8")).toBe("outside-secret");
	});
	test("byte limits and disposed handles fail closed", async () => {
		const { files } = await fixture();
		expect(() => files.write("large", Buffer.alloc(1024 * 1024 + 1))).toThrow("denied");
		files.write("small", Buffer.from("hello"));
		expect(() => files.read("small", 4)).toThrow("denied");
		files.close();
		expect(() => files.read("small")).toThrow("denied");
	});
	test("tool denials carry an error flag without host paths or stacks", async () => {
		const { files } = await fixture();
		const tools = sandboxTools(files);
		const context = {} as ExtensionContext;
		const result = await tools[0]!.execute("denied", { path: "/etc/passwd" }, undefined, undefined, context);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Sandbox file access denied" }]);
		expect(SANDBOX_SYSTEM_PROMPT).not.toContain(os.homedir());
		expect(SANDBOX_SYSTEM_PROMPT).not.toContain(process.cwd());
	});
});

test("broad roots are refused before native access", async () => {
	await expect(openSandboxFs({ root: path.parse(process.cwd()).root })).rejects.toThrow("cannot be");
	await expect(openSandboxFs({ root: os.homedir() })).rejects.toThrow("cannot be");
	await expect(openSandboxFs({ root: "relative" })).rejects.toThrow("absolute");
});
