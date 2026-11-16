import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real persistent session and RPC dispatch; only provider responses are scripted.
const root = process.argv[2];
if (!root || root.startsWith("-")) throw new Error("session-title-rpc-agent: expected the test root");
process.chdir(root);
delete process.env.PI_NO_TITLE;
globalThis.fetch = Object.assign(
	async (): Promise<Response> => {
		throw new Error("Title regression fixture must not make network requests");
	},
	{
		preconnect: (): never => {
			throw new Error("Title regression fixture must not preconnect to the network");
		},
	},
);
const sessionDir = path.join(root, "sessions");
const saved = process.argv[4];
const sessionManager = saved && !saved.startsWith("-")
	? await SessionManager.open(saved, sessionDir, undefined, { throwIfMissing: true })
	: SessionManager.create(root, sessionDir);
const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled test model");
const main = createMockModel({ handler: { content: ["Reading the park tests first."] } });
const title = createMockModel({
	handler: { content: ['<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>'] },
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model, systemPrompt: ["Test"], tools: [] },
	streamFn: main.stream,
});
// Mirror SDK startup: loading the journal also requires restoring the agent's transcript.
agent.replaceMessages(sessionManager.buildSessionContext().messages);
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"title.icons": "emoji",
		modelRoles: { tiny: `${model.provider}/${model.id}` },
	}),
	modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
	sideStreamFn: title.stream,
	...(process.argv[3] === "auto" ? { autoTitle: true } : {}),
});
await sessionManager.ensureOnDisk();
await runRpcMode(session);
