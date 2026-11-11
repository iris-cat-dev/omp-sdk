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
});
