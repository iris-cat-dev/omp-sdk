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
		test("public Node SDK registry publishes live and final native shell traces without a model request", async () => {
			using root = TempDir.createSync("@node-sdk-shell-trace-");
			const sdkUrl = pathToFileURL(path.join(packageDir, "dist", artifact, "sdk.mjs")).href;
			const catalogUrl = pathToFileURL(
				path.join(packageDir, "dist", artifact, "modules/oh-my-pi/pi-catalog/_root.mjs"),
			).href;
			const wireUrl = pathToFileURL(
				path.join(packageDir, "dist", artifact, "modules/oh-my-pi/pi-wire/_root.mjs"),
			).href;
			const code = `
				import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } from ${JSON.stringify(sdkUrl)};
				import { getBundledModel } from ${JSON.stringify(catalogUrl)};
				import { isShellTrace } from ${JSON.stringify(wireUrl)};
				globalThis.fetch = async () => { throw new Error("Shell trace smoke must not call a model"); };
				const cwd = ${JSON.stringify(root.path())};
				const authStorage = await discoverAuthStorage(cwd);
				const modelRegistry = new ModelRegistry(authStorage);
				const model = getBundledModel("openai", "gpt-4o-mini");
				if (!model) throw new Error("Missing bundled model metadata");
				const { session } = await createAgentSession({
					cwd, agentDir: cwd, model, modelRegistry, sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({ "bash.autoBackground.enabled": false, "bashInterceptor.enabled": false, "autolearn.enabled": false, "memory.backend": "off" }),
					toolNames: ["bash"], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false,
					skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
					workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				});
				try {
					const bash = session.getToolByName("bash");
					if (!bash) throw new Error("Missing registered bash tool");
					const frames = [];
					const result = await bash.execute("node-trace-smoke", { command: "printf before; sleep 0.25; printf after", timeout: 0 }, undefined, frame => frames.push(frame));
					const trace = result.details?.trace;
					if (!isShellTrace(trace) || trace.status !== 0) throw new Error("Invalid final native trace");
					if (!frames.some(frame => isShellTrace(frame.details?.trace) && frame.details.trace.units.some(unit => unit.nodes.some(node => node.state === "running")))) throw new Error("Missing live native execution");
					process.stdout.write(JSON.stringify({ output: result.content.find(block => block.type === "text")?.text, finalStatus: trace.status, live: frames.length, journal: trace.history?.length }));
				} finally { await session.dispose(); authStorage.close(); }
			`;
			const child = Bun.spawn(["node", "--input-type=module", "-e", code], {
				cwd: root.path(),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: root.path(),
					PI_CODING_AGENT_DIR: root.join("agent"),
					PI_CONFIG_DIR: ".omp",
					PI_PROFILE: "",
				},
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const observed = JSON.parse(stdout) as { output: string; finalStatus: number; live: number; journal: number };
			expect(observed.output).toContain("beforeafter");
			expect(observed.finalStatus).toBe(0);
			expect(observed.live).toBeGreaterThan(0);
			expect(observed.journal).toBeGreaterThan(0);
		}, 30_000);

		test("bash runs git worktree add natively under Node SDK instead of dispatching host.mjs worktree", async () => {
			using root = TempDir.createSync("@node-sdk-git-worktree-");
			const repoDir = root.join("repo");
			const wtDir = root.join("wt");
			fs.mkdirSync(repoDir, { recursive: true });
			const runGit = (args: string[], cwd = repoDir) => {
				const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
				expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
				return new TextDecoder().decode(proc.stdout).trim();
			};
			runGit(["init"]);
			runGit(["config", "user.email", "test@example.com"]);
			runGit(["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
			runGit(["add", "README.md"]);
			runGit(["commit", "-m", "initial"]);
			const headSha = runGit(["rev-parse", "HEAD"]);

			const sdkUrl = pathToFileURL(path.join(packageDir, "dist", artifact, "sdk.mjs")).href;
			const catalogUrl = pathToFileURL(
				path.join(packageDir, "dist", artifact, "modules/oh-my-pi/pi-catalog/_root.mjs"),
			).href;
			const code = `
				import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } from ${JSON.stringify(sdkUrl)};
				import { getBundledModel } from ${JSON.stringify(catalogUrl)};
				globalThis.fetch = async () => { throw new Error("Worktree smoke must not call a model"); };
				const cwd = ${JSON.stringify(repoDir)};
				const agentDir = ${JSON.stringify(root.join("agent"))};
				const authStorage = await discoverAuthStorage(cwd);
				const modelRegistry = new ModelRegistry(authStorage);
				const model = getBundledModel("openai", "gpt-4o-mini");
				if (!model) throw new Error("Missing bundled model metadata");
				const { session } = await createAgentSession({
					cwd, agentDir, model, modelRegistry, sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({ "bash.autoBackground.enabled": false, "bashInterceptor.enabled": false, "autolearn.enabled": false, "memory.backend": "off" }),
					toolNames: ["bash"], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false,
					skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
					workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				});
				try {
					const bash = session.getToolByName("bash");
					if (!bash) throw new Error("Missing registered bash tool");
					const result = await bash.execute("node-worktree-add", { command: "git worktree add --detach ../wt HEAD", timeout: 30 });
					process.stdout.write(JSON.stringify({
						exitCode: result.details?.exitCode ?? 0,
						text: result.content.find(block => block.type === "text")?.text ?? "",
					}));
				} finally { await session.dispose(); authStorage.close(); }
			`;
			const child = Bun.spawn(["node", "--input-type=module", "-e", code], {
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: root.path(),
					PI_CODING_AGENT_DIR: root.join("agent"),
					PI_CONFIG_DIR: ".omp",
					PI_PROFILE: "",
				},
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const observed = JSON.parse(stdout) as { exitCode: number; text: string };
			expect(observed.exitCode, observed.text).toBe(0);
			expect(observed.text).not.toContain("Unknown Node SDK worker selector");
			expect(fs.existsSync(path.join(wtDir, "README.md"))).toBe(true);
			expect(runGit(["rev-parse", "HEAD"], wtDir)).toBe(headSha);
		}, 30_000);

		test.each([false, true])(
			"idle RPC session durability with noSession=%s",
			async noSession => {
				using root = TempDir.createSync("@node-rpc-idle-durability-");
				const options = {
					cwd: root.path(),
					agentDir: root.join("agent"),
					noSession,
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
				const env = {
					HOME: root.path(),
					PI_CODING_AGENT_DIR: root.join("agent"),
					PI_CONFIG_DIR: ".omp",
					PI_PROFILE: "",
					XDG_DATA_HOME: root.join("data"),
					XDG_STATE_HOME: root.join("state"),
					XDG_CACHE_HOME: root.join("cache"),
					OPENAI_API_KEY: "test-no-network",
				};
				using client = new RpcClient({
					command: () => [
						"node",
						"--input-type=module",
						"-e",
						`import {startNodeRpcHost} from ${JSON.stringify(pathToFileURL(entry).href)};globalThis.fetch=async()=>{throw Error("Idle startup must not call a model");};await startNodeRpcHost(${JSON.stringify(options)});`,
					],
					cwd: root.path(),
					env,
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
					command: () => [
						"node",
						"--input-type=module",
						"-e",
						`import {startNodeRpcHost} from ${JSON.stringify(pathToFileURL(entry).href)};globalThis.fetch=async()=>{throw Error("Idle resume must not call a model");};await startNodeRpcHost(${JSON.stringify({ ...options, session: state.sessionFile })});`,
					],
					cwd: root.path(),
					env,
				});
				await resumed.start();
				expect((await resumed.getState()).sessionId).toBe(state.sessionId);
				expect(await resumed.getMessages()).toEqual([]);
				await resumed.stop();
			},
			30_000,
		);

		test.each([false, true])(
			"session annotations remain outside model messages with noSession=%s",
			async noSession => {
				using root = TempDir.createSync("@node-rpc-annotation-");
				const options = {
					cwd: root.path(),
					agentDir: root.join("agent"),
					noSession,
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
				const env = {
					HOME: root.path(),
					PI_CODING_AGENT_DIR: root.join("agent"),
					PI_CONFIG_DIR: ".omp",
					PI_PROFILE: "",
					XDG_DATA_HOME: root.join("data"),
					XDG_STATE_HOME: root.join("state"),
					XDG_CACHE_HOME: root.join("cache"),
					OPENAI_API_KEY: "test-no-network",
				};
				const launch = (session?: string) =>
					new RpcClient({
						command: () => [
							"node",
							"--input-type=module",
							"-e",
							`import {startNodeRpcHost} from ${JSON.stringify(pathToFileURL(entry).href)};globalThis.fetch=async()=>{throw Error("Session annotations must not call a model");};await startNodeRpcHost(${JSON.stringify({ ...options, session })});`,
						],
						cwd: root.path(),
						env,
					});
				using client = launch();
				await client.start();
				const before = await client.getEntries();
				await expect(client.appendSessionAnnotation({ customType: "", data: null })).rejects.toThrow(
					"requires customType",
				);
				expect(await client.getEntries()).toEqual(before);
				const data = {
					clientMessageId: "local-only",
					text: "/save-local",
					attachments: [{ type: "text", text: "first line\nsecond line\nthird line" }],
				};
				const { entryId } = await client.appendSessionAnnotation({ customType: "desktop-local-submission", data });
				const assertAnnotation = async (reader: RpcClient) => {
					const { entries } = await reader.getEntries();
					expect(entries.find(item => item.id === entryId)).toMatchObject({
						type: "custom",
						customType: "desktop-local-submission",
						data,
					});
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
			},
			30_000,
		);

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

		test("set_active_tools restricts to read/glob/grep, blocks host-tool leak, and restores full presentation", async () => {
			using root = TempDir.createSync("@node-rpc-set-active-tools-");
			const options = {
				cwd: root.path(),
				agentDir: root.join("agent"),
				model: "openai/gpt-4o-mini",
				noSession: true,
				extraArgs: ["--no-extensions", "--no-lsp", "--no-context-files", "--no-skills", "--no-rules"],
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
			const makeHostTool = (name: string) => ({
				name,
				description: `Host tool ${name}`,
				loadMode: "essential" as const,
				parameters: { type: "object", properties: {}, additionalProperties: false },
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
			});
			await client.setCustomTools([makeHostTool("host_ping")]);
			const initialNames = (await client.getState()).dumpTools?.map(tool => tool.name) ?? [];
			expect(initialNames).toEqual(
				expect.arrayContaining(["read", "glob", "grep", "bash", "edit", "write", "host_ping"]),
			);

			const restricted = await client.setActiveTools(["read", "glob", "grep"]);
			expect(restricted).toEqual(["read", "glob", "grep"]);
			const restrictedDump = (await client.getState()).dumpTools?.map(tool => tool.name) ?? [];
			expect(restrictedDump).toEqual(["read", "glob", "grep"]);

			// Refreshing host tools while restricted must not leak them into the active toolset.
			await client.setCustomTools([makeHostTool("host_pong")]);
			const stillRestricted = (await client.getState()).dumpTools?.map(tool => tool.name) ?? [];
			expect(stillRestricted).toEqual(["read", "glob", "grep"]);

			// Restoring null brings back built-ins and the latest host tools.
			const restored = await client.setActiveTools(null);
			expect(restored).toEqual(
				expect.arrayContaining(["read", "glob", "grep", "bash", "edit", "write", "host_pong"]),
			);
			expect(restored).not.toContain("host_ping");
			const restoredDump = (await client.getState()).dumpTools?.map(tool => tool.name) ?? [];
			expect(restoredDump).toEqual(
				expect.arrayContaining(["read", "glob", "grep", "bash", "edit", "write", "host_pong"]),
			);
		}, 30_000);
	});
}
