import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const names = ["sandbox_list", "sandbox_read", "sandbox_write"];
async function fixture() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sdk-sandbox-")));
	const root = path.join(directory, "root"); const agentDir = path.join(directory, "agent");
	await fs.mkdir(root); await fs.mkdir(agentDir);
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("openai", "test-model-selection-no-network");
	const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Missing bundled test model");
	cleanups.push(async () => { authStorage.close(); await fs.rm(directory, { recursive: true, force: true }); });
	const options: CreateAgentSessionOptions = {
		cwd: root, agentDir, sandbox: { root }, authStorage, modelRegistry, model,
		settings: Settings.isolated({ "memory.backend": "off" }),
		sessionManager: SessionManager.inMemory(root),
		systemPrompt: "TRUSTED_USER_PROMPT_SENTINEL {{env.HOME}}",
	};
	const create = async (overrides: Partial<CreateAgentSessionOptions> = {}) => {
		const { session } = await createAgentSession({ ...options, ...overrides });
		cleanups.push(() => session.dispose()); return session;
	};
	return { directory, root, agentDir, model, options, create };
}
function assertBoundary(session: AgentSession, root: string) {
	expect(session.agent.state.tools.map(tool => tool.name).sort()).toEqual(names);
	expect(session.getAllToolNames().sort()).toEqual(names);
	expect(session.systemPrompt.join("\n")).toContain("TRUSTED_USER_PROMPT_SENTINEL {{env.HOME}}");
	for (const forbidden of [root, os.homedir(), process.cwd(), "HOST_CONTEXT_SENTINEL", "HOST_PROMPT_SENTINEL"]) expect(session.systemPrompt.join("\n")).not.toContain(forbidden);
	expect(() => session.executeBash("whoami")).toThrow("Sandbox");
}

