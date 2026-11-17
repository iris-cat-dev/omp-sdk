import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { agentLoopContinue } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { isShellTrace } from "@oh-my-pi/pi-wire";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import { AsyncJobManager } from "../src/async";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { stopShellSessions } from "../src/exec/bash-executor";
import { cfgBashAutoBackgroundEnabled, cfgBashAutoBackgroundThresholdMs } from "../src/exec/settings";
import { createTools, type ToolSession } from "../src/tools";

let cwd: string;
let manager: AsyncJobManager;
let settings: Settings;
let tool: AgentTool;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-trace-"));
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd });
	manager = new AsyncJobManager({});
	settings = Settings.isolated({
		"async.enabled": true,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
		"tools.xdev": false,
	});
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		asyncJobManager: manager,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
	};
	const tools = await createTools(session, ["bash"]);
	const bash = tools.find(candidate => candidate.name === "bash");
	if (!bash) throw new Error("Public tool registry did not construct bash");
	tool = bash;
});

afterEach(async () => {
	await manager.dispose();
	await stopShellSessions(cwd);
	resetSettingsForTest();
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("public bash tool execution trace", () => {
	it("returns a real final snapshot without requiring a live-update subscriber", async () => {
		const result = await tool.execute("trace-final", { command: "printf registry-output", timeout: 0 });
		expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining("registry-output") });
		expect(isShellTrace(result.details?.trace)).toBe(true);
		expect(result.details?.trace?.status).toBe(0);
	});

	it("retains trace and output through foreground-to-background takeover and failure", async () => {
		// Isolated settings are runtime overrides; a global write cannot replace them.
		cfgBashAutoBackgroundEnabled.override(settings, true);
		cfgBashAutoBackgroundThresholdMs.override(settings, 120);
		const frames: AgentToolResult<BashToolDetails>[] = [];
		// Real native sleep leaves the command running across the platform's 80ms trace poll and takeover.
		const result = await tool.execute(
			"trace-takeover",
			{ command: "printf start; sleep 0.3; printf end; exit 7", timeout: 0 },
			undefined,
			frame => frames.push(frame),
		);
		expect(result.details?.async?.state).toBe("running");
		expect(isShellTrace(result.details?.trace)).toBe(true);
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("Expected a promoted background job");
		await manager.waitForAll();
		const final = frames.findLast(frame => frame.details?.async?.state === "failed");
		expect(final?.details?.exitCode).toBe(7);
		expect(isShellTrace(final?.details?.trace)).toBe(true);
		expect(final?.details?.trace?.status).toBe(7);
		expect(manager.getJob(jobId)?.latestDetails?.trace).toMatchObject({ status: 7 });
		expect(final?.content.some(block => block.type === "text" && block.text.includes("startend"))).toBe(true);
		expect(
			frames.some(frame =>
				frame.details?.trace?.units.some(unit => unit.nodes.some(node => node.state === "running")),
			),
		).toBe(true);
	});

	it("publishes the true final observation with a cancelled background frame", async () => {
		const running = Promise.withResolvers<void>();
		const frames: AgentToolResult<BashToolDetails>[] = [];
		const result = await tool.execute(
			"trace-background-cancel",
			{ command: "printf ready; sleep 3", async: true, timeout: 0 },
			undefined,
			frame => {
				frames.push(frame);
				const trace: unknown = frame.details?.trace;
				if (isShellTrace(trace) && trace.units.some(unit => unit.nodes.some(node => node.state === "running")))
					running.resolve();
			},
		);
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("Expected a real background job");
		await running.promise;
		manager.cancel(jobId);
		await manager.waitForAll();
		const final = frames.findLast(frame => frame.details?.async?.state === "cancelled");
		expect(final?.details?.cancelled).toBe(true);
		expect(final?.details?.timedOut).toBeUndefined();
		expect(isShellTrace(final?.details?.trace)).toBe(true);
	});

	it("preserves cancellation details in agent-core live and final tool events", async () => {
		const controller = new AbortController();
		// The local model only supplies the post-tool continuation. Bash execution and cancellation are native.
		const model = createMockModel({ responses: [{ content: ["done"] }] });
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "mock",
			provider: "mock",
			model: model.model.id,
			content: [
				{
					type: "toolCall",
					id: "trace-agent-cancel",
					name: "bash",
					arguments: { command: "printf ready; sleep 3", timeout: 0 },
				},
			],
			stopReason: "toolUse",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const context: AgentContext = { systemPrompt: [], messages: [assistant], tools: [tool] };
		const convertToLlm = (messages: AgentMessage[]): Message[] =>
			messages.filter(
				message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			) as Message[];
		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, { model: model.model, convertToLlm }, controller.signal, model.stream);
		for await (const event of stream) {
			events.push(event);
			if (event.type === "tool_execution_update") {
				const trace: unknown = event.partialResult.details?.trace;
				if (isShellTrace(trace) && trace.units.some(unit => unit.nodes.some(node => node.state === "running")))
					controller.abort();
			}
		}
		const live = events.find(
			event => event.type === "tool_execution_update" && isShellTrace(event.partialResult.details?.trace),
		);
		expect(live).toBeDefined();
		const end = events.find(
			event => event.type === "tool_execution_end" && event.toolCallId === "trace-agent-cancel",
		);
		if (!end || end.type !== "tool_execution_end") throw new Error("Missing terminal bash event");
		expect(end.isError).toBe(true);
		expect(end.result.details?.cancelled).toBe(true);
		expect(isShellTrace(end.result.details?.trace)).toBe(true);
		const messages = await stream.result();
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.isError &&
					isShellTrace(
						message.details && typeof message.details === "object" && "trace" in message.details
							? message.details.trace
							: undefined,
					),
			),
		).toBe(true);
	});
});
