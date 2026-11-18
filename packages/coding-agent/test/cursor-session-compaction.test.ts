import { expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ConnectFrameDecoder, frameConnectMessage } from "@oh-my-pi/pi-ai/providers/connect-frame";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	KvServerMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOOL_RESULT = "The tool completed with receipt #3091";
const OLD_HISTORY = "Uncompressed history marker.";
const SUMMARY = "The earlier task established a baseline.";
const ANSWER = "Finished from recorded progress.";

function frame(message: AgentServerMessage["message"]): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message })));
}

function readFrame(toolCallId: string): Buffer {
	return frame({
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, {
			id: 1,
			execId: toolCallId,
			message: { case: "readArgs", value: { path: `/${toolCallId}`, toolCallId } },
		}),
	});
}

function reply(text: string): Buffer {
	return Buffer.concat([
		frame({
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, { message: { case: "textDelta", value: { text } } }),
		}),
		frame({
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: {} } }),
		}),
	]);
}

async function exercise(scenario: "live" | "live-overflow" | "overflow" | "blocked" | "mid-turn-disabled") {
	const server = http2.createServer();
	const sockets = new Set<http2.ServerHttp2Session>();
	const runs: { action: string | undefined; checkpointRetry: boolean; records: string[]; pending: string[] }[] = [];
	const tools: string[] = [];
	const checkpointRoot = Uint8Array.of(0xc0, 0xff, 0xee);
	const makeCheckpoint = (usedTokens: number, pendingToolCalls: string[]) =>
		frame({
			case: "conversationCheckpointUpdate",
			value: create(ConversationStateStructureSchema, {
				rootPromptMessagesJson: [checkpointRoot],
				pendingToolCalls,
				tokenDetails: { usedTokens, maxTokens: 200_000 },
			}),
		});
	const broken = scenario === "overflow" || scenario === "blocked";
	server.on("session", socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
		const decoder = new ConnectFrameDecoder();
		const records: string[] = [];
		let first = false;
		let answeredFirstTool = false;
		let remaining = 0;
		stream.on("data", (chunk: Buffer) => {
			for (const { payload } of decoder.decode(chunk)) {
				const { message } = fromBinary(AgentClientMessageSchema, payload);
				if (message.case === "runRequest") {
					const action = message.value.action?.action.case;
					const checkpointRetry = headers["x-original-request-id"] !== undefined;
					const state = message.value.conversationState;
					first = runs.length === 0;
					stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
					if (!first && action === "userMessageAction" && !checkpointRetry) {
						// The Cursor summarizer uses a separate one-shot request.
						stream.end(reply(SUMMARY));
						continue;
					}
					runs.push({ action, checkpointRetry, records, pending: state?.pendingToolCalls ?? [] });
					if (first) {
						stream.write(Buffer.concat([readFrame("done"), makeCheckpoint(180_000, ["done"])]));
						continue;
					}
					const ids = message.value.conversationState?.rootPromptMessagesJson ?? [];
					remaining = ids.length;
					if (remaining === 0) stream.end(reply(ANSWER));
					else
						stream.write(
							Buffer.concat(
								ids.map((blobId, id) =>
									frame({
										case: "kvServerMessage",
										value: create(KvServerMessageSchema, {
											id,
											message: {
												case: "getBlobArgs",
												value: { blobId },
											},
										}),
									}),
								),
							),
						);
				} else if (message.case === "execClientMessage" && message.value.message.case === "readResult" && first) {
					if (answeredFirstTool) {
						stream.end(Buffer.concat([makeCheckpoint(100_000, []), reply(ANSWER)]));
						continue;
					}
					answeredFirstTool = true;
					if (broken) stream.end(makeCheckpoint(638_742, ["stale"]));
					else
						stream.write(
							Buffer.concat([
								makeCheckpoint(scenario === "live-overflow" ? 638_742 : 180_000, []),
								readFrame("late"),
							]),
						);
				} else if (message.case === "kvClientMessage" && message.value.message.case === "getBlobResult") {
					const data = message.value.message.value.blobData;
					records.push(data ? Buffer.from(data).toString("utf8") : "");
					if (--remaining === 0) stream.end(reply(ANSWER));
				}
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected an HTTP/2 fixture port");

	const dir = TempDir.createSync("@pi-cursor-compaction-");
	const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	let session: AgentSession | undefined;
	try {
		authStorage.keys.setRuntime("cursor", "local-fixture-key");
		const model = buildModel({
			id: "gemini-4-hydrogen-test",
			name: "Cursor fixture",
			provider: "cursor",
			api: "cursor-agent",
			baseUrl: `http://127.0.0.1:${address.port}`,
			input: ["text"],
			reasoning: false,
			contextWindow: 200_000,
			maxTokens: 32_768,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
		const available = vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
		const settings = Settings.isolated({
			"compaction.methodOrder":
				scenario === "blocked" ? ["handoff"] : scenario === "live-overflow" ? ["handoff", "soft"] : ["soft"],
			"compaction.keepRecentTokens": 128,
			"compaction.thresholdTokens": 170_000,
			"compaction.midTurnEnabled": scenario !== "mid-turn-disabled",
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"retry.baseDelayMs": 5,
			"todo.enabled": false,
		});
		const journal = SessionManager.inMemory(dir.path());
		const older = { role: "user" as const, content: OLD_HISTORY.repeat(200), timestamp: Date.now() - 1_000 };
		journal.appendMessage(older);
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], messages: [older] },
			getApiKey: () => "local-fixture-key",
			convertToLlm,
			cursorExecHandlers: {
				async read({ toolCallId }) {
					tools.push(toolCallId);
					return {
						role: "toolResult",
						toolCallId,
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: TOOL_RESULT }],
						timestamp: Date.now(),
					};
				},
			},
		});
		session = new AgentSession({ agent, sessionManager: journal, settings, modelRegistry });
		const reasons: string[] = [];
		const notices: string[] = [];
		let retried = false;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") reasons.push(event.reason);
			if (event.type === "auto_retry_start") retried = true;
			if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
		});
		try {
			await session.prompt("Complete the task after the read");
			await session.waitForIdle();
			return {
				runs,
				tools,
				reasons,
				notices,
				retried,
				entries: journal.getBranch(),
				last: session.getLastAssistantMessage(),
			};
		} finally {
			available.mockRestore();
		}
	} finally {
		await session?.dispose();
		authStorage.close();
		for (const socket of sockets) socket.destroy();
		server.close();
		await dir.remove();
	}
}

