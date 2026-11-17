import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { getMnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import * as sdkProfile from "@oh-my-pi/pi-coding-agent/sdk-profile";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { LearnTool } from "@oh-my-pi/pi-coding-agent/tools/learn";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

const sessions: AgentSession[] = [];
const dirs: TempDir[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await setMnemopiSessionState(session, undefined)?.dispose({ consolidate: false });
	}
	for (const dir of dirs.splice(0)) await dir.remove();
	mock.restore();
});

describe("Mnemopi readiness", () => {
	it("rejects service configurations that would still require local runtimes or cannot be HTTP APIs", () => {
		spyOn(sdkProfile, "isCoreSdk").mockReturnValue(true);
		for (const overrides of [
			{ "mnemopi.noEmbeddings": true, "mnemopi.llmMode": "smol" },
			{ "mnemopi.embeddingApiUrl": "https://openrouter.ai/api/v1", "mnemopi.llmMode": "none" },
			{
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "remote",
				"mnemopi.llmBaseUrl": "file:///memory",
				"mnemopi.llmModel": "chosen-model",
			},
		]) {
			const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
			expect(() => loadMnemopiConfig(settings, "/unused-memory-agent")).toThrow();
		}
	});
	it("blocks incompatible core startup without tools or outbound requests, recovers explicitly, and preserves saved data across failed reconfiguration", async () => {
		spyOn(sdkProfile, "isCoreSdk").mockReturnValue(true);
		const fetch = spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => {
				throw new Error("This local memory test must not send requests");
			}),
		);
		const dir = TempDir.createSync("@mnemopi-readiness-");
		dirs.push(dir);
		const notices: string[] = [];
		const values = {
			"memory.backend": "mnemopi",
			"autolearn.enabled": true,
			"mnemopi.scoping": "global",
			"mnemopi.dbPath": dir.join("mnemopi.db"),
			"mnemopi.autoRetain": false,
		};
		let currentSettings = Settings.isolated(values);
		const session = {
			sessionId: "memory-readiness",
			get settings() {
				return currentSettings;
			},
			modelRegistry: {
				getApiKeyForProvider: async () => {
					throw new Error("Local memory must not resolve remote credentials");
				},
			},
			sessionManager: { getEntries: () => [], getCwd: () => dir.path() },
			subscribe: () => () => {},
			emitNotice: (_level: string, message: string) => notices.push(message),
			getXdevToolEntries: () => [],
		} as unknown as AgentSession;
		sessions.push(session);
		const tools = {
			settings: session.settings,
			getMnemopiSessionState: () => getMnemopiSessionState(session),
		} as unknown as ToolSession;
		const start = () =>
			mnemopiBackend.start({
				session,
				settings: session.settings,
				modelRegistry: session.modelRegistry,
				agentDir: dir.path(),
				taskDepth: 0,
			});
		const context = { agentDir: dir.path(), cwd: dir.path(), session };
		await start();
		expect(await mnemopiBackend.status!(context)).toMatchObject({
			active: false,
			writable: false,
			searchable: false,
		});
		expect((await mnemopiBackend.status!(context)).error).toBe(notices[0]);
		expect(notices).toHaveLength(1);
		for (const factory of [MemoryRetainTool, MemoryRecallTool, MemoryReflectTool, MemoryEditTool, LearnTool]) {
			expect(factory.createIf(tools)).toBeNull();
		}
		expect(
			await mnemopiBackend.buildDeveloperInstructions(dir.path(), dir.path(), session.settings, session),
		).toBeUndefined();
		expect(
			await mnemopiBackend.save!(context, { content: "Aster observatory uses a copper telescope" }),
		).toMatchObject({ stored: 0 });

		currentSettings = Settings.isolated({ ...values, "mnemopi.noEmbeddings": true, "mnemopi.llmMode": "none" });
		tools.settings = session.settings;
		await start();
		expect((await mnemopiBackend.status!(context)).error).toBeUndefined();
		expect(await mnemopiBackend.status!(context)).toMatchObject({ active: true, writable: true, searchable: true });
		const retained = await MemoryRetainTool.createIf(tools)!.execute("retain", {
			items: [{ content: "Aster observatory uses a copper telescope" }],
		});
		expect(retained.details).toMatchObject({ count: 1 });
		expect(
			(await mnemopiBackend.search!(context, "copper telescope")).items.some(item =>
				item.content.includes("Aster observatory"),
			),
		).toBe(true);
		currentSettings = Settings.isolated({
			...values,
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.dbPath": dir.path(),
		});
		tools.settings = session.settings;
		await start();
		expect(await mnemopiBackend.status!(context)).toMatchObject({ active: false, searchable: false });
		expect(MemoryRecallTool.createIf(tools)).toBeNull();

		currentSettings = Settings.isolated(values);
		tools.settings = session.settings;
		await start();
		expect(await mnemopiBackend.status!(context)).toMatchObject({ active: false, writable: false });
		expect(MemoryRetainTool.createIf(tools)).toBeNull();
		currentSettings = Settings.isolated({ ...values, "mnemopi.noEmbeddings": true, "mnemopi.llmMode": "none" });
		tools.settings = session.settings;
		await start();
		expect(
			(await mnemopiBackend.search!(context, "copper telescope")).items.some(item =>
				item.content.includes("Aster observatory"),
			),
		).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});
});
