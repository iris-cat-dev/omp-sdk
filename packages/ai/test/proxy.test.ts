import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	connectProxiedSocket,
	getProxyForProvider,
	getProxyForUrl,
	getProxyPolicyController,
	ProxyPolicyController,
	proxyFetch,
	setDefaultProxyPolicyController,
	isLocalOrMetadataHost,
	shouldBypassProxy,
	withProxyPolicy,
	withProxyProvider,
} from "@oh-my-pi/pi-ai/utils/proxy";

const PROXY = "http://127.0.0.1:24560/";

interface SilentProxyServer {
	url: string;
	accepted: Promise<net.Socket>;
	close(): Promise<void>;
}

async function createSilentProxyServer(): Promise<SilentProxyServer> {
	const sockets = new Set<net.Socket>();
	const accepted = Promise.withResolvers<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.resume();
		socket.on("end", () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
		accepted.resolve(socket);
	});

	const listening = Promise.withResolvers<void>();
	const onError = (error: Error): void => listening.reject(error);
	server.once("error", onError);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", onError);
		listening.resolve();
	});
	await listening.promise;

	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected TCP listener address");

	return {
		url: `http://127.0.0.1:${address.port}`,
		accepted: accepted.promise,
		async close() {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => {
				if (error) closed.reject(error);
				else closed.resolve();
			});
			await closed.promise;
		},
	};
}

async function waitForSocketClose(socket: net.Socket): Promise<void> {
	if (socket.destroyed) return;
	const closed = Promise.withResolvers<void>();
	socket.once("close", () => closed.resolve());
	await closed.promise;
}
let previousController: ProxyPolicyController;
beforeEach(() => {
	previousController = getProxyPolicyController();
	setDefaultProxyPolicyController(new ProxyPolicyController());
});
afterEach(() => setDefaultProxyPolicyController(previousController));

describe("ProxyPolicyController", () => {
	it("routes exact provider IDs independently and preserves addresses while disabled", () => {
		const controller = new ProxyPolicyController({
			enabled: true,
			default: { mode: "proxy", url: PROXY },
			providers: {
				"github-copilot": { mode: "proxy", url: "https://other-proxy.example:8080/" },
				"direct-provider": { mode: "direct" },
			},
		});
		withProxyPolicy(controller, () => {
			expect(getProxyForProvider("github-copilot")).toBe("https://other-proxy.example:8080/");
			expect(getProxyForProvider("github_copilot")).toBe(PROXY);
			expect(getProxyForProvider("direct-provider")).toBeUndefined();
			controller.setPolicy({ ...controller.getPolicy(), enabled: false });
			expect(getProxyForProvider("github-copilot")).toBeUndefined();
			expect(controller.getPolicy().default).toEqual({ mode: "proxy", url: PROXY });
			controller.setPolicy({ ...controller.getPolicy(), enabled: true });
			expect(getProxyForProvider("github-copilot")).toBe("https://other-proxy.example:8080/");
			expect(controller.revision).toBe(2);
		});
	});

	it("isolates concurrent async sessions and retains provider context", async () => {
		const a = new ProxyPolicyController({ enabled: true, providers: { provider: { mode: "proxy", url: PROXY } } });
		const b = new ProxyPolicyController({
			enabled: true,
			default: { mode: "proxy", url: "http://other.example:8080/" },
		});
		const barrier = Promise.withResolvers<void>();
		const first = withProxyPolicy(a, () =>
			withProxyProvider("provider", async () => {
				await barrier.promise;
				return getProxyForProvider();
			}),
		);
		const second = withProxyPolicy(b, async () => {
			barrier.resolve();
			await Promise.resolve();
			return getProxyForProvider("provider");
		});
		expect(await Promise.all([first, second])).toEqual([PROXY, "http://other.example:8080/"]);
		expect(getProxyForProvider("provider")).toBeUndefined();
	});

	it("rejects unsupported proxies and leaves the prior policy intact", () => {
		const controller = new ProxyPolicyController({ enabled: true, default: { mode: "proxy", url: PROXY } });
		for (const url of ["socks5://localhost:8080", "file:///tmp/proxy", "http://proxy.example/path", "not a url"]) {
			expect(() => controller.setPolicy({ enabled: true, default: { mode: "proxy", url } })).toThrow();
		}
		expect(controller.revision).toBe(0);
		expect(controller.getPolicy().default).toEqual({ mode: "proxy", url: PROXY });
	});
});

