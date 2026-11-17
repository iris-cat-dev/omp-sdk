import http2 from "node:http2";
import * as net from "node:net";
import { type CursorOptions, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { ProxyPolicyController, setDefaultProxyPolicyController } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function update(message: InteractionUpdate["message"]): Buffer {
	const data = toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
		}),
	);
	const frame = Buffer.alloc(5 + data.length);
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

const originalRequestIds: string[] = [];

function startRunSseServer(status?: number) {
	const streams = new Map<string, PromiseWithResolvers<ReadableStreamDefaultController<Uint8Array>>>();
	const answered = new Set<string>();
	let opens = 0;
	const streamFor = (requestId: string) => {
		let entry = streams.get(requestId);
		if (!entry) {
			entry = Promise.withResolvers();
			streams.set(requestId, entry);
		}
		return entry;
	};
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = new Uint8Array(await request.arrayBuffer());
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				opens++;
				originalRequestIds.push(request.headers.get("x-original-request-id") ?? "");
				if (status !== undefined) return new Response(null, { status });
				const { requestId } = fromBinary(BidiRequestIdSchema, body.subarray(5));
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamFor(requestId).resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				const { requestId } = fromBinary(BidiAppendRequestSchema, body);
				const id = requestId?.requestId ?? "";
				if (!answered.has(id)) {
					answered.add(id);
					const controller = await streamFor(id).promise;
					controller.enqueue(
						update({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "http1 ok" }) }),
					);
					controller.enqueue(update({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) }));
					controller.close();
				}
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
	return {
		server,
		get opens() {
			return opens;
		},
	};
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-h2-unavailable-fixture",
		name: "Cursor h2 unavailable fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const scenario = process.argv[2];
const failed = scenario === "failed" || scenario === "alpn-failed";
const runSse = startRunSseServer(failed ? 403 : undefined);
const secondEndpoint = scenario === "cache" ? startRunSseServer() : undefined;
const sockets = new Set<net.Socket>();
let connections = 0;
let tunnels = 0;
const dropper = net.createServer(socket => {
	sockets.add(socket);
	socket.once("close", () => sockets.delete(socket));
	connections++;
	if (scenario !== "proxy") {
		// A reset on accept can produce a bare read ECONNRESET; wait for the ClientHello.
		socket.once("data", () => socket.destroy());
		return;
	}
	let request = "";
	const onData = (chunk: Buffer) => {
		request += chunk.toString("latin1");
		if (!request.includes("\r\n\r\n")) return;
		socket.off("data", onData);
		tunnels++;
		socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
		socket.once("data", () => socket.destroy());
	};
	socket.on("data", onData);
});
const listening = Promise.withResolvers<void>();
dropper.once("error", listening.reject);
dropper.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = dropper.address();
if (!address || typeof address === "string") throw new Error("expected a TCP port");
const realConnect = http2.connect;
let faultServer: http2.Http2Server | undefined;
let faultAttempts = 0;
let model = makeModel(runSse.server.url.toString());
let fixtureFetch: CursorOptions["fetch"];

if (scenario === "proxy") {
	setDefaultProxyPolicyController(
		new ProxyPolicyController({
			enabled: true,
			providers: { cursor: { mode: "proxy", url: `http://127.0.0.1:${address.port}` } },
		}),
	);
	// A reserved hostname exercises real CONNECT without sending an IP address as TLS SNI.
	model = makeModel("https://cursor-fixture.invalid:8443");
	fixtureFetch = (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		return fetch(new URL(url.pathname, runSse.server.url), { ...init, proxy: "" });
	};
} else {
	setDefaultProxyPolicyController(new ProxyPolicyController({ enabled: false }));
	if (scenario === "non-handshake" || scenario === "alpn-failed") {
		faultServer = http2.createServer();
		const ready = Promise.withResolvers<void>();
		faultServer.listen(0, "127.0.0.1", ready.resolve);
		await ready.promise;
		const faultAddress = faultServer.address();
		if (!faultAddress || typeof faultAddress === "string") throw new Error("expected an HTTP/2 port");
		http2.connect = ((...args: unknown[]) => {
			faultAttempts++;
			const client = Reflect.apply(realConnect, http2, [`http://127.0.0.1:${faultAddress.port}`, ...args.slice(1)]);
			queueMicrotask(() =>
				client.emit(
					"error",
					Object.assign(new Error(scenario === "alpn-failed" ? "h2 is not supported" : "read ECONNRESET"), {
						code: scenario === "alpn-failed" ? "ERR_HTTP2_ERROR" : "ECONNRESET",
					}),
				),
			);
			return client;
		}) as typeof http2.connect;
	} else {
		http2.connect = ((...args: unknown[]) =>
			Reflect.apply(realConnect, http2, [
				`https://127.0.0.1:${address.port}`,
				...args.slice(1),
			])) as typeof http2.connect;
	}
}

const context: Context = { messages: [{ role: "user", content: "transport", timestamp: 1 }] };
const turns: {
	stopReason: string;
	starts: number;
	text: string;
	connections: number;
	tunnels: number;
	opens: number;
	faultAttempts: number;
}[] = [];
const turn = async (target = model, transport?: "http2") => {
	const stream = streamCursor(target, context, {
		apiKey: "test-token",
		transport,
		fetch: fixtureFetch,
		providerRetryWait: async () => {},
	});
	let starts = 0;
	for await (const event of stream) if (event.type === "start") starts++;
	const result = await stream.result();
	turns.push({
		stopReason: result.stopReason,
		starts,
		text: result.content.map(part => (part.type === "text" ? part.text : "")).join(""),
		connections,
		tunnels,
		opens: runSse.opens,
		faultAttempts,
	});
};

const realNow = performance.now.bind(performance);
let skew = 0;
Object.defineProperty(performance, "now", { configurable: true, value: () => realNow() + skew });
try {
	await turn();
	if (scenario === "forced") await turn(model, "http2");
	else await turn();
	if (scenario === "cache") {
		if (!secondEndpoint) throw new Error("missing second fixture endpoint");
		await turn(makeModel(secondEndpoint.server.url.toString()));
		skew += 10 * 60_000 + 1;
		await turn();
	}
	process.stdout.write(
		`${JSON.stringify({ turns, originalRequestIds, secondEndpointOpens: secondEndpoint?.opens })}\n`,
	);
} finally {
	http2.connect = realConnect;
	for (const socket of sockets) socket.destroy();
	dropper.close();
	faultServer?.close();
	runSse.server.stop(true);
	secondEndpoint?.server.stop(true);
}
