import { type as arkType } from "@oh-my-pi/omptype";
import { htmlToMarkdown } from "@oh-my-pi/pi-natives";
import type { LookupAddress } from "node:dns";
import { Resolver } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { Duplex, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { ToolDefinition } from "./extensibility/extensions/types";
import sandboxFetchDescription from "./prompts/tools/sandbox-fetch.md" with { type: "text" };
import { decodeBody } from "./web/response-body";
import { BROWSER_USER_AGENT } from "./web/scrapers/types";

type PinnedRequestOptions = https.RequestOptions & { autoSelectFamily: true; autoSelectFamilyAttemptTimeout: number };

export interface SandboxFetchRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface SandboxFetchResponse {
	url: string;
	status: number;
	headers: Record<string, string>;
	body: string;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_READER_BYTES = 5 * 1024 * 1024;
const MAX_READER_CHARS = 100_000;
const MAX_URL_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 32 * 1024;
const DEADLINE_MS = 30_000;
const MAX_REDIRECTS = 5;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TRANSPORT_HEADERS: Record<string, true> = {
	host: true, "content-length": true, "transfer-encoding": true, connection: true,
	upgrade: true, "keep-alive": true, te: true, trailer: true, expect: true, "http2-settings": true,
};
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"];

class SandboxFetchError extends Error {}

interface ParsedRequest {
	url: URL;
	method: string;
	headers: Record<string, string>;
	body: Buffer | undefined;
}

function fail(message: string): never {
	throw new SandboxFetchError(`Sandbox HTTP ${message}`);
}

function transportError(cause: unknown): SandboxFetchError {
	if (cause instanceof SandboxFetchError) return cause;
	const code = cause instanceof Error ? Object.getOwnPropertyDescriptor(cause, "code")?.value : undefined;
	const suffix = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` (${code})` : "";
	return new SandboxFetchError(`Sandbox HTTP request failed${suffix}`, { cause });
}

// Data descriptors avoid executing caller-provided getters at this trust boundary.
function fields(input: unknown): Record<string, PropertyDescriptor> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) fail("request must be an object");
	const descriptors = Object.getOwnPropertyDescriptors(input);
	for (const descriptor of Object.values(descriptors)) {
		if (!("value" in descriptor)) fail("request must contain plain data fields");
	}
	return descriptors;
}

