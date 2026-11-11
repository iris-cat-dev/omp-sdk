import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { TempDir } from "@oh-my-pi/pi-utils";

const packageDir = path.resolve(import.meta.dir, "..");

// Exercise built artifacts in real Node processes, as Desktop does.
for (const artifact of ["node", "node-desktop"]) {
	const entry = path.join(packageDir, "dist", artifact, "rpc.mjs");
	describe.skipIf(!fs.existsSync(entry))(`${artifact} RPC tool policy`, () => {
		test.each([false, true])("idle RPC session durability with noSession=%s", async noSession => {
			using root = TempDir.createSync("@node-rpc-idle-durability-");
			const options = {
				cwd: root.path(), agentDir: root.join("agent"), noSession,
				extraArgs: ["--no-extensions", "--no-lsp", "--no-context-files", "--no-skills", "--no-rules", "--tools", "read"],
			};
			const env = {
				HOME: root.path(), PI_CODING_AGENT_DIR: root.join("agent"), PI_CONFIG_DIR: ".omp", PI_PROFILE: "",
				XDG_DATA_HOME: root.join("data"), XDG_STATE_HOME: root.join("state"), XDG_CACHE_HOME: root.join("cache"),
				OPENAI_API_KEY: "test-no-network",
			};
			using client = new RpcClient({
				command: () => ["node", "--input-type=module", "-e", `import {startNodeRpcHost} from ${JSON.stringify(pathToFileURL(entry).href)};globalThis.fetch=async()=>{throw Error("Idle startup must not call a model");};await startNodeRpcHost(${JSON.stringify(options)});`],
				cwd: root.path(), env,
			});
			await client.start();
			const state = await client.getState();
			expect(await client.getMessages()).toEqual([]);
			await client.stop();
			if (noSession) {
				expect(state.sessionFile).toBeUndefined();
				return;
			}
			if (!state.sessionFile) throw new Error("Durable RPC must publish its session file");
			using resumed = new RpcClient({
				command: () => ["node", "--input-type=module", "-e", `import {startNodeRpcHost} from ${JSON.stringify(pathToFileURL(entry).href)};globalThis.fetch=async()=>{throw Error("Idle resume must not call a model");};await startNodeRpcHost(${JSON.stringify({...options, session: state.sessionFile})});`],
				cwd: root.path(), env,
			});
			await resumed.start();
			expect((await resumed.getState()).sessionId).toBe(state.sessionId);
			expect(await resumed.getMessages()).toEqual([]);
			await resumed.stop();
		}, 30_000);

		test.each([false, true])("session annotations remain outside model messages with noSession=%s", async noSession => {
			using root = TempDir.createSync("@node-rpc-annotation-");
			const options = {
				cwd: root.path(), agentDir: root.join("agent"), noSession,
				extraArgs: ["--no-extensions", "--no-lsp", "--no-context-files", "--no-skills", "--no-rules", "--tools", "read"],
			};
			const env = {
				HOME: root.path(), PI_CODING_AGENT_DIR: root.join("agent"), PI_CONFIG_DIR: ".omp", PI_PROFILE: "",
				XDG_DATA_HOME: root.join("data"), XDG_STATE_HOME: root.join("state"), XDG_CACHE_HOME: root.join("cache"),
				OPENAI_API_KEY: "test-no-network",
			};
			const launch = (session?: string) => new RpcClient({
				command: () => ["node", "--input-type=module", "-e", `import {startNodeRpcHost} from ${JSON.stringify(pathToFileURL(entry).href)};globalThis.fetch=async()=>{throw Error("Session annotations must not call a model");};await startNodeRpcHost(${JSON.stringify({ ...options, session })});`],
				cwd: root.path(), env,
			});
			using client = launch();
			await client.start();
			const before = await client.getEntries();
			await expect(client.appendSessionAnnotation({ customType: "", data: null })).rejects.toThrow("requires customType");
			expect(await client.getEntries()).toEqual(before);
			const data = { clientMessageId: "local-only", text: "/save-local", attachments: [{ type: "text", text: "first line\nsecond line\nthird line" }] };
			const { entryId } = await client.appendSessionAnnotation({ customType: "desktop-local-submission", data });
			const assertAnnotation = async (reader: RpcClient) => {
				const { entries } = await reader.getEntries();
				expect(entries.find(item => item.id === entryId)).toMatchObject({ type: "custom", customType: "desktop-local-submission", data });
				expect(await reader.getMessages()).toEqual([]);
			};
			await assertAnnotation(client);
			const state = await client.getState();
			await client.stop();
			if (noSession) {
				expect(state.sessionFile).toBeUndefined();
				return;
			}
			if (!state.sessionFile) throw new Error("Durable annotation must publish its session file");
			using resumed = launch(state.sessionFile);
			await resumed.start();
			await assertAnnotation(resumed);
			await resumed.stop();
		}, 30_000);

		test("prompt-context reads the native snapshot without starting generation or exposing model configuration", async () => {
			using root = TempDir.createSync("@node-rpc-prompt-context-");
			const options = {
				cwd: root.path(),
				agentDir: root.join("agent"),
				model: "openai/gpt-4o-mini",
				noSession: true,
				extraArgs: [
					"--no-extensions",
					"--no-lsp",
					"--no-context-files",
					"--no-skills",
					"--no-rules",
					"--tools",
					"read",
				],
			};
			using client = new RpcClient({
				command: () => [
					"node",
					"--input-type=module",
					"-e",
					`import { startNodeRpcHost } from ${JSON.stringify(pathToFileURL(entry).href)}; globalThis.fetch = async () => { throw new Error("Prompt inspection must not call a model"); }; await startNodeRpcHost(${JSON.stringify(options)});`,
				],
				cwd: root.path(),
				env: {
					HOME: root.path(),
					PI_CODING_AGENT_DIR: root.join("agent"),
					PI_CONFIG_DIR: ".omp",
					PI_PROFILE: "",
					XDG_DATA_HOME: root.join("data"),
					XDG_STATE_HOME: root.join("state"),
					XDG_CACHE_HOME: root.join("cache"),
					OPENAI_API_KEY: "test-no-network",
				},
			});
			await client.start();
			const beforeMessages = await client.getMessages();
			const beforeStats = await client.getSessionStats();
			const events: string[] = [];
			const unsubscribe = client.onEvent(event => events.push(event.type));
			try {
				const context = await client.getPromptContext();
				expect(context.model).toEqual({ provider: "openai", id: "gpt-4o-mini" });
				expect(Object.keys(context.breakdown).sort()).toEqual(
					[
						"autoCompactBufferTokens",
						"categories",
						"contextWindow",
						"freeTokens",
						"usedTokens",
						...(context.breakdown.thresholdTokens === undefined ? [] : ["thresholdTokens"]),
					].sort(),
				);
				expect(
					context.categories.find(category => category.id === "built-in-tools")?.entries.map(entry => entry.label),
				).toEqual(["read"]);
				const state = await client.getState();
				expect(
					context.categories.find(category => category.id === "system-prompt")?.entries.map(entry => entry.text),
				).toEqual(state.systemPrompt);
				expect(await client.getMessages()).toEqual(beforeMessages);
				expect(await client.getSessionStats()).toEqual(beforeStats);
				expect(
					events.filter(type => ["agent_start", "message_start", "tool_execution_start"].includes(type)),
				).toEqual([]);
			} finally {
				unsubscribe();
			}
		}, 30_000);

		for (const scenario of [
			{ name: "keeps images when an unrelated built-in is disabled", denied: ["ast_edit"], args: [], image: true },
			{ name: "honors an explicit image denial", denied: ["generate_image"], args: [], image: false },
			{
				name: "allows debug in an explicit whitelist",
				denied: [],
				args: ["--tools", "read,debug"],
				image: false,
				debug: true,
			},
			{
				name: "honors an explicit debug denial",
				denied: ["debug"],
				args: ["--tools", "read,debug"],
				image: false,
				debug: false,
			},
			{
				name: "honors the debug setting",
				denied: [],
				args: ["--tools", "read,debug"],
				image: false,
				debug: false,
				debugEnabled: false,
			},
			{
				name: "does not expand an explicit whitelist",
				denied: ["ast_edit"],
				args: ["--tools", "read"],
				image: false,
				debug: false,
			},
			{ name: "does not expand no-tools", denied: ["ast_edit"], args: ["--no-tools"], image: false, debug: false },
		]) {
			test(scenario.name, async () => {
				using root = TempDir.createSync("@node-rpc-tools-");
				const config = root.join("config.yml");
				await Bun.write(
					config,
					`generate_image:\n  enabled: true\ndebug:\n  enabled: ${scenario.debugEnabled ?? true}\n`,
				);
				const options = {
					cwd: root.path(),
					agentDir: root.join("agent"),
					model: "openai/gpt-4o-mini",
					noSession: true,
					configFiles: [config],
					disallowedTools: scenario.denied,
					extraArgs: [
						"--no-extensions",
						"--no-lsp",
						"--no-context-files",
						"--no-skills",
						"--no-rules",
						...scenario.args,
					],
				};
				using client = new RpcClient({
					command: () => [
						"node",
						"--input-type=module",
						"-e",
						`import { startNodeRpcHost } from ${JSON.stringify(pathToFileURL(entry).href)}; await startNodeRpcHost(${JSON.stringify(options)});`,
					],
					cwd: root.path(),
					env: {
						HOME: root.path(),
						PI_CONFIG_DIR: ".omp",
						PI_CODING_AGENT_DIR: root.join("agent"),
						PI_PROFILE: "",
						XDG_DATA_HOME: root.join("data"),
						XDG_STATE_HOME: root.join("state"),
						XDG_CACHE_HOME: root.join("cache"),
						OPENAI_API_KEY: "test-no-network",
					},
				});
				await client.start();
				const state = await client.getState();
				const names = state.dumpTools?.map(tool => tool.name) ?? [];
				expect(names.includes("generate_image")).toBe(scenario.image);
				if (scenario.debug !== undefined) expect(names.includes("debug")).toBe(scenario.debug);
				for (const denied of scenario.denied) expect(names).not.toContain(denied);
			});
		}
	});
}
