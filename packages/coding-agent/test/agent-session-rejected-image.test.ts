import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const rejection =
	"400 input[510].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of following formats: webp, png, jpeg, and gif. (type=invalid_request_error param=invalid_request_error)";
const png = (): ImageContent => ({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		timestamp: Date.now(),
		stopReason: errorMessage ? "error" : "toolUse",
		errorMessage,
	};
}
function imageCount(context: Context): number {
	return context.messages.reduce(
		(count, message) =>
			count +
			(typeof message.content === "string" ? 0 : message.content.filter(part => part.type === "image").length),
		0,
	);
}
function seedImages(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "keep user text" }, png()], timestamp: 1 });
	manager.appendMessage({ role: "user", content: [png()], timestamp: 2 });
	manager.appendMessage({
		...assistant(),
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "image.png" } }],
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		content: [{ type: "text", text: "keep tool output" }, png()],
		details: { images: [png()], retained: "metadata" },
		isError: false,
		timestamp: 3,
	});
	manager.appendCustomMessageEntry("skill-prompt", [{ type: "text", text: "keep skill text" }, png()], true, {
		name: "review",
	});
	manager.appendMessage({
		role: "bashExecution",
		command: "image-command",
		output: "keep bash output",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		images: [png()],
		timestamp: 4,
	});
	manager.appendMessage({
		role: "fileMention",
		files: [{ path: "image.png", content: "keep file text", image: png(), byteSize: 10 }],
		timestamp: 5,
	});
}

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];
const dirs: TempDir[] = [];
beforeAll(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
});
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const dir of dirs.splice(0)) dir.removeSync();
});
afterAll(() => authStorage.close());
function createHarness(manager: SessionManager, handler: MockHandler) {
	const mock = createMockModel({ handler });
	mock.input.push("image");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": true,
		"retry.maxRetries": 2,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry,
		toolRegistry: new Map(),
	});
	sessions.push(session);
	const warnings: string[] = [];
	const retries: string[] = [];
	const ends: boolean[] = [];
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "image-input-recovery") warnings.push(event.message);
		if (event.type === "auto_retry_start") retries.push(event.type);
		if (event.type === "agent_end") ends.push(event.isTerminal === true);
	});
	return { session, mock, warnings, retries, ends };
}
function persistedMessages(manager: SessionManager): AgentMessage[] {
	return manager.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}
function expectKeptHistory(manager: SessionManager): void {
	const messages = persistedMessages(manager);
	const serialized = JSON.stringify(manager.getBranch());
	for (const text of [
		"keep user text",
		"keep tool output",
		"keep skill text",
		"keep bash output",
		"keep file text",
		"metadata",
	]) {
		expect(serialized).toContain(text);
	}
	expect(serialized).not.toContain('"type":"image"');
	expect(
		messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("[image removed]")),
	).toBe(true);
	expect(
		messages.some(
			message =>
				message.role === "assistant" &&
				message.content.some(part => part.type === "toolCall" && part.id === "read-1"),
		),
	).toBe(true);
	expect(messages.some(message => message.role === "toolResult" && message.toolCallId === "read-1")).toBe(true);
}