function checkedUrl(input: unknown, base?: URL): URL {
	if (typeof input !== "string" || Buffer.byteLength(input) > MAX_URL_BYTES) fail("URL must be a string of at most 8 KiB");
	if (/[\u0000-\u001f\u007f]/.test(input)) fail("URL contains control characters");
	let url: URL;
	try { url = new URL(input, base); } catch { fail("URL is invalid"); }
	if (url.protocol !== "http:" && url.protocol !== "https:") fail("only HTTP and HTTPS URLs are allowed");
	if (url.username || url.password || /^(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}[^\\/?#]*@/i.test(input.trim())) fail("URL credentials are forbidden; use explicit request headers");
	if (Buffer.byteLength(url.href) > MAX_URL_BYTES) fail("URL exceeds 8 KiB");
	url.hash = "";
	return url;
}

function parseRequest(input: unknown): ParsedRequest {
	const data = fields(input);
	if (Object.keys(data).some(key => !["url", "method", "headers", "body"].includes(key))) fail("request contains unknown fields");
	const url = checkedUrl(data.url?.value);
	const methodInput: unknown = data.method?.value === undefined ? "GET" : data.method.value;
	if (typeof methodInput !== "string" || !TOKEN.test(methodInput) || methodInput.length > 64) fail("method must be an HTTP token of at most 64 characters");
	const method = /^(DELETE|GET|HEAD|OPTIONS|POST|PUT)$/i.test(methodInput) ? methodInput.toUpperCase() : methodInput;
	if (method.toUpperCase() === "CONNECT") fail("CONNECT protocol tunnels are forbidden");
	const headers: Record<string, string> = Object.create(null);
	let headerBytes = 0;
	if (data.headers && data.headers.value !== undefined) {
		const entries = fields(data.headers.value);
		if (Object.keys(entries).length > 128) fail("request exceeds 128 headers");
		for (const [name, descriptor] of Object.entries(entries)) {
			const value: unknown = descriptor.value;
			const key = name.toLowerCase();
			if (!TOKEN.test(name) || typeof value !== "string") fail("headers must have valid names and string values");
			if (Object.hasOwn(TRANSPORT_HEADERS, key) || key.startsWith("proxy-")) fail("transport and proxy headers cannot be supplied");
			if (key in headers) fail("duplicate case-insensitive request headers are forbidden");
			try { http.validateHeaderValue(name, value); } catch { fail("header value is invalid"); }
			headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
			if (headerBytes > MAX_HEADER_BYTES) fail("request headers exceed 32 KiB");
			headers[key] = value;
		}
	}
	const bodyInput: unknown = data.body?.value;
	if (bodyInput !== undefined && typeof bodyInput !== "string") fail("body must be a string");
	if (typeof bodyInput === "string" && Buffer.byteLength(bodyInput) > MAX_BODY_BYTES) fail("request body exceeds 1 MiB");
	return { url, method, headers, body: bodyInput === undefined ? undefined : Buffer.from(bodyInput as string) };
}

// IANA special-purpose registry snapshot 2025-10-09; checked against primary sources 2026-11-11:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Translation, tunneling and identifier prefixes are deliberately not HTTP destinations.
const deniedV4 = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.2.0", 24], ["192.88.99.0", 24],
	["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
	["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) deniedV4.addSubnet(address, prefix, "ipv4");
// Azure's platform/metadata virtual IP is numerically public but not a public destination.
deniedV4.addAddress("168.63.129.16", "ipv4");
// All unlisted space in 2000::/3 is reserved, not public. IANA allocation snapshot 2025-10-10:
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/
const allocatedV6 = new BlockList();
for (const [address, prefix] of [
	["2001::", 23], ["2001:200::", 23], ["2001:400::", 23], ["2001:600::", 23],
	["2001:800::", 22], ["2001:c00::", 23], ["2001:e00::", 23], ["2001:1200::", 23],
	["2001:1400::", 22], ["2001:1800::", 23], ["2001:1a00::", 23], ["2001:1c00::", 22],
	["2001:2000::", 19], ["2001:4000::", 23], ["2001:4200::", 23], ["2001:4400::", 23],
	["2001:4600::", 23], ["2001:4800::", 23], ["2001:4a00::", 23], ["2001:4c00::", 23],
	["2001:5000::", 20], ["2001:8000::", 19], ["2001:a000::", 20], ["2001:b000::", 20],
	["2003::", 18], ["2400::", 12], ["2410::", 12], ["2600::", 12], ["2610::", 23],
	["2620::", 23], ["2630::", 12], ["2800::", 12], ["2a00::", 12], ["2a10::", 12], ["2c00::", 12],
] as const) allocatedV6.addSubnet(address, prefix, "ipv6");
const deniedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32]] as const) {
	deniedV6.addSubnet(address, prefix, "ipv6");
}
const publicV6Exceptions = new BlockList();
for (const address of ["2001:1::1", "2001:1::2", "2001:1::3"]) publicV6Exceptions.addAddress(address, "ipv6");
publicV6Exceptions.addSubnet("2001:4:112::", 48, "ipv6");

function globalAddress(address: string): 4 | 6 {
	const family = isIP(address);
	if (family === 4) {
		if (deniedV4.check(address, "ipv4") || (address.startsWith("192.0.0.") && address !== "192.0.0.9" && address !== "192.0.0.10")) fail("destination address is not globally reachable");
		return 4;
	}
	if (family === 6 && !address.includes("%")) {
		if (!allocatedV6.check(address, "ipv6") || (deniedV6.check(address, "ipv6") && !publicV6Exceptions.check(address, "ipv6"))) fail("destination address is not globally reachable");
		// ISATAP embeds an IPv4 destination in the interface identifier, even under a global prefix.
		const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
		const [left, right] = canonical.split("::");
		const start = left ? left.split(":") : [];
		const end = right ? right.split(":") : [];
		const words = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
		if ((Number.parseInt(words[4]!, 16) & ~0x0200) === 0 && Number.parseInt(words[5]!, 16) === 0x5efe) fail("tunnel destination addresses are forbidden");
		return 6;
	}
	fail("destination address is invalid or non-global");
}

function hostnameOf(url: URL): string {
	const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (!hostname || hostname.includes("%")) fail("destination hostname is invalid");
	if (!isIP(hostname) && (hostname === "metadata" || /(?:^|\.)(?:localhost|local|internal|home\.arpa|invalid|test|example|onion)$/.test(hostname))) {
		fail("local and metadata hostnames are forbidden");
	}
	return hostname;
}

function abortError(signal: AbortSignal): SandboxFetchError {
	return signal.reason instanceof SandboxFetchError ? signal.reason : new SandboxFetchError("Sandbox HTTP request cancelled");
}

async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw abortError(signal);
	const cancelled = Promise.withResolvers<never>();
	const abort = () => cancelled.reject(abortError(signal));
	signal.addEventListener("abort", abort, { once: true });
	try { return await Promise.race([promise, cancelled.promise]); }
	finally { signal.removeEventListener("abort", abort); }
}

