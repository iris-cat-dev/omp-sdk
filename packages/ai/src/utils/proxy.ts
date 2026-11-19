import { AsyncLocalStorage } from "node:async_hooks";
import { portableFetch } from "./node-fetch";
import * as net from "node:net";
import * as tls from "node:tls";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { AbortError } from "../error/abort";
import { StreamTimeoutError, ValidationError } from "../error/validation";
import type { FetchImpl } from "../types";

export type ProxyRoute = { mode: "direct" } | { mode: "proxy"; url: string };

export interface ProxyPolicy {
	enabled: boolean;
	default?: ProxyRoute;
	providers?: Record<string, ProxyRoute>;
	noProxy?: string[];
}

function validateRoute(route: ProxyRoute): ProxyRoute {
	if (route?.mode === "direct") return Object.freeze({ mode: "direct" });
	if (route?.mode !== "proxy" || typeof route.url !== "string") {
		throw new ValidationError("Proxy route must be direct or an HTTP(S) proxy URL");
	}
	let url: URL;
	try {
		url = new URL(route.url);
	} catch {
		throw new ValidationError("Invalid proxy URL");
	}
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) {
		throw new ValidationError("Proxy URL must use HTTP or HTTPS without a path, query, or fragment");
	}
	try {
		decodeURIComponent(url.username);
		decodeURIComponent(url.password);
	} catch {
		throw new ValidationError("Invalid proxy URL credentials");
	}
	return Object.freeze({ mode: "proxy", url: url.href });
}

function validatePolicy(policy: ProxyPolicy): ProxyPolicy {
	if (!policy || typeof policy.enabled !== "boolean") throw new ValidationError("Proxy policy requires enabled");
	const result: ProxyPolicy = { enabled: policy.enabled };
	if (policy.default !== undefined) result.default = validateRoute(policy.default);
	if (policy.providers !== undefined) {
		if (!policy.providers || typeof policy.providers !== "object" || Array.isArray(policy.providers)) {
			throw new ValidationError("Proxy providers must be a provider route map");
		}
		result.providers = Object.freeze(
			Object.fromEntries(Object.entries(policy.providers).map(([id, route]) => [id, validateRoute(route)])),
		);
	}
	if (policy.noProxy !== undefined) {
		if (!Array.isArray(policy.noProxy) || policy.noProxy.some(rule => typeof rule !== "string" || !rule.trim())) {
			throw new ValidationError("Proxy bypass rules must be nonempty strings");
		}
		result.noProxy = Object.freeze(policy.noProxy.map(rule => rule.trim())) as unknown as string[];
	}
	return Object.freeze(result);
}

export class ProxyPolicyController {
	#policy: ProxyPolicy;
	#revision = 0;
	constructor(policy: ProxyPolicy = { enabled: false }) {
		this.#policy = validatePolicy(policy);
	}
	getPolicy(): ProxyPolicy {
		return this.#policy;
	}
	setPolicy(policy: ProxyPolicy): void {
		this.#policy = validatePolicy(policy);
		this.#revision++;
	}
	get revision(): number {
		return this.#revision;
	}
}

const proxyContext = new AsyncLocalStorage<{ controller?: ProxyPolicyController; provider?: string }>();
let defaultController = new ProxyPolicyController();

export function getProxyPolicyController(): ProxyPolicyController {
	return proxyContext.getStore()?.controller ?? defaultController;
}

/** Active session controller only, for nested SDK session construction. */
export function getScopedProxyPolicyController(): ProxyPolicyController | undefined {
	return proxyContext.getStore()?.controller;
}

export function setDefaultProxyPolicyController(controller: ProxyPolicyController): void {
	defaultController = controller;
}

export function withProxyPolicy<T>(controller: ProxyPolicyController, callback: () => T): T {
	return proxyContext.run({ ...proxyContext.getStore(), controller }, callback);
}

export function withProxyProvider<T>(provider: string, callback: () => T): T {
	return proxyContext.run({ ...proxyContext.getStore(), provider }, callback);
}

/**
 * Checks if a host is local or cloud metadata, which should always bypass the proxy
 * (e.g. localhost, 127/8, ::1, 169.254.169.254, metadata.google.internal).
 */
export function isLocalOrMetadataHost(host: string): boolean {
	const lowerHost = host.toLowerCase();

	// Hostnames: localhost and the cloud metadata service.
	if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost === "metadata.google.internal") {
		return true;
	}

	// Strip IPv6 brackets before numeric checks.
	const ip = lowerHost.replace(/^\[|\]$/g, "");

	// IPv4 loopback (127/8), unspecified (0/8), RFC1918 private (10/8, 172.16/12,
	// 192.168/16) and link-local (169.254/16 — covers IMDS 169.254.169.254 and
	// ECS credentials 169.254.170.2). None are reachable through a remote egress
	// proxy, and credential/metadata probes must never leak to one.
	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}

	// IPv6 loopback (::1), unspecified (::), link-local (fe80::/10) and
	// unique-local (fc00::/7 — covers EC2 IPv6 IMDS fd00:ec2::254).
	if (ip === "::1" || ip === "::") return true;
	if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
	if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

	return false;
}