describe("rejected image input recovery", () => {
	it("settles once, retains text/tool pairing, and never replays rejected images after the next prompt or restart", async () => {
		const dir = TempDir.createSync("@rejected-image-");
		dirs.push(dir);
		const manager = SessionManager.create(dir.path(), dir.path());
		seedImages(manager);
		const sentImages: number[] = [];
		const harness = createHarness(manager, context => {
			const count = imageCount(context);
			sentImages.push(count);
			// Before the fix every follow-up sees the same rejected history and fails.
			return count
				? { content: [], stopReason: "error", errorMessage: rejection }
				: { content: ["text request succeeded"] };
		});
		await harness.session.prompt("use the attached history");
		await harness.session.waitForIdle();
		expect(sentImages).toHaveLength(1);
		expect(sentImages[0]).toBeGreaterThan(0);
		expect(harness.retries).toEqual([]);
		expect(harness.ends).toEqual([true]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.session.getLastAssistantMessage()?.errorMessage).toBe(rejection);
		expectKeptHistory(manager);
		await harness.session.prompt("a following text request");
		await harness.session.waitForIdle();
		expect(sentImages).toHaveLength(2);
		expect(sentImages[1]).toBe(0);
		expect(harness.session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(harness.warnings).toHaveLength(1);
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session");
		await harness.session.dispose();
		const reopened = await SessionManager.open(file, dir.path());
		expectKeptHistory(reopened);
		const laterImages: number[] = [];
		const resumed = createHarness(reopened, context => {
			laterImages.push(imageCount(context));
			return { content: ["resumed successfully"] };
		});
		await resumed.session.resume();
		await resumed.session.waitForIdle();
		expect(laterImages).toEqual([0]);
		await resumed.session.promptCustomMessage({
			customType: "skill-prompt",
			content: [{ type: "text", text: "a healthy later image" }, png()],
			display: true,
			attribution: "user",
			details: { name: "review" },
		});
		await resumed.session.waitForIdle();
		expect(laterImages).toEqual([0, 1]);
		expect(resumed.warnings).toEqual([]);
	});

	it("recovers a file-backed image-count HTTP 413 without retrying or poisoning the next text request", async () => {
		const dir = TempDir.createSync("@image-count-rejection-");
		dirs.push(dir);
		const initial = SessionManager.create(dir.path(), dir.path());
		seedImages(initial);
		await initial.flush();
		const file = initial.getSessionFile();
		if (!file) throw new Error("expected a persisted session");
		await initial.close();
		const manager = await SessionManager.open(file, dir.path());
		const sentImages: number[] = [];
		const countError = "413 request_too_large: image count exceeds the limit of 2";
		const harness = createHarness(manager, context => {
			const count = imageCount(context);
			sentImages.push(count);
			return count
				? { content: [], stopReason: "error", errorMessage: countError }
				: { content: ["text request succeeded"] };
		});
		await harness.session.prompt("use these images");
		await harness.session.waitForIdle();
		expect(sentImages).toHaveLength(1);
		expect(harness.retries).toEqual([]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.session.getLastAssistantMessage()?.errorMessage).toBe(countError);
		expectKeptHistory(manager);
		await harness.session.prompt("continue with text");
		await harness.session.waitForIdle();
		expect(sentImages).toHaveLength(2);
		expect(sentImages[1]).toBe(0);
		expect(harness.session.getLastAssistantMessage()?.stopReason).toBe("stop");
		await harness.session.dispose();
		const reopened = await SessionManager.open(file, dir.path());
		expectKeptHistory(reopened);
		await reopened.close();
	});

	for (const entryPoint of ["prompt", "resume"] as const) {
		it(`cleans an old stuck session durably before ${entryPoint}, even with compaction disabled`, async () => {
			const dir = TempDir.createSync("@old-rejected-image-");
			dirs.push(dir);
			const old = SessionManager.create(dir.path(), dir.path());
			seedImages(old);
			old.appendMessage(assistant(rejection));
			await old.flush();
			const file = old.getSessionFile();
			if (!file) throw new Error("expected a persisted session");
			await old.close();
			const reopened = await SessionManager.open(file, dir.path());
			const sentImages: number[] = [];
			const harness = createHarness(reopened, context => {
				sentImages.push(imageCount(context));
				return { content: ["recovered"] };
			});
			if (entryPoint === "prompt") await harness.session.prompt("continue with text", { skipCompactionCheck: true });
			else await harness.session.resume();
			await harness.session.waitForIdle();
			expect(sentImages).toEqual([0]);
			expect(harness.warnings).toHaveLength(1);
			expectKeptHistory(reopened);
			await harness.session.dispose();
			const persisted = await SessionManager.open(file, dir.path());
			expectKeptHistory(persisted);
			await persisted.close();
		});
	}

	it("sends a healthy image attached after an old rejection without removing it during preprompt cleanup", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: [png()], timestamp: 1 });
		manager.appendMessage(assistant(rejection));
		manager.appendCustomMessageEntry("skill-prompt", [{ type: "text", text: "new image" }, png()], true, {
			name: "review",
		});
		const sentImages: number[] = [];
		const harness = createHarness(manager, context => {
			sentImages.push(imageCount(context));
			return { content: ["healthy new image accepted"] };
		});
		await harness.session.prompt("use the new image", { skipCompactionCheck: true });
		await harness.session.waitForIdle();
		expect(sentImages).toEqual([1]);
		expect(harness.warnings).toHaveLength(1);
		expect(persistedMessages(manager).find(message => message.role === "user")?.content).toEqual([
			{ type: "text", text: "[image removed]" },
		]);
	});

	it("does not warn or retry a repeated rejection when history has no images", async () => {
		const harness = createHarness(SessionManager.inMemory(), {
			content: [],
			stopReason: "error",
			errorMessage: rejection,
		});
		await harness.session.prompt("text only");
		await harness.session.waitForIdle();
		expect(harness.mock.calls).toHaveLength(1);
		expect(harness.warnings).toEqual([]);
		expect(harness.retries).toEqual([]);
	});

	it("keeps images on an unrelated terminal HTTP 400", async () => {
		const manager = SessionManager.inMemory();
		seedImages(manager);
		const harness = createHarness(manager, {
			content: [],
			stopReason: "error",
			errorMessage: "400 invalid tool schema",
		});
		await harness.session.prompt("unrelated failure");
		await harness.session.waitForIdle();
		expect(JSON.stringify(manager.getBranch())).toContain('"type":"image"');
		expect(harness.warnings).toEqual([]);
	});

	it("recognizes explicit input format/decode failures but excludes auth, rate limits, and generation errors", () => {
		for (const text of [
			rejection,
			"Invalid image data",
			"422 Unsupported image format",
			"400 Failed to decode image",
			"Image input is invalid",
			"Image format is not supported",
			"400 invalid image dimensions",
			"HTTP 413 image is too large",
			"400 input[401].image[0]: You have uploaded an unsupported image.",
		])
			expect(AIError.isRejectedImageInput(assistant(text))).toBe(true);
		for (const text of [
			"400 invalid request",
			"401 invalid image data",
			"429 unsupported image format",
			"503 failed to decode image",
			"400 image generation failed: invalid image format",
			"400 image quota exceeded",
			"400 unsupported image model",
			"413 Request payload too large",
			"Request failed with status code 503: invalid image data",
			"Error Code: 401 invalid image data",
			'{"status_code":429,"message":"invalid image data"}',
			"400 Unsupported image input for this model",
			"Invalid image input: service unavailable",
			"Invalid image input: permission denied",
		])
			expect(AIError.isRejectedImageInput(assistant(text))).toBe(false);
		expect(AIError.isRejectedImageInput({ ...assistant("invalid image data"), errorStatus: 401 })).toBe(false);
		expect(AIError.isRejectedImageInput({ ...assistant("invalid image data"), errorStatus: 400 })).toBe(true);
		expect(AIError.isRejectedImageInput({ ...assistant("invalid image data"), stopReason: "stop" })).toBe(false);
	});
});