async function resolveDestination(url: URL, resolver: Resolver, signal: AbortSignal): Promise<{ hostname: string; addresses: LookupAddress[] }> {
	const hostname = hostnameOf(url);
	if (isIP(hostname)) return { hostname, addresses: [{ address: hostname, family: globalAddress(hostname) }] };
	const results = await cancellable(Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]), signal);
	const addresses: LookupAddress[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") {
			// Validate the entire answer before allowing any connection, including secondary records.
			for (const address of result.value) addresses.push({ address, family: globalAddress(address) });
		} else if (!["ENODATA", "ENOTFOUND"].includes(result.reason?.code)) throw new SandboxFetchError("Sandbox HTTP DNS resolution failed", { cause: result.reason });
	}
	if (!addresses.length) fail("DNS resolution found no destination addresses");
	return { hostname, addresses };
}

async function responseBody(response: http.IncomingMessage, signal: AbortSignal, maxBytes: number): Promise<string> {
	const limit = `${maxBytes / (1024 * 1024)} MiB`;
	const contentLength = response.headers["content-length"];
	if (contentLength && Number(contentLength) > maxBytes) fail(`response body exceeds ${limit}`);
	const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
	let decoder: Transform | undefined;
	if (encoding && encoding !== "identity") {
		if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
		else if (encoding === "deflate") decoder = createInflate();
		else if (encoding === "br") decoder = createBrotliDecompress();
		else fail("response content encoding is unsupported");
	}
	const pending = Promise.withResolvers<string>();
	const chunks: Buffer[] = [];
	let wireBytes = 0;
	let decodedBytes = 0;
	const rejectTransport = (error: unknown) => {
		pending.reject(transportError(error));
		response.destroy(); decoder?.destroy();
	};
	const boundWire = (chunk: Buffer) => {
		wireBytes += chunk.length;
		if (wireBytes > maxBytes) rejectTransport(new SandboxFetchError(`Sandbox HTTP response body exceeds ${limit}`));
	};
	const collect = (chunk: Buffer) => {
		decodedBytes += chunk.length;
		if (decodedBytes > maxBytes) rejectTransport(new SandboxFetchError(`Sandbox HTTP decoded response body exceeds ${limit}`));
		else chunks.push(chunk);
	};
	const ended = () => {
		if (!response.complete) { rejectTransport(new Error("HTTP response ended before message completion")); return; }
		try {
			const body = decodeBody(Buffer.concat(chunks, decodedBytes), response.headers["content-type"] ?? "");
			if (Buffer.byteLength(body) > maxBytes) fail(`UTF-8 response text exceeds ${limit}`);
			pending.resolve(body);
		} catch (error) { pending.reject(error); }
	};
	const disconnected = () => {
		if (!response.complete) rejectTransport(new Error("HTTP response connection closed before message completion"));
	};
	const abort = () => rejectTransport(abortError(signal));
	const stream = decoder ?? response;
	const socket = response.socket;
	response.on("data", boundWire);
	response.on("error", rejectTransport);
	response.on("aborted", disconnected);
	response.on("close", disconnected);
	socket?.on("end", disconnected);
	socket?.on("close", disconnected);
	stream.on("data", collect);
	stream.on("end", ended);
	if (decoder) decoder.on("error", rejectTransport);
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (signal.aborted) abort();
		// The header promise handoff can occur after native disconnect events; fail from state too.
		else if (!response.complete && (response.aborted || response.closed || response.destroyed || socket?.destroyed)) disconnected();
		else if (decoder) response.pipe(decoder);
		return await pending.promise;
	} finally {
		signal.removeEventListener("abort", abort);
		response.removeListener("data", boundWire);
		response.removeListener("aborted", disconnected);
		response.removeListener("close", disconnected);
		socket?.removeListener("end", disconnected);
		socket?.removeListener("close", disconnected);
		stream.removeListener("data", collect);
		stream.removeListener("end", ended);
		// Destroyed streams may still emit a queued error before close; keep its owned handler until then.
		if (response.closed) response.removeListener("error", rejectTransport);
		else response.once("close", () => response.removeListener("error", rejectTransport));
		if (decoder) {
			if (decoder.closed) decoder.removeListener("error", rejectTransport);
			else decoder.once("close", () => decoder.removeListener("error", rejectTransport));
		}
		decoder?.destroy(); response.destroy();
	}
}

