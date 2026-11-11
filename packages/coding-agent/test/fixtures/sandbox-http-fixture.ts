import { spyOn } from "bun:test";
import { Resolver } from "node:dns/promises";
import type { RecordWithTtl, ResolveOptions, ResolveWithTtlOptions } from "node:dns";
import * as http from "node:http";
import type { RequestOptions } from "node:https";
import type { Socket } from "node:net";

export interface RecordedSandboxRequest {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

export type SandboxFixtureRequestOptions = RequestOptions & { autoSelectFamily?: boolean };

/** Preserve the native TTL/no-TTL overloads when mocking a resolver's address answer. */
export function sandboxDnsAnswer(answer: (hostname: string) => Promise<string[]>): Resolver["resolve4"] {
	function resolve(hostname: string): Promise<string[]>;
	function resolve(hostname: string, options: ResolveWithTtlOptions): Promise<RecordWithTtl[]>;
	function resolve(hostname: string, options: ResolveOptions): Promise<string[] | RecordWithTtl[]>;
	async function resolve(hostname: string, options?: ResolveOptions): Promise<string[] | RecordWithTtl[]> {
		const addresses = await answer(hostname);
		return options?.ttl ? addresses.map(address => ({ address, ttl: 60 })) : addresses;
	}
	return resolve;
}

/** Only the test socket seam maps an approved public address to loopback. */
export async function sandboxHttpFixture(handler: http.RequestListener) {
	const requests: RecordedSandboxRequest[] = [];
	const pins: Array<{ hostname: string; address: string; family: number }> = [];
	const sockets = new Set<Socket>();
	const dns: Record<string, { ipv4: string[]; ipv6: string[] }> = Object.create(null);
	const server = http.createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		try {
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			requests.push({ method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
			handler(request, response);
		} catch (error) { response.destroy(error instanceof Error ? error : undefined); }
	});
	server.on("connection", socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	const ready = Promise.withResolvers<void>();
	server.once("error", ready.reject);
	server.listen(0, "127.0.0.1", ready.resolve);
	await ready.promise;
	const bound = server.address();
	if (!bound || typeof bound === "string") throw new Error("HTTP fixture did not bind a TCP port");
	const port = bound.port;
	const dns4 = spyOn(Resolver.prototype, "resolve4").mockImplementation(sandboxDnsAnswer(async hostname => dns[hostname]?.ipv4 ?? ["93.184.216.34"]));
	const dns6 = spyOn(Resolver.prototype, "resolve6").mockImplementation(sandboxDnsAnswer(async hostname => dns[hostname]?.ipv6 ?? ["2606:4700:4700::1111"]));
	const original = http.Agent.prototype.createConnection;
	const connector = spyOn(http.Agent.prototype, "createConnection").mockImplementation(function (this: http.Agent, options, callback) {
		if (!options.lookup || (options as SandboxFixtureRequestOptions).autoSelectFamily !== false) throw new Error("Sandbox socket did not provide a fixed-address lookup");
		const hostname = String(options.host);
		let resolved = false;
		options.lookup(hostname, { family: Number(options.family) }, (error, address, family) => {
			if (error || typeof address !== "string" || (family !== 4 && family !== 6)) throw new Error("Sandbox lookup did not return one approved IP");
			pins.push({ hostname, address, family });
			resolved = true;
		});
		if (!resolved) throw new Error("Sandbox lookup was not pinned synchronously");
		return original.call(this, { ...options, host: "127.0.0.1", hostname: "127.0.0.1", port, family: 4, lookup: undefined }, callback);
	});
	return {
		requests, pins, sockets, dns, dns4, dns6,
		url: (path = "/", hostname = "public.omp.sh") => `http://${hostname}:${port}${path}`,
		async close() {
			connector.mockRestore(); dns4.mockRestore(); dns6.mockRestore();
			for (const socket of sockets) socket.destroy();
			const stopped = Promise.withResolvers<void>();
			server.close(error => error ? stopped.reject(error) : stopped.resolve());
			await stopped.promise;
		},
	};
}
