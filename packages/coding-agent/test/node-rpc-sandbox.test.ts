import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "../src/modes/rpc/rpc-client";
import { TempDir } from "@oh-my-pi/pi-utils";

const configuredEntry = process.env.OMP_SANDBOX_TEST_RPC_ENTRY;
const entry = configuredEntry ? path.resolve(configuredEntry) : "";

async function sandboxModelTransport(filesystem: typeof fs, url: string, options: { body: string }): Promise<Response> {
	const body = JSON.parse(options.body);
	filesystem.writeFileSync(process.env.SANDBOX_REQUEST_CAPTURE!, JSON.stringify(body));
	const now = Math.floor(Date.now() / 1000);
	if (!String(url).includes("/responses")) {
		const chunks = [
			{ id: "chat_sandbox", object: "chat.completion.chunk", created: now, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "SANDBOX_RPC_REPLY" }, finish_reason: null }] },
			{ id: "chat_sandbox", object: "chat.completion.chunk", created: now, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
		];
		return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	}
	const item = { id: "msg_sandbox", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SANDBOX_RPC_REPLY", annotations: [] }] };
	const response = { id: "resp_sandbox", object: "response", created_at: now, status: "completed", model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
	const events = [
		{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "SANDBOX_RPC_REPLY" },
		{ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: "SANDBOX_RPC_REPLY" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
describe.skipIf(!entry || !fs.existsSync(entry) || process.platform === "win32")("staged Node SDK sandbox RPC admission", () => {
		test("actual catalog and durable resume cannot inherit host tools, ambient prompts or command execution", async () => {
			using temp = TempDir.createSync("@node-rpc-sandbox-");
			const root = temp.join("root"); const agentDir = temp.join("agent");
			fs.mkdirSync(root); fs.mkdirSync(agentDir);
			const captureFile = temp.join("provider-request.json");
			fs.writeFileSync(path.join(root, "AGENTS.md"), "AMBIENT_CONTEXT_SENTINEL");
			fs.mkdirSync(path.join(root, ".omp", "prompts"), { recursive: true });
			fs.writeFileSync(path.join(root, ".omp", "prompts", "ambient.md"), "AMBIENT_PROMPT_SENTINEL");
			const options = {
				cwd: root, agentDir, sandbox: { root }, model: "openai/gpt-4o-mini",
				systemPrompt: "TRUSTED_QQ_PROMPT_SENTINEL {{env.HOME}}",
				desktopPluginPrompts: true,
				extraArgs: ["--tools", "bash,eval,task,read,write", "--append-system-prompt", "UNSAFE_APPEND_SENTINEL"],
			};
			const env = { HOME: temp.path(), PASEO_HOME: temp.join("paseo"), PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: ".omp", PI_PROFILE: "", OPENAI_API_KEY: "test-local-transport-only", SANDBOX_REQUEST_CAPTURE: captureFile, USER: "HOST_IDENTITY_SENTINEL", HOST_PRIVATE_VALUE: "HOST_ENV_SENTINEL", XDG_DATA_HOME: temp.join("data"), XDG_STATE_HOME: temp.join("state"), XDG_CACHE_HOME: temp.join("cache") };
			const launch = (session?: string, sandbox = true) => new RpcClient({
				command: () => ["node", "--input-type=module", "-e", `import * as fs from "node:fs";import { startNodeRpcHost, NODE_RPC_SANDBOX_VERSION } from ${JSON.stringify(pathToFileURL(entry).href)};if(NODE_RPC_SANDBOX_VERSION!==1)throw Error("Sandbox support unavailable");globalThis.fetch=(url,options)=>(${sandboxModelTransport.toString()})(fs,url,options);await startNodeRpcHost(${JSON.stringify({ ...options, session, sandbox: sandbox ? options.sandbox : undefined })});`],
				cwd: root, env,
			});
			using client = launch();
			await client.start();
			const assertBoundary = async (reader: RpcClient) => {
				const state = await reader.getState();
				expect(state.dumpTools?.map(tool => tool.name).sort()).toEqual(["sandbox_list", "sandbox_read", "sandbox_write"]);
				const prompt = state.systemPrompt?.join("\n") ?? "";
				expect(prompt).toContain("TRUSTED_QQ_PROMPT_SENTINEL {{env.HOME}}");
				for (const secret of [root, temp.path(), "AMBIENT_CONTEXT_SENTINEL", "AMBIENT_PROMPT_SENTINEL", "UNSAFE_APPEND_SENTINEL"]) expect(prompt).not.toContain(secret);
				expect(await reader.getAvailableCommands()).toEqual([]);
				await expect(reader.bash("whoami")).rejects.toThrow("Sandbox");
				await expect(reader.setCustomTools([{ name: "host_escape", description: "Must not register", parameters: { type: "object", properties: {} }, async execute() { throw new Error("Forbidden host tool executed"); } }])).rejects.toThrow("Sandbox");
				await expect(reader.appendSessionAnnotation({ customType: "sandbox-policy", data: { root: "/outside" } })).rejects.toThrow("SDK-owned");
				return state;
			};
			const assertProviderBoundary = async (reader: RpcClient, message: string) => {
				await reader.promptAndWait(message);
				expect(JSON.stringify(await reader.getMessages())).toContain("SANDBOX_RPC_REPLY");
				const captured = fs.readFileSync(captureFile, "utf8");
				expect(captured).toContain("TRUSTED_QQ_PROMPT_SENTINEL {{env.HOME}}");
				expect(captured).toContain(message);
				for (const secret of [root, temp.path(), process.cwd(), "AMBIENT_CONTEXT_SENTINEL", "AMBIENT_PROMPT_SENTINEL", "UNSAFE_APPEND_SENTINEL", "HOST_IDENTITY_SENTINEL", "HOST_ENV_SENTINEL"]) expect(captured).not.toContain(secret);
				const payload = JSON.parse(captured);
				expect(payload.tools.map((tool: { name?: string; function?: { name: string } }) => tool.name ?? tool.function?.name).sort()).toEqual(["sandbox_list", "sandbox_read", "sandbox_write"]);
			};
			const state = await assertBoundary(client);
			if (!state.sessionFile) throw new Error("Sandbox session must be durable");
			await assertProviderBoundary(client, "SANDBOX_FIRST_PROMPT_SENTINEL");
			await client.stop();
			using resumed = launch(state.sessionFile);
			await resumed.start();
			expect((await assertBoundary(resumed)).sessionId).toBe(state.sessionId);
			await assertProviderBoundary(resumed, "SANDBOX_RESUMED_PROMPT_SENTINEL");
			await resumed.stop();
			using unguarded = launch(state.sessionFile, false);
			await expect(unguarded.start()).rejects.toThrow(/sandbox/i);
		}, 30_000);
	});