it.each([
	["live", "threshold"],
	["live-overflow", "overflow"],
	["overflow", "overflow"],
] as const)(
	"compacts a %s Cursor tool loop before a new request and keeps the completed result",
	async (scenario, reason) => {
		const result = await exercise(scenario);
		expect(result.tools).toEqual(["done"]);
		expect(result.retried).toBe(false);
		expect(result.reasons).toEqual([reason]);
		expect(result.entries.filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(result.runs.map(({ action, checkpointRetry }) => [action, checkpointRetry])).toEqual([
			["userMessageAction", false],
			["resumeAction", false],
		]);
		expect(result.runs[1].pending).toEqual([]);
		const rebuilt = result.runs[1].records.join("\n");
		expect(rebuilt).toContain(SUMMARY);
		expect(rebuilt).toContain(TOOL_RESULT);
		expect(rebuilt).not.toContain(OLD_HISTORY);
		expect(result.last?.content).toContainEqual({ type: "text", text: ANSWER });
	},
);

it("stops on a Cursor overflow with no usable compaction method without losing the tool result", async () => {
	const result = await exercise("blocked");
	expect(result.tools).toEqual(["done"]);
	expect(result.runs).toHaveLength(1);
	expect(result.notices).toContainEqual(expect.stringContaining("Completed tools were kept"));
	expect(result.entries).toContainEqual(
		expect.objectContaining({
			type: "message",
			message: expect.objectContaining({ role: "toolResult", toolCallId: "done" }),
		}),
	);
});

it("does not cut a live Cursor response when mid-turn compaction is disabled", async () => {
	const result = await exercise("mid-turn-disabled");
	expect(result.tools).toEqual(["done", "late"]);
	expect(result.runs).toHaveLength(1);
	expect(result.last?.content).toContainEqual({ type: "text", text: ANSWER });
});