async function requestHop(input: ParsedRequest, resolver: Resolver, signal: AbortSignal, maxBytes: number): Promise<{ response: SandboxFetchResponse; location?: string }> {
	const { hostname, addresses } = await resolveDestination(input.url, resolver, signal);
	if (signal.aborted) throw abortError(signal);
	const secure = input.url.protocol === "https:";
	// Never use global agents, fetch wrappers, proxy settings, a Cookie jar, or client credentials.
	const agent = secure ? new https.Agent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: true }) : new http.Agent({ keepAlive: false, maxSockets: 1 });
	// Node races only this validated snapshot; no second DNS lookup and no replay of HTTP data.
	const lookup: LookupFunction = (_hostname, options, callback) => {
		if (options.all) callback(null, addresses);
		else callback(null, addresses[0]!.address, addresses[0]!.family);
	};
	let request: http.ClientRequest | undefined;
	let incoming: http.IncomingMessage | undefined;
	try {
		const pending = Promise.withResolvers<http.IncomingMessage>();
		try {
			const options: PinnedRequestOptions = {
				protocol: input.url.protocol, hostname, port: input.url.port || undefined,
				path: input.url.pathname + input.url.search, method: input.method,
				headers: { "user-agent": BROWSER_USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-encoding": "identity", ...input.headers, ...(input.body === undefined ? {} : { "content-length": String(input.body.length) }) }, agent, lookup,
				autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250, signal, maxHeaderSize: MAX_HEADER_BYTES,
				rejectUnauthorized: true, servername: secure && !isIP(hostname) ? hostname : undefined,
			};
			request = secure ? https.request(options, pending.resolve) : http.request(options, pending.resolve);
		} catch (error) {
			if (error instanceof Error && !(error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) && typeof Object.getOwnPropertyDescriptor(error, "code")?.value === "string") throw transportError(error);
			throw error;
		}
		request.on("error", error => pending.reject(transportError(error)));
		const switched = (response: http.IncomingMessage, socket: Duplex) => {
			response.destroy(); socket.destroy(); pending.reject(new SandboxFetchError("Sandbox HTTP protocol switching and tunnels are forbidden"));
		};
		request.on("upgrade", switched);
		request.on("connect", switched);
		request.end(input.body);
		incoming = await pending.promise;
		if (signal.aborted) throw abortError(signal);
		const headers: Record<string, string> = Object.create(null);
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
		}
		const status = incoming.statusCode;
		if (status === undefined) fail("response has no status");
		const location = REDIRECT_STATUSES.has(status) ? incoming.headers.location : undefined;
		// HEAD and no-content statuses carry representation metadata, not a response body.
		const bodyless = input.method === "HEAD" || status < 200 || status === 204 || status === 205 || status === 304;
		const body = location === undefined && !bodyless ? await responseBody(incoming, signal, maxBytes) : "";
		return { response: { url: input.url.href, status, headers, body }, location };
	} finally {
		incoming?.destroy();
		request?.destroy();
		agent.destroy();
	}
}

