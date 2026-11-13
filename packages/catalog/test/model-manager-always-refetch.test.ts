/**
 * `alwaysRefetchDynamicModels` contract: providers whose dynamic result
 * encodes fast-changing live state (factory-droid's serving-region filtering)
 * must not have a TTL-fresh cache replayed at them — the fetch runs on every
 * online-eligible refresh, with the cache kept only for offline/failure
 * fallback. An explicit "offline" strategy still serves the cache untouched.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { syntheticModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function payload(id: string) {
	return {
		data: [
			{
				id,
				object: "model",
				name: id,
				input_modalities: ["text"],
				context_length: 128000,
				max_output_length: 8192,
				supported_features: ["tools"],
				pricing: { prompt: "$0.000001", completion: "$0.000002" },
			},
		],
	};
}

describe("alwaysRefetchDynamicModels", () => {
	it("replays a fresh cache under online-if-uncached without the option, refetches with it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "always-refetch-"));
		try {
			let served = "syn:first";
			const fetchMock = vi.fn(
				async () =>
					new Response(JSON.stringify(payload(served)), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);

			// Baseline: without the option a fresh authoritative cache satisfies the refresh.
			const baseline = createModelManager({
				...syntheticModelManagerOptions({ apiKey: "cache-test-key", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "baseline.db"),
			});
			await baseline.refresh("online");
			const seededCalls = fetchMock.mock.calls.length;
			const cached = await baseline.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBe(seededCalls);
			expect(cached.models.some(m => m.id === "syn:first")).toBe(true);

			// With the option the fetcher runs again and the new payload wins.
			const refetching = createModelManager({
				...syntheticModelManagerOptions({ apiKey: "cache-test-key", fetch: fetchMock }),
				alwaysRefetchDynamicModels: true,
				cacheDbPath: path.join(tempDir, "refetch.db"),
			});
			await refetching.refresh("online");
			const afterSeed = fetchMock.mock.calls.length;
			served = "syn:second";
			const fresh = await refetching.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBeGreaterThan(afterSeed);
			expect(fresh.models.some(m => m.id === "syn:second")).toBe(true);

			// Explicit offline still serves the cache without touching the network.
			const beforeOffline = fetchMock.mock.calls.length;
			const offline = await refetching.refresh("offline");
			expect(fetchMock.mock.calls.length).toBe(beforeOffline);
			expect(offline.models.some(m => m.id === "syn:second")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("cacheScope", () => {
	it("refreshes changed discovery inputs while retaining the same row as an offline and failure fallback", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-cache-scope-"));
		try {
			let served = "syn:old-account";
			let unavailable = false;
			const fetchMock = vi.fn(async () => {
				if (unavailable) throw new Error("synthetic discovery outage");
				return Response.json(payload(served));
			});
			const options = {
				...syntheticModelManagerOptions({ apiKey: "scope-test-key", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "models.db"),
			};
			const original = createModelManager({ ...options, cacheScope: "account-a" });
			await original.refresh("online");
			const initialCalls = fetchMock.mock.calls.length;
			await original.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBe(initialCalls);

			const changed = createModelManager({ ...options, cacheScope: "accounts-a-b" });
			const offline = await changed.refresh("offline");
			expect(offline.models.some(model => model.id === "syn:old-account")).toBe(true);
			expect(offline.stale).toBe(true);
			expect(fetchMock.mock.calls.length).toBe(initialCalls);

			served = "syn:new-account";
			const fresh = await changed.refresh("online-if-uncached");
			expect(fresh.models.some(model => model.id === "syn:new-account")).toBe(true);
			expect(fresh.models.some(model => model.id === "syn:old-account")).toBe(false);
			const refreshedCalls = fetchMock.mock.calls.length;
			expect(refreshedCalls).toBeGreaterThan(initialCalls);
			await changed.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBe(refreshedCalls);

			unavailable = true;
			const failed = await createModelManager({ ...options, cacheScope: "account-b" }).refresh("online-if-uncached");
			expect(failed.models.some(model => model.id === "syn:new-account")).toBe(true);
			expect(failed.stale).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
