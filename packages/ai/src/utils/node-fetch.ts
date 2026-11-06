import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils/tls-fetch";
import { Agent, FormData as UndiciFormData, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici/index.js";
import type { ConnectionOptions } from "node:tls";
import type { FetchImpl } from "../types";
import { getProxyForUrl } from "./proxy";

const dispatchers = new Map<string, Dispatcher>();
const host = globalThis as unknown as { Bun?: unknown };
const nativeFetch = globalThis.fetch;
type ExtendedInit = RequestInit & {
	proxy?: string;
	tls?: ConnectionOptions & { serverName?: string };
	timeout?: number | false;
	unix?: string;
	dispatcher?: Dispatcher;
};

/** Translate Bun's wire-affecting fetch extensions into real undici dispatchers. */
export function portableFetch(base: FetchImpl = nativeFetch): FetchImpl {
	if (base !== nativeFetch) return base;
	return async (input, init) => {
		const extraCa = resolveExtraCa();
		const options = (extraCa ? withExtraCaInit(init, extraCa) : init) as ExtendedInit | undefined;
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const proxy = options?.unix ? "" : (options?.proxy ?? getProxyForUrl(undefined, url) ?? "");
		// Bun treats an empty proxy as ambient routing; direct requests need an explicit dispatcher.
		if (host.Bun && (proxy || options?.unix)) return base(input, { ...options, proxy } as RequestInit);
		const tls = options?.tls;
		const key = JSON.stringify([proxy, tls, options?.unix, options?.timeout]);
		let dispatcher = dispatchers.get(key);
		if (!dispatcher) {
			const connect = {
				...tls,
				...(tls?.serverName ? { servername: tls.serverName } : {}),
				...(options?.unix ? { socketPath: options.unix } : {}),
			};
			const timeout = options?.timeout === false ? 0 : options?.timeout;
			const common = { connect, headersTimeout: timeout ?? 0, bodyTimeout: timeout ?? 0 };
			dispatcher = proxy
				? new ProxyAgent({
						uri: proxy,
						requestTls: connect,
						proxyTls: tls,
						headersTimeout: timeout ?? 0,
						bodyTimeout: timeout ?? 0,
					})
				: new Agent(common);
			dispatchers.set(key, dispatcher);
		}
		const { proxy: _proxy, tls: _tls, timeout: _timeout, unix: _unix, ...standard } = options ?? {};
		const requestInit = {
			...(input instanceof Request
				? { method: input.method, headers: input.headers, body: input.body, signal: input.signal }
				: {}),
			...standard,
			dispatcher,
			duplex: "half",
		};
		const requestUrl = input instanceof Request ? input.url : input.toString();
		if (host.Bun) {
			const request = requestInit as Parameters<typeof undiciFetch>[1];
			// The host's FormData has a different brand from bundled undici's.
			// Preserve multipart encoding on the Bun branch that uses undici.
			if (request?.body instanceof FormData && !(request.body instanceof UndiciFormData)) {
				const form = new UndiciFormData();
				request.body.forEach((value, name) => form.append(name, value));
				request.body = form;
			}
			const response = await undiciFetch(requestUrl, request);
			return response as unknown as Response;
		}
		// Preserve the host Response identity for consumers that use instanceof before caching.
		return nativeFetch(requestUrl, requestInit as RequestInit);
	};
}