/** Local/private hosts always bypass; optional policy rules match host suffixes and ports. */
export function shouldBypassProxy(urlObj: URL): boolean {
	if (isLocalOrMetadataHost(urlObj.hostname)) return true;
	const rules = getProxyPolicyController().getPolicy().noProxy ?? [];
	const targetHost = urlObj.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const targetPort = urlObj.port || (urlObj.protocol === "https:" || urlObj.protocol === "wss:" ? "443" : "80");

	for (const rule of rules) {
		if (rule === "*") {
			return true;
		}

		let ruleHost = rule.toLowerCase();
		let rulePort: string | undefined;

		if (ruleHost.includes("]:")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		} else if (!ruleHost.includes("]") && ruleHost.includes(":")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		}

		// Strip IPv6 brackets
		ruleHost = ruleHost.replace(/^\[|\]$/g, "");

		if (rulePort && rulePort !== targetPort) {
			continue;
		}

		// Match host part
		if (ruleHost.startsWith(".")) {
			const suffix = ruleHost;
			const cleanRule = ruleHost.slice(1);
			if (targetHost === cleanRule || targetHost.endsWith(suffix)) {
				return true;
			}
		} else {
			if (targetHost === ruleHost || targetHost.endsWith(`.${ruleHost}`)) {
				return true;
			}
		}
	}

	return false;
}

/** Resolve the current policy at request time, preserving provider IDs verbatim. */
export function getProxyForProvider(provider?: string): string | undefined {
	const policy = getProxyPolicyController().getPolicy();
	if (!policy.enabled) return undefined;
	const id = provider ?? proxyContext.getStore()?.provider;
	const route =
		(id && Object.hasOwn(policy.providers ?? {}, id) ? policy.providers?.[id] : undefined) ?? policy.default;
	return route?.mode === "proxy" ? route.url : undefined;
}

export function getProxyForUrl(provider: string | undefined, url: URL): string | undefined {
	return shouldBypassProxy(url) ? undefined : getProxyForProvider(provider);
}

/** Always stamp direct explicitly: Bun must never consult ambient proxy variables. */
export function withProxyInit(
	input: string | URL | Request,
	init: RequestInit | undefined,
	proxyUrl?: string,
): RequestInit {
	let proxy = proxyUrl ?? "";
	if (init && "unix" in init && init.unix) proxy = "";
	try {
		if (shouldBypassProxy(new URL(input instanceof Request ? input.url : input.toString()))) proxy = "";
	} catch {
		proxy = "";
	}
	return { ...init, proxy } as RequestInit;
}

export function wrapFetchForProxy(fetchImpl: FetchImpl, provider?: string): FetchImpl {
	const base = portableFetch(fetchImpl);
	const wrapped: FetchImpl = (input, init) => {
		const dispatch = () => base(input, withProxyInit(input, init, getProxyForProvider(provider)));
		return provider === undefined ? dispatch() : withProxyProvider(provider, dispatch);
	};
	return wrapped;
}

/** Dynamic provider-aware SDK fetch, backed by native Bun fetch or undici on Node. */
export function proxyFetch(provider?: string): FetchImpl {
	const base = globalThis.fetch === installedPolicyFetch ? installedPortableFetch! : portableFetch(globalThis.fetch);
	return wrapFetchForProxy(base, provider);
}

let installedPolicyFetch: FetchImpl | undefined;
let installedPortableFetch: FetchImpl | undefined;

/** Keep non-provider SDK-host networking direct, including tool and MCP fetches. */
export function installProxyFetch(): void {
	if (globalThis.fetch === installedPolicyFetch) return;
	const base = portableFetch(globalThis.fetch);
	installedPortableFetch = base;
	installedPolicyFetch = (input, init) => {
		const explicitProxy =
			init && typeof init === "object" && "proxy" in init && typeof init.proxy === "string" ? init.proxy : undefined;
		const provider = proxyContext.getStore()?.provider;
		return base(
			input,
			withProxyInit(
				input,
				init,
				explicitProxy !== undefined
					? explicitProxy
					: provider === undefined
						? undefined
						: getProxyForProvider(provider),
			),
		);
	};
	globalThis.fetch = installedPolicyFetch as typeof globalThis.fetch;
}

export interface ConnectProxiedSocketOptions {
	/** Caller cancellation for the proxy TCP/TLS handshake and CONNECT tunnel. */
	signal?: AbortSignal;
	/** Maximum wall-clock time to establish the final TLS tunnel. Disabled when absent or non-positive. */
	timeoutMs?: number;
	/** Target TLS profile. Cursor defaults to HTTP/2 when this is absent. */
	tls?: tls.ConnectionOptions;
}

