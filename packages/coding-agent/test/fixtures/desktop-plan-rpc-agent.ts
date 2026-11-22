import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const resume = Bun.env.DESKTOP_PLAN_SESSION;
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	authStorage,
	modelRegistry,
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	sessionManager: resume ? await SessionManager.open(resume) : SessionManager.create(cwd),
	settings: Settings.isolated({
		"tools.approvalMode": "yolo",
		"compaction.enabled": false,
		"memory.backend": "off",
		"autolearn.enabled": false,
	}),
	toolNames: ["read", "write", "edit", "bash"],
	disableExtensionDiscovery: true,
	enableMCP: false,
	enableLsp: false,
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
});
await session.sessionManager.ensureOnDisk();
if (Bun.env.DESKTOP_PLAN_FAIL_START === "1") {
	// Keep loading the saved model viable, but fail its execution preflight before agent_start.
	modelRegistry.getApiKey = async () => undefined;
}

const write = (id: string, path: string, content: string) => ({
	type: "toolCall" as const,
	name: "write",
	id,
	arguments: { path, content },
});
let draftCalls = 0;
session.agent.streamFn = createMockModel({
	handler: context => {
		const planning = session.getPlanModeState()?.enabled;
		if (!planning) {
			const latest = JSON.stringify(context.messages.at(-1));
			const hadPlanningDirective = context.messages.some(message => JSON.stringify(message).includes("Plan mode active."));
			return {
				content: [
					latest.includes("original & <markup>") && !hadPlanningDirective
						? "Executed original snapshot."
						: "Wrong snapshot or planning instructions.",
				],
			};
		}
		const call = draftCalls++;
		if (call % 2 === 0) {
			return {
				content: [
					"The discussion stays outside the plan.",
					write(`workspace-${call}`, "workspace.txt", "must not write"),
					write(
						`draft-${call}`,
						"local://sample-plan.md",
						call === 0 ? "# Draft\n\noriginal & <markup>\n" : "# Updated\n\nRevised steps.\n",
					),
				],
			};
		}
		return { content: [write(`propose-${call}`, "xd://propose", "sample")] };
	},
}).stream;
await runRpcMode(session, { desktopPlanMode: Bun.env.DESKTOP_PLAN_DISABLED !== "1" });