describe.skipIf(process.platform === "win32")("SDK mandatory sandbox lifecycle", () => {
	test("mounts only safe file tools, ignores ambient/provider-extension grants and preserves model selection", async () => {
		const { root, model, create } = await fixture();
		await fs.writeFile(path.join(root, "AGENTS.md"), "HOST_CONTEXT_SENTINEL");
		await fs.mkdir(path.join(root, ".omp"), { recursive: true });
		await fs.writeFile(path.join(root, ".omp", "config.yml"), "memory:\n  backend: local\n");
		const session = await create({
			toolNames: ["bash", "eval", "task", "browser", "read", "write"], restrictToolNames: false,
			systemPrompt: "TRUSTED_USER_PROMPT_SENTINEL {{env.HOME}}", appendSystemPrompt: "HOST_PROMPT_SENTINEL",
			contextFiles: [{ path: "/outside/AGENTS.md", content: "HOST_CONTEXT_SENTINEL" }],
			extensions: [() => { throw new Error("Sandbox loaded an ambient extension"); }],
			extensionRoots: () => ({ explicit: ["/outside/extension.ts"], mode: "merge", configured: [], configuredLevel: "project" }),
			enableMCP: true, enableLsp: true,
			settings: undefined,
			settingsManager: Promise.resolve(Settings.isolated({ "memory.backend": "off" })),
		});
		assertBoundary(session, root);
		expect(session.model?.id).toBe(model.id);
		for (const forbidden of ["bash", "eval", "task", "read", "toString", "constructor", "xd://sandbox_read"]) {
			expect(session.getToolByName(forbidden)).toBeUndefined();
			await expect(session.setActiveToolsByName([forbidden])).rejects.toThrow("Sandbox");
		}
		await session.setModel(model);
		assertBoundary(session, root);
		const body = "x".repeat(128 * 1024);
		await fs.writeFile(path.join(root, "large.txt"), body);
		const read = session.getToolByName("sandbox_read");
		if (!read) throw new Error("Expected sandbox reader");
		expect((await read.execute("bounded-read", { path: "large.txt" })).content).toEqual([{ type: "text", text: body }]);
	});
	test("ordinary SDK sessions retain standard tools without requiring a sandbox-capable model path", async () => {
		const { create } = await fixture();
		const session = await create({ sandbox: undefined, toolNames: ["read"], restrictToolNames: true, skipPythonPreflight: true });
		expect(session.sandbox).toBeUndefined();
		expect(session.agent.state.tools.map(tool => tool.name)).toContain("read");
	});
	test("fresh sessions and durable reopen retain the creation-time boundary; widening, root changes and legacy imports fail", async () => {
		const { directory, root, options, create } = await fixture();
		const journalDir = path.join(directory, "journals");
		const session = await create({ sessionManager: SessionManager.create(root, journalDir) });
		assertBoundary(session, root);
		await session.sessionManager.ensureOnDisk(); await session.sessionManager.flush();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected durable sandbox journal");
		await session.dispose();
		const resumed = await create({ sessionManager: await SessionManager.open(sessionFile, journalDir) });
		assertBoundary(resumed, root);
		await expect(resumed.switchSession(sessionFile)).rejects.toThrow("Sandbox");
		await resumed.newSession();
		assertBoundary(resumed, root);
		expect(resumed.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "sandbox-policy")).toBe(true);
		const unguarded = await SessionManager.open(sessionFile, journalDir);
		try { await expect(createAgentSession({ ...options, sandbox: undefined, sessionManager: unguarded })).rejects.toThrow(/sandbox/i); }
		finally { await unguarded.close(); }
		const otherRoot = path.join(directory, "other-root"); await fs.mkdir(otherRoot);
		const changed = await SessionManager.open(sessionFile, journalDir);
		try { await expect(createAgentSession({ ...options, sandbox: { root: otherRoot }, sessionManager: changed })).rejects.toThrow("root does not match"); }
		finally { await changed.close(); }
		const legacy = SessionManager.inMemory(root);
		legacy.appendCustomEntry("legacy", {});
		legacy.appendMessage({ role: "user", content: "Legacy unrestricted transcript", timestamp: Date.now() });
		await expect(createAgentSession({ ...options, sessionManager: legacy })).rejects.toThrow("unrestricted transcript");
		legacy.appendCustomEntry("sandbox-policy", { root });
		await expect(createAgentSession({ ...options, sessionManager: legacy })).rejects.toThrow("unrestricted transcript");
		await legacy.close();
	});
	test("explicit JavaScript survives tool selection and fresh sessions without granting host execution", async () => {
		const { root, create } = await fixture();
		const session = await create({ sandbox: { root, javascript: true } });
		expect(session.agent.state.tools.map(tool => tool.name).sort()).toEqual(["sandbox_js", ...names]);
		await session.setActiveToolsByName(["sandbox_js"]);
		const javascript = session.getToolByName("sandbox_js");
		if (!javascript) throw new Error("Authorized JavaScript is unavailable");
		const result = await javascript.execute("compute", { code: "return {value: [12, 30].reduce((a, b) => a + b, 0), process: typeof process, fetch: typeof fetch};" }, undefined, () => {});
		expect(JSON.parse(result.content.filter(item => item.type === "text").map(item => item.text).join(""))).toEqual({ result: { value: 42, process: "undefined", fetch: "undefined" }, logs: [] });
		await expect(session.setActiveToolsByName(["eval"])).rejects.toThrow("Sandbox");
		await session.newSession();
		await session.setActiveToolsByName(["sandbox_read", "sandbox_js"]);
		const afterReset = session.getToolByName("sandbox_js");
		if (!afterReset) throw new Error("Fresh session lost JavaScript grant");
		const freshResult = await afterReset.execute("fresh-compute", { code: "return 6 * 7;" });
		expect(JSON.parse(freshResult.content.filter(item => item.type === "text").map(item => item.text).join("")).result).toBe(42);
	});
	test("durable capability changes require a new conversation, while unchanged grants resume", async () => {
		const { directory, root, options, create } = await fixture();
		const journalDir = path.join(directory, "capability-journals");
		const sandbox = { root, javascript: true, network: "public" as const };
		const session = await create({ sandbox, sessionManager: SessionManager.create(root, journalDir) });
		await session.sessionManager.ensureOnDisk(); await session.sessionManager.flush();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected capability journal");
		await session.dispose();
		const resumed = await create({ sandbox, sessionManager: await SessionManager.open(sessionFile, journalDir) });
		expect(resumed.agent.state.tools.map(tool => tool.name).sort()).toEqual(["sandbox_fetch", "sandbox_js", ...names]);
		const changed = await SessionManager.open(sessionFile, journalDir);
		try { await expect(createAgentSession({ ...options, sandbox: { root }, sessionManager: changed })).rejects.toThrow("capabilities do not match"); }
		finally { await changed.close(); }
	});
	test("image grant is independent, immutable and durable; ordinary sandbox ignores image host callbacks", async () => {
		const { root, directory, options, create } = await fixture();
		let initialized = 0;
		const sandboxImageSettings = async () => { initialized++; return { prepare: () => { throw new Error("Host image generation is disabled"); }, dispose() {} }; };
		const ordinary = await create({ sandboxImageSettings });
		assertBoundary(ordinary, root); expect(initialized).toBe(0);
		const sandbox = { root, imageGeneration: true };
		const journalDir = path.join(directory, "image-journals");
		const session = await create({ sandbox, sandboxImageSettings, sessionManager: SessionManager.create(root, journalDir) });
		expect(session.getAllToolNames().sort()).toEqual(["generate_image", ...names]);
		expect(session.getToolByName("sandbox_fetch")).toBeUndefined();
		expect(Object.isFrozen(session.sandbox)).toBe(true);
		await expect(session.setActiveToolsByName(["read"])).rejects.toThrow("Sandbox");
		await session.sessionManager.ensureOnDisk(); await session.sessionManager.flush();
		const file = session.sessionFile!; await session.dispose();
		const resumed = await create({ sandbox, sandboxImageSettings, sessionManager: await SessionManager.open(file, journalDir) });
		expect(resumed.getAllToolNames()).toContain("generate_image");
		const changed = await SessionManager.open(file, journalDir);
		try { await expect(createAgentSession({ ...options, sessionManager: changed })).rejects.toThrow("capabilities do not match"); } finally { await changed.close(); }
	});
	test("authorized native image HTTP generation persists real bytes, denies input links and emits no artifacts on failure or cancellation", async () => {
		const { root, directory, create } = await fixture();
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=", "base64");
		let fail = false; let enabled = true; let requests = 0;
		let lastBody: { input_references?: Array<{ url: string }> } = {};
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
			requests++; expect(request.headers.get("authorization")).toBe("Bearer test-image-only");
			lastBody = await request.json() as typeof lastBody;
			if (fail) return new Response("provider failure", { status: 400 });
			return Response.json({ data: [{ b64_json: png.toString("base64") }] });
		} });
		cleanups.push(async () => { await server.stop(true); });
		const session = await create({ sandbox: { root, imageGeneration: true, javascript: true }, sandboxImageSettings: async registry => {
			registry.registerProvider("sandbox-image-test", { baseUrl: `${server.url.origin}/v1`, api: "openai-images", apiKey: "test-image-only", models: [{ id: "gpt-image-1", name: "test", api: "openai-images", kind: "image", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 }] }, "<test>");
			return { prepare: (_id, params) => { if (!enabled) throw new Error("disabled"); return { ...params, model: "sandbox-image-test/gpt-image-1" }; }, dispose() {} };
		} });
		await fs.writeFile(path.join(root, "oversize.txt"), "x".repeat(1024 * 1024 + 1));
		expect((await session.getToolByName("sandbox_read")!.execute("bounded-read", { path: "oversize.txt" })).isError).toBe(true);
		expect((await session.getToolByName("sandbox_js")!.execute("bounded-js-read", { code: "return sandbox.read('oversize.txt');" })).isError).toBe(true);
		const tool = session.getToolByName("generate_image")!;
		const result = await tool.execute("real-bytes", { subject: "A red pixel" });
		const details = result.details as { generatedImagesSource: string; generatedImages: Array<{ path: string; mimeType: string }> };
		expect(details.generatedImagesSource).toBe("omp-sandbox-image");
		expect(details.generatedImages[0]!.mimeType).toBe("image/png");
		expect(await fs.readFile(path.join(root, details.generatedImages[0]!.path))).toEqual(png);
		expect(JSON.stringify(result)).not.toContain(directory); expect(JSON.stringify(result)).not.toContain("test-image-only");
		expect(result.details).not.toHaveProperty("provider"); expect(result.details).not.toHaveProperty("model"); expect(result.details).not.toHaveProperty("imagePaths");
		expect(result.details).toMatchObject({ images: [{ data: png.toString("base64"), mimeType: "image/png" }] });
		await fs.writeFile(path.join(root, "reference.png"), png);
		const edited = await tool.execute("edit-real-bytes", { subject: "Edit pixel", input: [{ path: "reference.png" }] });
		expect(lastBody.input_references?.[0]?.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
		expect(JSON.stringify(edited)).not.toContain(root);
		const outside = path.join(directory, "outside.png"); await fs.writeFile(outside, png);
		await fs.symlink(outside, path.join(root, "symbolic.png")); await fs.link(outside, path.join(root, "hard.png"));
		for (const image of [outside, "../outside.png", "symbolic.png", "hard.png", "https://example.com/image.png"]) await expect(tool.execute("denied-input", { subject: "Edit", input: [{ path: image }] })).rejects.toThrow("access denied");
		await expect(tool.execute("inline", { subject: "Edit", input: [{ data: png.toString("base64"), mime_type: "image/png" }] })).rejects.toThrow();
		await expect(tool.execute("inline-with-path", { subject: "Edit", input: [{ path: "reference.png", data: png.toString("base64") }] })).rejects.toThrow();
		const before = requests; enabled = false;
		await expect(tool.execute("disabled", { subject: "Disabled" })).rejects.toThrow("disabled"); expect(requests).toBe(before);
		enabled = true; fail = true;
		await expect(tool.execute("failed", { subject: "Failed" })).rejects.toThrow("Host image generation failed");
		const controller = new AbortController(); controller.abort();
		await expect(tool.execute("canceled", { subject: "Canceled" }, controller.signal)).rejects.toThrow();
		expect(await fs.readdir(path.join(root, ".qqbot-media/generated"))).toHaveLength(2);
		fail = false;
		const outsideDirectory = path.join(directory, "outside-output"); await fs.mkdir(outsideDirectory);
		await fs.rename(path.join(root, ".qqbot-media/generated"), path.join(directory, "saved-generated"));
		await fs.symlink(outsideDirectory, path.join(root, ".qqbot-media/generated"));
		await expect(tool.execute("linked-output", { subject: "Must stay inside" })).rejects.toThrow("Host image generation failed");
		expect(await fs.readdir(outsideDirectory)).toEqual([]);
	});
});