describe("isLocalOrMetadataHost / shouldBypassProxy hard-coded ranges", () => {
	const bypassed = [
		"localhost",
		"app.localhost",
		"127.5.5.5",
		"10.1.2.3",
		"192.168.1.1",
		"172.16.0.1",
		"172.31.255.255",
		"169.254.169.254", // EC2 IMDS
		"169.254.170.2", // ECS task credentials
		"metadata.google.internal",
	];
	for (const host of bypassed) {
		it(`bypasses ${host}`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(true);
			expect(shouldBypassProxy(new URL(`http://${host}/x`))).toBe(true);
		});
	}

	// IPv6 hosts need bracket form inside a URL.
	const bypassedV6 = ["::1", "fd00:ec2::254", "fe80::1"];
	for (const host of bypassedV6) {
		it(`bypasses [${host}]`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(true);
			expect(shouldBypassProxy(new URL(`http://[${host}]/x`))).toBe(true);
		});
	}

	const proxied = [
		"api.sakana.ai",
		"172.15.0.1", // just below the 172.16/12 block
		"172.32.0.1", // just above the 172.16/12 block
		"11.0.0.1", // not RFC1918
	];
	for (const host of proxied) {
		it(`does not bypass ${host}`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(false);
			expect(shouldBypassProxy(new URL(`https://${host}/x`))).toBe(false);
		});
	}
});

describe("policy bypass rules", () => {
	it("matches suffixes, ports, wildcard, and secure websocket ports", () => {
		const controller = new ProxyPolicyController({
			enabled: true,
			default: { mode: "proxy", url: PROXY },
			noProxy: [".sakana.ai", "api.openai.com:443"],
		});
		withProxyPolicy(controller, () => {
			expect(shouldBypassProxy(new URL("https://api.sakana.ai/v1"))).toBe(true);
			expect(shouldBypassProxy(new URL("https://sakana.ai/v1"))).toBe(true);
			expect(getProxyForUrl("provider", new URL("wss://api.openai.com/live"))).toBeUndefined();
			expect(getProxyForUrl("provider", new URL("http://api.openai.com:8080/v1"))).toBe(PROXY);
			controller.setPolicy({ ...controller.getPolicy(), noProxy: ["*"] });
			expect(getProxyForUrl("provider", new URL("https://other.example"))).toBeUndefined();
		});
	});
});

