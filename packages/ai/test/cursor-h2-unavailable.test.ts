import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface TransportTurn {
	stopReason: string;
	starts: number;
	text: string;
	connections: number;
	tunnels: number;
	opens: number;
	faultAttempts: number;
}

/** Keep HTTP/2 interception, proxy policy, and the TTL clock out of other provider tests. */
async function fixture(
	scenario: string,
): Promise<{ turns: TransportTurn[]; originalRequestIds: string[]; secondEndpointOpens?: number }> {
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "fixtures/cursor-h2-unavailable.ts"), scenario],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				HTTP_PROXY: "",
				HTTPS_PROXY: "",
				ALL_PROXY: "",
				NO_PROXY: "",
				http_proxy: "",
				https_proxy: "",
				all_proxy: "",
				no_proxy: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`Cursor transport fixture ${scenario} exited ${exitCode}: ${stderr}`);
		return JSON.parse(stdout);
	} finally {
		child.kill();
	}
}

describe("Cursor HTTP/2 unavailable fallback", () => {
	it("caches a successful TLS-reset fallback per endpoint for ten minutes", async () => {
		const { turns, secondEndpointOpens } = await fixture("cache");
		expect(turns.map(turn => turn.stopReason)).toEqual(["stop", "stop", "stop", "stop"]);
		expect(turns.map(turn => turn.starts)).toEqual([1, 1, 1, 1]);
		expect(turns.map(turn => turn.text)).toEqual(["http1 ok", "http1 ok", "http1 ok", "http1 ok"]);
		expect(turns[0].connections).toBeGreaterThan(0);
		expect(turns[1].connections).toBe(turns[0].connections);
		expect(turns[2].connections).toBeGreaterThan(turns[1].connections);
		expect(turns[3].connections).toBeGreaterThan(turns[2].connections);
		expect(turns[3].opens).toBe(3);
		expect(secondEndpointOpens).toBe(1);
	}, 10_000);

	it("falls back before run state exists through the real Node CONNECT proxy path, emitting one start", async () => {
		const { turns, originalRequestIds } = await fixture("proxy");
		expect(turns.map(turn => turn.stopReason)).toEqual(["stop", "stop"]);
		expect(turns.map(turn => turn.starts)).toEqual([1, 1]);
		expect(turns[0].tunnels).toBeGreaterThan(0);
		expect(turns[1].tunnels).toBe(turns[0].tunnels);
		expect(originalRequestIds[0]).not.toBe("");
		expect(originalRequestIds[1]).toBe("");
		expect(turns[1].opens).toBe(2);
	}, 10_000);

	for (const scenario of ["failed", "alpn-failed"]) {
		it(`does not cache HTTP/2 unavailability when ${scenario} RunSSE fallback fails`, async () => {
			const { turns } = await fixture(scenario);
			expect(turns.map(turn => turn.stopReason)).toEqual(["error", "error"]);
			expect(turns.map(turn => turn.starts)).toEqual([1, 1]);
			expect(turns[1].opens).toBeGreaterThan(turns[0].opens);
			if (scenario === "failed") expect(turns[1].connections).toBeGreaterThan(turns[0].connections);
			else expect(turns[1].faultAttempts).toBeGreaterThan(turns[0].faultAttempts);
		}, 10_000);
	}

	it("keeps forced HTTP/2 forced even after a successful fallback cached the endpoint", async () => {
		const { turns } = await fixture("forced");
		expect(turns.map(turn => turn.stopReason)).toEqual(["stop", "error"]);
		expect(turns.map(turn => turn.starts)).toEqual([1, 1]);
		expect(turns[1].connections).toBeGreaterThan(turns[0].connections);
		expect(turns[1].opens).toBe(1);
	}, 10_000);

	it("keeps a non-handshake ECONNRESET an error and never starts RunSSE", async () => {
		const { turns } = await fixture("non-handshake");
		expect(turns.map(turn => turn.stopReason)).toEqual(["error", "error"]);
		expect(turns.map(turn => turn.starts)).toEqual([1, 1]);
		expect(turns.map(turn => turn.opens)).toEqual([0, 0]);
		expect(turns[1].faultAttempts).toBeGreaterThan(turns[0].faultAttempts);
	}, 10_000);
});
