import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl, ServiceTier } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

async function request(
	api: "openai-responses" | "openai-completions",
	baseUrl: string,
	serviceTiers?: readonly string[],
	servedTier?: ServiceTier,
) {
	const model = buildModel({
		provider: "custom-api",
		id: "gpt-6.1-sol",
		name: "GPT API",
		api,
		baseUrl,
		serviceTiers,
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 512,
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
	});
	const bodies: Record<string, unknown>[] = [];
	const fetch: FetchImpl = async (_url, init) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const events =
			api === "openai-responses"
				? [
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { type: "message", id: "msg_1", role: "assistant", content: [] },
						},
						{
							type: "response.content_part.added",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "", annotations: [] },
						},
						{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ready" },
						{
							type: "response.completed",
							response: {
								id: "resp_1",
								status: "completed",
								service_tier: servedTier,
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						},
					]
				: [
						{
							id: "chat_1",
							choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }],
						},
						{
							id: "chat_1",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							service_tier: servedTier,
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						},
					];
		return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "ping", timestamp: 0 }],
		},
		{ apiKey: "synthetic-key", serviceTier: "ultrafast", fetch },
	).result();
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ready" })]);
	expect(bodies).toHaveLength(1);
	return { body: bodies[0]!, result };
}

describe("OpenAI API Ultrafast wire contract", () => {
	it.each(["openai-responses", "openai-completions"] as const)(
		"sends Ultrafast through %s for a custom provider using the official API",
		async api => {
			const { body } = await request(api, "https://api.openai.com/v1");
			expect(body.service_tier).toBe("ultrafast");
		},
	);

	it("honors advertised gateway support but does not infer it from a GPT model id", async () => {
		const supported = await request("openai-responses", "https://gateway.test/v1", ["priority", "ultrafast"]);
		expect(supported.body.service_tier).toBe("ultrafast");
		const unknown = await request("openai-responses", "https://gateway.test/v1");
		expect(unknown.body).not.toHaveProperty("service_tier");
		const denied = await request("openai-responses", "https://api.openai.com/v1", []);
		expect(denied.body).not.toHaveProperty("service_tier");
	});

	it.each(["openai-responses", "openai-completions"] as const)(
		"records a confirmed downgrade on %s without treating an omitted echo as confirmed Ultrafast",
		async api => {
			const downgraded = await request(api, "https://api.openai.com/v1", undefined, "default");
			expect(downgraded.body.service_tier).toBe("ultrafast");
			expect(downgraded.result.serviceTier).toBe("default");
			expect(downgraded.result.usage.cost.total).toBeCloseTo(0.000012, 12);
			const unknown = await request(api, "https://api.openai.com/v1");
			expect(unknown.result.serviceTier).toBeUndefined();
		},
	);
});