/** Serve a real HTTP response, supporting both forward HTTP and CONNECT transports. */
async function responseProxy(label: string) {
	const sockets = new Set<net.Socket>();
	let requests = 0;
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		let incoming = "";
		let tunneled = false;
		socket.on("data", chunk => {
			incoming += chunk.toString();
			if (!incoming.includes("\r\n\r\n")) return;
			if (!tunneled && incoming.startsWith("CONNECT ")) {
				tunneled = true;
				incoming = "";
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				return;
			}
			requests++;
			socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${label.length}\r\n\r\n${label}`);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP proxy");
	return {
		url: `http://127.0.0.1:${address.port}/`,
		get requests() {
			return requests;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		},
	};
}

describe("SDK proxy fetch wire routing", () => {
	it("switches the same fetch A → B → direct, with independent providers", async () => {
		const a = await responseProxy("route-a");
		const b = await responseProxy("route-b");
		const controller = new ProxyPolicyController({
			enabled: true,
			providers: {
				alpha: { mode: "proxy", url: a.url },
				beta: { mode: "proxy", url: b.url },
			},
		});
		const fetchAlpha = proxyFetch("alpha");
		const fetchBeta = proxyFetch("beta");
		try {
			await withProxyPolicy(controller, async () => {
				expect(await (await fetchAlpha("http://provider.invalid/request")).text()).toBe("route-a");
				expect(await (await fetchBeta("http://provider.invalid/request")).text()).toBe("route-b");
				controller.setPolicy({ enabled: true, providers: { alpha: { mode: "proxy", url: b.url } } });
				expect(await (await fetchAlpha("http://provider.invalid/request")).text()).toBe("route-b");
				controller.setPolicy({ ...controller.getPolicy(), enabled: false });
				await expect(
					fetchAlpha("http://provider.invalid/request", { signal: AbortSignal.timeout(1_000) }),
				).rejects.toThrow();
			});
			expect(a.requests).toBe(1);
			expect(b.requests).toBe(2);
		} finally {
			await a.close();
			await b.close();
		}
	});

	it("does not fall back to ambient standard proxies when disabled", async () => {
		const ambient = await responseProxy("ambient-proxy");
		const saved = Object.fromEntries(
			["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].map(key => [key, process.env[key]]),
		);
		try {
			process.env.HTTP_PROXY = ambient.url;
			process.env.HTTPS_PROXY = ambient.url;
			process.env.ALL_PROXY = ambient.url;
			process.env.NO_PROXY = "";
			await expect(
				proxyFetch()("http://provider.invalid/request", { signal: AbortSignal.timeout(1_000) }),
			).rejects.toThrow();
			expect(ambient.requests).toBe(0);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await ambient.close();
		}
	});

	it.skipIf(process.platform === "win32")("keeps Unix sockets direct under an enabled policy", async () => {
		const socket = path.join(os.tmpdir(), `omp-proxy-${process.pid}.sock`);
		const connections = new Set<net.Socket>();
		const server = net.createServer(connection => {
			connections.add(connection);
			connection.once("close", () => connections.delete(connection));
			connection.once("data", () =>
				connection.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 12\r\n\r\nlocal broker"),
			);
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(socket, listening.resolve);
		await listening.promise;
		try {
			const controller = new ProxyPolicyController({ enabled: true, default: { mode: "proxy", url: PROXY } });
			const init = { unix: socket, signal: AbortSignal.timeout(1_500) };
			const response = await withProxyPolicy(controller, () => proxyFetch()("http://broker.invalid/info", init));
			expect(await response.text()).toBe("local broker");
		} finally {
			for (const connection of connections) connection.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});
});

describe("connectProxiedSocket", () => {
	it("times out and closes a proxy tunnel that never sends a CONNECT response", async () => {
		const proxy = await createSilentProxyServer();
		try {
			const result = await connectProxiedSocket(proxy.url, "https://cursor.example", { timeoutMs: 20 }).then(
				() => "resolved",
				error => error,
			);

			expect(result).toBeInstanceOf(AIError.StreamTimeoutError);
			const socket = await proxy.accepted;
			await waitForSocketClose(socket);
			expect(socket.destroyed).toBe(true);
		} finally {
			await proxy.close();
		}
	});

	it("aborts and closes an in-progress proxy tunnel when the caller aborts", async () => {
		const proxy = await createSilentProxyServer();
		try {
			const controller = new AbortController();
			const pending = connectProxiedSocket(proxy.url, "https://cursor.example", {
				signal: controller.signal,
				timeoutMs: 1_000,
			}).then(
				() => "resolved",
				error => error,
			);
			const socket = await proxy.accepted;

			controller.abort();
			const result = await pending;

			expect(result).toBeInstanceOf(AIError.AbortError);
			await waitForSocketClose(socket);
			expect(socket.destroyed).toBe(true);
		} finally {
			await proxy.close();
		}
	});
});
