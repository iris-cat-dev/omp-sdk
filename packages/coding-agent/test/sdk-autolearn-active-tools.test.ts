import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Guards the auto-learn tool ACTIVATION wiring in createAgentSession: createTools
// force-includes manage_skill into the built registry for an enabled top-level
// session, but an explicit `toolNames` whitelist would otherwise drop it from the
// active set — so the SDK must re-activate it (mirroring the `yield` invariant),
// or the nudge/guidance would point at a tool the model cannot call. No memory
// backend is configured (manage_skill needs only `autolearn.enabled`), so the
// session starts without a heavy backend.
describe("createAgentSession auto-learn tool activation", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	function noDiscoveryOptions() {
		return {
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-autolearn-active-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function activeToolNames(settings: Settings): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["read"],
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	it("activates force-included manage_skill in a restricted top-level session", async () => {
		const names = await activeToolNames(Settings.isolated({ "autolearn.enabled": true }));
		expect(names).toContain("read");
		// Built by createTools' force-include AND activated by the SDK's explicit-list
		// re-inclusion, so guidance/controller point at a callable tool.
		expect(names).toContain("manage_skill");
	});

	it.each([
		{ grant: "default subagent slate", toolNames: undefined, learn: false },
		{ grant: "explicit read-only slate", toolNames: ["read"], learn: false },
		{ grant: "explicit learn permission", toolNames: ["read", "learn"], learn: true },
	])("keeps $grant authorization after inherited Mnemopi initialization", async grant => {
		const settings = Settings.isolated({
			"autolearn.enabled": true,
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRetain": false,
		});
		const common = {
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
		};
		const parent = (
			await createAgentSession({
				...common,
				sessionManager: SessionManager.inMemory(registryDir),
				toolNames: ["read", "recall"],
			})
		).session;
		sessions.push(parent);
		const inherited = parent.getMnemopiSessionState();
		if (!inherited) throw new Error("Expected initialized parent Mnemopi state");
		const child = (
			await createAgentSession({
				...common,
				sessionManager: SessionManager.inMemory(registryDir),
				taskDepth: 1,
				parentMnemopiSessionState: inherited,
				toolNames: grant.toolNames ? [...grant.toolNames] : undefined,
			})
		).session;
		sessions.push(child);
		expect(child.getEnabledToolNames().includes("learn")).toBe(grant.learn);
		expect(child.getToolByName("learn") !== undefined).toBe(grant.learn);
		expect(child.getEnabledToolNames()).not.toContain("manage_skill");
		if (grant.learn) {
			expect(parent.getActiveToolNames()).toContain("learn");
			await parent.getToolByName("learn")!.execute("forced-parent-learn", {
				memory: "The observatory control room keeps a brass compass",
			});
			await child.getToolByName("learn")!.execute("authorized-child-learn", {
				memory: "Check copper telescope alignment before each observatory launch",
			});
			const recalled = await parent
				.getToolByName("recall")!
				.execute("parent-recall", { query: "copper telescope alignment" });
			expect(JSON.stringify(recalled.content)).toContain("observatory launch");
			const parentMemory = await parent
				.getToolByName("recall")!
				.execute("forced-parent-recall", { query: "brass compass" });
			expect(JSON.stringify(parentMemory.content)).toContain("observatory control room");
		}
	});

	it("omits manage_skill from a restricted session when auto-learn is off", async () => {
		const names = await activeToolNames(Settings.isolated({}));
		expect(names).toContain("read");
		expect(names).not.toContain("manage_skill");
	});

	it("activates checkpoint and rewind when only rewind is in an explicit toolNames list", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["rewind"],
			requireYieldTool: true,
		});
		sessions.push(session);
		const names = session.getActiveToolNames();
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});

	it("activates checkpoint and rewind in a restricted session with one-sided toolNames", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["checkpoint"],
			requireYieldTool: true,
			restrictToolNames: true,
		});
		sessions.push(session);
		const names = session.getActiveToolNames();
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});
});