/**
 * Tunnel a socket connection through an HTTP CONNECT proxy.
 * This is used specifically to wrap Node's `http2.connect(baseUrl, { createConnection })` for Cursor.
 */
export async function connectProxiedSocket(
	proxyUrlStr: string,
	targetUrlStr: string,
	options?: ConnectProxiedSocketOptions,
): Promise<tls.TLSSocket> {
	if (options?.signal?.aborted) {
		throw new AbortError("Proxy tunnel aborted");
	}

	const route = validateRoute({ mode: "proxy", url: proxyUrlStr });
	if (route.mode !== "proxy") throw new ValidationError("Expected proxy route");
	const proxyUrl = new URL(route.url);
	const targetUrl = new URL(targetUrlStr);

	const useProxySsl = proxyUrl.protocol === "https:";
	const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : useProxySsl ? 443 : 80;
	const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, "");

	const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
	const targetHost = targetUrl.hostname;

	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();

	const readyEvent = useProxySsl ? "secureConnect" : "connect";
	let tunnelSocket: tls.TLSSocket | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let responseData = "";
	let settled = false;

	const cleanup = (): void => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		options?.signal?.removeEventListener("abort", onAbort);
		rawSocket?.off("error", onRawError);
		rawSocket?.off(readyEvent, onProxyReady);
		rawSocket?.off("data", onProxyData);
		tunnelSocket?.off("secureConnect", onTunnelReady);
		tunnelSocket?.off("error", onTunnelError);
	};
	const destroyInProgress = (): void => {
		tunnelSocket?.destroy();
		rawSocket?.destroy();
	};
	const rejectOnce = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		destroyInProgress();
		logger.debug("proxy tunnel failed", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			error: String(error),
			code: "code" in error ? String(error.code) : undefined,
		});
		reject(error);
	};
	const resolveOnce = (socket: tls.TLSSocket): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(socket);
	};
	const onAbort = (): void => rejectOnce(new AbortError("Proxy tunnel aborted"));
	const onRawError = (error: Error): void => rejectOnce(error);
	const onTunnelError = (error: Error): void => rejectOnce(error);
	const onTunnelReady = (): void => {
		if (!tunnelSocket) return;
		logger.debug("proxy tunnel established", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket?.remoteAddress ?? "?"}:${rawSocket?.remotePort ?? "?"}`,
			localPort: rawSocket?.localPort,
			alpn: tunnelSocket.alpnProtocol,
			authorized: tunnelSocket.authorized,
		});
		resolveOnce(tunnelSocket);
	};
	const onProxyData = (chunk: Buffer): void => {
		if (!rawSocket) return;
		responseData += chunk.toString("binary");
		if (!responseData.includes("\r\n\r\n")) return;

		rawSocket.off("data", onProxyData);
		rawSocket.off("error", onRawError);

		const firstLine = responseData.split("\r\n")[0];
		logger.debug("proxy tunnel CONNECT reply", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			reply: firstLine,
		});
		if (!firstLine.includes(" 200 ")) {
			rejectOnce(new ValidationError(`Proxy tunnel failed: ${firstLine}`));
			return;
		}

		const tlsOptions = options?.tls;
		const newTunnelSocket: tls.TLSSocket = tls.connect({
			...tlsOptions,
			socket: rawSocket,
			servername: tlsOptions?.servername ?? targetHost,
			ALPNProtocols: tlsOptions?.ALPNProtocols ?? ["h2"],
		});
		tunnelSocket = newTunnelSocket;
		newTunnelSocket.once("secureConnect", onTunnelReady);
		newTunnelSocket.once("error", onTunnelError);
	};
	const onProxyReady = (): void => {
		if (!rawSocket) return;
		let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;

		if (proxyUrl.username || proxyUrl.password) {
			const creds = Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64");
			connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
		}
		connectReq += "\r\n";

		rawSocket.write(connectReq);
		rawSocket.on("data", onProxyData);
		logger.debug("proxy tunnel CONNECT sent", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket.remoteAddress ?? "?"}:${rawSocket.remotePort ?? "?"}`,
		});
	};

	options?.signal?.addEventListener("abort", onAbort, { once: true });
	if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		const timeoutMs = Math.trunc(options.timeoutMs);
		timeout = setTimeout(() => {
			rejectOnce(new StreamTimeoutError(`Proxy tunnel timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timeout.unref?.();
	}

	const rawSocket = useProxySsl
		? tls.connect({
				host: proxyHost,
				port: proxyPort,
			})
		: net.connect({
				host: proxyHost,
				port: proxyPort,
			});
	rawSocket.once("error", onRawError);
	rawSocket.once(readyEvent, onProxyReady);

	return promise;
}
