import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message } from "@oh-my-pi/pi-ai";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { convertMessagesForContextView, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { CURRENT_SESSION_VERSION, type SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getBlobsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const model = getBundledModel("openai", "gpt-4.1")!;
const originalAgentDir = getAgentDir();
const originalEnv = {
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	OMP_PROFILE: process.env.OMP_PROFILE,
	PI_PROFILE: process.env.PI_PROFILE,
};
let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@missing-image-replay-");
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(() => {
	setAgentDir(originalAgentDir);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	tempDir.removeSync();
});

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

async function journal(messages: AgentMessage[]): Promise<string> {
	const entries: SessionMessageEntry[] = messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(index).toISOString(),
		message,
	}));
	const file = path.join(tempDir.path(), "session.jsonl");
	await Bun.write(
		file,
		[
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "missing-images",
				timestamp: new Date(0).toISOString(),
				cwd: tempDir.path(),
			},
			...entries,
		]
			.map(entry => JSON.stringify(entry))
			.join("\n") + "\n",
	);
	return file;
}

async function restoredMessages(file: string, mode: "asynchronous" | "lazy"): Promise<AgentMessage[]> {
	if (mode === "asynchronous") {
		const entries = await loadEntriesFromFile(file);
		await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
		return buildSessionContext(entries.filter(entry => entry.type !== "session")).messages;
	}
	const session = await SessionManager.open(file, tempDir.path(), undefined, { suppressBreadcrumb: true });
	try {
		return session.buildSessionContext().messages;
	} finally {
		await session.close();
	}
}

function providerInput(messages: Message[]): string {
	return JSON.stringify(
		buildResponsesInput({
			model,
			context: { messages },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
			nativeHistory: { replay: true, filterReasoning: false },
		}),
	);
}

