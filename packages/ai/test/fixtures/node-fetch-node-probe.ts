import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { portableFetch } from "../../src/utils/node-fetch";
import { installProxyFetch } from "../../src/utils/proxy";

assert.equal(typeof Bun, "undefined");

async function listen(server: Server, context: TestContext): Promise<string> {
	const sockets = new Set<Socket>();
	server.on("connection", socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	context.after(async () => {
		for (const socket of sockets) socket.destroy();
		const closed = once(server, "close");
		server.close();
		await closed;
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

test("SDK-installed fetch returns host Responses that model caches can accept", async context => {
	const asset = Buffer.from([0, 1, 127, 128, 255]);
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/octet-stream", "content-length": asset.length });
		response.end(asset);
	});
	const url = await listen(server, context);
	const previousFetch = globalThis.fetch;
	installProxyFetch();
	try {
		const response = await fetch(`${url}/weights.onnx`);
		assert.ok(response instanceof Response, "model caches reject foreign Response constructors");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/octet-stream");
		assert.deepEqual(Buffer.from(await response.clone().arrayBuffer()), asset);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("native Request bodies, headers and explicit overrides survive the dispatcher", async context => {
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				method: request.method,
				label: request.headers["x-label"],
				body: Buffer.concat(chunks).toString(),
			}),
		);
	});
	const url = await listen(server, context);
	const fetch = portableFetch();
	const request = new Request(`${url}/request`, {
		method: "POST",
		headers: { "x-label": "original" },
		body: "original body",
	});
	const response = await fetch(request);
	assert.ok(response instanceof Response);
	assert.deepEqual(await response.json(), { method: "POST", label: "original", body: "original body" });
	const overridden = await fetch(
		new Request(`${url}/override`, { method: "POST", headers: { "x-label": "original" }, body: "unused" }),
		{
			method: "PATCH",
			headers: { "x-label": "override" },
			body: "override body",
		},
	);
	assert.deepEqual(await overridden.json(), { method: "PATCH", label: "override", body: "override body" });
});

test("native host multipart uploads preserve binary files and Unicode names", async context => {
	const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const contentType = request.headers["content-type"];
		if (!contentType?.startsWith("multipart/form-data;")) {
			response.writeHead(415).end("Expected multipart upload");
			return;
		}
		const form = await new Response(Buffer.concat(chunks), {
			headers: { "content-type": contentType },
		}).formData();
		const file = form.get("file");
		if (!(file instanceof File)) {
			response.writeHead(400).end("Missing file");
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				title: form.get("title"),
				filename: file.name,
				mimeType: file.type,
				bytes: [...new Uint8Array(await file.arrayBuffer())],
			}),
		);
	});
	const url = await listen(server, context);
	const form = new FormData();
	form.set("title", "原始图片");
	form.set("file", new File([bytes], "参考.png", { type: "image/png" }));
	const response = await portableFetch()(url, { method: "POST", body: form });
	assert.ok(response instanceof Response);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		title: "原始图片",
		filename: "参考.png",
		mimeType: "image/png",
		bytes: [...bytes],
	});
});

test("native host fetch still honors an explicit CONNECT proxy dispatcher", async context => {
	const target = createServer((_request, response) => response.end("proxied asset"));
	const targetUrl = await listen(target, context);
	const proxy = createServer();
	let tunnels = 0;
	proxy.on("connect", (request, socket, head) => {
		assert.equal(request.url, new URL(targetUrl).host);
		tunnels++;
		const upstream = connect(Number(new URL(targetUrl).port), "127.0.0.1");
		socket.once("close", () => upstream.destroy());
		upstream.once("error", () => socket.destroy());
		upstream.once("connect", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
	});
	const proxyUrl = await listen(proxy, context);
	const options = { proxy: proxyUrl, method: "GET" };
	const response = await portableFetch()(`${targetUrl}/proxied`, options);
	assert.ok(response instanceof Response);
	assert.equal(await response.text(), "proxied asset");
	assert.equal(tunnels, 1);
});