/** Submit explicit data to a public HTTP(S) destination; no ambient host network credentials. */
export async function sandboxFetch(input: unknown, signal?: AbortSignal): Promise<SandboxFetchResponse> {
	return fetchPublicRequest(input, signal, MAX_BODY_BYTES, false);
}

async function fetchPublicRequest(input: unknown, signal: AbortSignal | undefined, maxBytes: number, reader: boolean): Promise<SandboxFetchResponse & { format?: "markdown" | "text"; truncated?: boolean }> {
	const controller = new AbortController();
	const cancel = () => controller.abort(new SandboxFetchError("Sandbox HTTP request cancelled"));
	const timer = setTimeout(() => controller.abort(new SandboxFetchError("Sandbox HTTP 30 second deadline exceeded")), DEADLINE_MS);
	const resolver = new Resolver();
	const cancelDns = () => resolver.cancel();
	controller.signal.addEventListener("abort", cancelDns, { once: true });
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		if (signal?.aborted) cancel();
		if (controller.signal.aborted) throw abortError(controller.signal);
		let request = parseRequest(input);
		for (let redirects = 0; ; redirects++) {
			const { response, location } = await requestHop(request, resolver, controller.signal, maxBytes);
			if (location === undefined) {
				if (!reader) return response;
				const html = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(response.headers["content-type"] ?? "");
				let body = response.body;
				if (html && body) {
					try { body = await cancellable(htmlToMarkdown(body, { cleanContent: true, hiddenContent: "reachable", skipImages: true }), controller.signal); }
					catch (cause) {
						if (controller.signal.aborted) throw abortError(controller.signal);
						throw new SandboxFetchError("Sandbox HTTP HTML conversion failed; use raw: true to inspect the source", { cause });
					}
				}
				return { ...response, body: body.slice(0, MAX_READER_CHARS), format: html ? "markdown" : "text", truncated: body.length > MAX_READER_CHARS };
			}
			if (redirects >= MAX_REDIRECTS) fail("redirect limit of 5 exceeded");
			const url = checkedUrl(location, request.url);
			const headers = url.origin === request.url.origin ? { ...request.headers } : Object.create(null) as Record<string, string>;
			let { method, body } = request;
			if (((response.status === 301 || response.status === 302) && method === "POST") || (response.status === 303 && method !== "GET" && method !== "HEAD")) {
				method = "GET"; body = undefined;
				for (const header of BODY_HEADERS) delete headers[header];
			}
			request = { url, method, headers, body };
		}
	} catch (error) {
		if (controller.signal.aborted) throw abortError(controller.signal);
		if (error instanceof SandboxFetchError) throw error;
		// All external event failures are normalized at their DNS/HTTP/body boundary.
		// Anything else is an unexpected internal failure, not a public tool error.
		throw new Error("Sandbox HTTP operation failed", { cause: error });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		controller.signal.removeEventListener("abort", cancelDns);
		resolver.cancel();
	}
}

export function sandboxFetchTool(): ToolDefinition {
	return {
		name: "sandbox_fetch",
		label: "Fetch public HTTP URL",
		description: sandboxFetchDescription,
		parameters: arkType({ url: "string", "method?": "string", "headers?": { "[string]": "string" }, "body?": "string", "raw?": "boolean" }),
		execute: async (_id, input, signal) => {
			try {
				const data = fields(input);
				const raw: unknown = data.raw?.value;
				if (raw !== undefined && typeof raw !== "boolean") fail("raw must be a boolean");
				const request: Record<string, unknown> = Object.create(null);
				for (const [name, descriptor] of Object.entries(data)) if (name !== "raw") request[name] = descriptor.value;
				const response = await fetchPublicRequest(request, signal, raw ? MAX_BODY_BYTES : MAX_READER_BYTES, !raw);
				return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
			} catch (error) {
				if (error instanceof SandboxFetchError) return { content: [{ type: "text", text: error.message }], details: {}, isError: true };
				throw new Error("Sandbox HTTP tool operation failed", { cause: error });
			}
		},
	};
}