describe("missing persisted images in model replay", () => {
	it.each(["asynchronous", "lazy"] as const)(
		"replays missing user, image-only and tool attachments as text after %s restore without changing the journal",
		async mode => {
			const store = new BlobStore(getBlobsDir());
			const healthy = store.putSync(Buffer.from(PNG, "base64"));
			const missingBytes = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=",
				"base64",
			);
			const missing = store.putSync(missingBytes);
			await fs.unlink(missing.path);
			const file = await journal([
				{
					role: "user",
					content: [{ type: "text", text: "Keep my question" }, image(missing.ref), image(healthy.ref)],
					timestamp: 0,
					clientMessageId: "user-identity",
				},
				assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "image.png" } }]),
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					content: [{ type: "text", text: "Keep the tool output" }, image(missing.ref), image(healthy.ref)],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [image(missing.ref)], timestamp: 3, clientMessageId: "image-only-identity" },
			]);
			const durable = await Bun.file(file).text();
			const messages = await restoredMessages(file, mode);
			const converted = convertToLlm(messages);
			const wire = providerInput(converted);
			expect(wire).not.toContain("blob:sha256:");
			expect(wire).toContain("Keep my question");
			expect(wire).toContain("Keep the tool output");
			expect(wire.match(/image unavailable/g)).toHaveLength(3);
			expect(wire.match(/data:image\/png;base64,/g)).toHaveLength(2);
			expect(wire).toContain(PNG);
			expect(messages[0]).toMatchObject({
				clientMessageId: "user-identity",
				content: [
					{ type: "text", text: "Keep my question" },
					{ type: "image", data: missing.ref },
					{ type: "image", data: PNG },
				],
			});
			expect(messages[3]).toMatchObject({
				clientMessageId: "image-only-identity",
				content: [{ type: "image", data: missing.ref }],
			});
			expect(convertMessagesForContextView(messages).map(entry => entry.message)).toEqual(converted);
			expect(await Bun.file(file).text()).toBe(durable);

			store.putSync(missingBytes);
			const recovered = providerInput(convertToLlm(await restoredMessages(file, mode)));
			expect(recovered).not.toContain("image unavailable");
			expect(recovered.match(/data:image\/png;base64,/g)).toHaveLength(5);
			expect(recovered).toContain(missingBytes.toString("base64"));
			expect(await Bun.file(file).text()).toBe(durable);
		},
	);

	it.each(["asynchronous", "lazy"] as const)(
		"removes missing image URLs and generated payload bytes from native replay after %s restore while preserving native history",
		async mode => {
			const store = new BlobStore(getBlobsDir());
			const missing = store.putSync(Buffer.from(`data:image/png;base64,${PNG}`));
			const healthy = store.putSync(Buffer.from(`data:image/png;base64,${PNG}` + "\n"));
			const generated = store.putSync(Buffer.from(PNG, "base64"));
			await fs.unlink(missing.path);
			await fs.unlink(generated.path);
			const nativeItems: Array<Record<string, unknown>> = [
				{
					type: "message",
					id: "native-user",
					role: "user",
					content: [
						{ type: "input_text", text: "Native question" },
						{ type: "input_image", image_url: missing.ref },
						{ type: "input_image", image_url: healthy.ref },
					],
				},
				{ type: "function_call", id: "fc_read", call_id: "native-read", name: "read", arguments: "{}" },
				{
					type: "function_call_output",
					call_id: "native-read",
					output: [
						{ type: "input_text", text: "Native output" },
						{ type: "input_image", image_url: missing.ref },
					],
				},
				{ type: "image_generation_call", id: "ig_missing", result: generated.ref, status: "completed" },
				{
					type: "computer_call_output",
					call_id: "native-computer",
					output: { type: "computer_screenshot", image_url: missing.ref },
				},
				{ type: "reasoning", id: "rs_retained", encrypted_content: "retained-encrypted-reasoning" },
			];
			const file = await journal([
				{
					role: "user",
					content: "Native question",
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: model.provider,
						dt: true,
						items: nativeItems,
					},
					timestamp: 0,
				},
				assistant([{ type: "toolCall", id: "computer-1", name: "computer", arguments: {} }]),
				{
					role: "toolResult",
					toolCallId: "computer-1",
					toolName: "computer",
					content: [{ type: "text", text: "Clicked at 100,200" }],
					providerMetadata: {
						type: "computer",
						screenshot: { type: "computer_screenshot", image_url: missing.ref },
						acknowledgedSafetyChecks: [],
					},
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "Continue", timestamp: 3 },
			]);
			const durable = await Bun.file(file).text();
			const messages = await restoredMessages(file, mode);
			const converted = convertToLlm(messages);
			const wire = providerInput(converted);
			expect(wire).not.toContain("blob:sha256:");
			expect(wire).toContain("Native question");
			expect(wire).toContain("Native output");
			expect(wire).toContain("retained-encrypted-reasoning");
			expect(wire).toContain("native-read");
			expect(wire).toContain("Clicked at 100,200");
			expect(wire).toContain("image unavailable");
			expect(wire).toContain(`data:image/png;base64,${PNG}`);
			expect(converted[2]?.role === "toolResult" && converted[2].providerMetadata).toBeUndefined();
			expect(messages[2]?.role === "toolResult" && messages[2].providerMetadata).toMatchObject({
				screenshot: { image_url: missing.ref },
			});
			expect(await Bun.file(file).text()).toBe(durable);
		},
	);

	it.each(["asynchronous", "lazy"] as const)(
		"surfaces a directory in place of an image blob during %s restore",
		async mode => {
			const store = new BlobStore(getBlobsDir());
			const blob = store.putSync(Buffer.from(PNG, "base64"));
			await fs.unlink(blob.path);
			await fs.mkdir(blob.path);
			const file = await journal([{ role: "user", content: [image(blob.ref)], timestamp: 0 }]);
			const durable = await Bun.file(file).text();
			await expect(restoredMessages(file, mode)).rejects.toThrow(/director|permitted|denied/i);
			expect(await Bun.file(file).text()).toBe(durable);
		},
	);
});
