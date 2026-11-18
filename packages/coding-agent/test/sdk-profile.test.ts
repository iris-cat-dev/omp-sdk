import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import type { ExecResult } from "@oh-my-pi/pi-utils/ptree";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { embed } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadMnemopiConfig } from "../src/mnemopi/config";
import { MnemopiEmbedClient } from "../src/mnemopi/embed-client";
import { ensureSmolLmWeights } from "../src/predict/smollm-weights";
import { initializeNodeSdkProfile } from "../src/sdk-profile";
import { AuthStorage } from "../src/session/auth-storage";
import { SttClient } from "../src/stt/asr-client";
import { downloadSttModel, isSttModelCached } from "../src/stt/downloader";
import { TinyTitleClient } from "../src/tiny/title-client";
import * as titleClient from "../src/tiny/title-client";
import { TtsClient } from "../src/tts/tts-client";
import { TinyTitleClient as OriginalTinyTitleClient } from "../src/tiny/_title-client";
import { TtsClient as OriginalTtsClient } from "../src/tts/_tts-client";
import { SttClient as OriginalSttClient } from "../src/stt/_asr-client";
import { MnemopiEmbedClient as OriginalMnemopiEmbedClient } from "../src/mnemopi/_embed-client";
import type { TinyChatMessage, TinyWorkerRequest, TinyWorkerResponse } from "../src/tiny/title-protocol";
import type { MnemopiEmbedModelId } from "../src/mnemopi/embed-protocol";
import type { RefCountedWorkerHandle } from "../src/subprocess/worker-client";
import type { TtsWorkerInbound, TtsWorkerOutbound } from "../src/tts/tts-protocol";

describe("loaded Node SDK profile", () => {
	let directory: TempDir;

	async function select(profile?: "core" | "full"): Promise<void> {
		await Bun.write(
			path.join(directory.path(), "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", ...(profile ? { ompNodeSdk: { profile } } : {}) }),
		);
		initializeNodeSdkProfile(pathToFileURL(path.join(directory.path(), "dist", "node", "sdk.mjs")).href);
	}

	async function runCompiledCore(): Promise<ExecResult> {
		const outDir = path.join(directory.path(), "dist", "node");
		const result = await Bun.build({
			entrypoints: [fileURLToPath(new URL("../src/sdk-profile.ts", import.meta.url))],
			outdir: outDir,
			naming: "profile.mjs",
			target: "node",
			format: "esm",
			define: { __OMP_CORE_SDK__: "true" },
		});
		if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
		const entryUrl = pathToFileURL(path.join(outDir, "profile.mjs")).href;
		return ptree.exec(
			[
				"node",
				"--input-type=module",
				"-e",
				`import { initializeNodeSdkProfile, isCoreSdk, assertLocalRuntimeAvailable } from ${JSON.stringify(entryUrl)};
			initializeNodeSdkProfile(${JSON.stringify(entryUrl)});
			let disabledError;
			try { assertLocalRuntimeAvailable("Offline speech recognition"); }
			catch (error) { disabledError = error.message; }
			console.log(JSON.stringify({ core: isCoreSdk(), disabledError }));`,
			],
			{ cwd: directory.path(), timeout: 15_000, allowNonZero: true },
		);
	}

	beforeEach(async () => {
		directory = TempDir.createSync("@sdk-profile-");
		await fs.mkdir(path.join(directory.path(), "dist", "node"), { recursive: true });
	});

	afterEach(async () => {
		initializeNodeSdkProfile(import.meta.url);
		await directory.remove();
	});

	test("local model discovery follows the loaded profile and returns after switching back to full", async () => {
		const auth = await AuthStorage.create(":memory:");
		const registry = () => new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
		try {
			await select();
			expect(registry().find("local", "kokoro")?.api).toBe("local-inference");
			await select("core");
			const core = registry();
			expect(core.getAll("all").some(model => model.api === "local-inference")).toBe(false);
			expect(core.getAll("all").some(model => model.api === "openai-speech")).toBe(true);
			expect(core.find("local", "kokoro")).toBeUndefined();
			await select("full");
			expect(registry().find("local", "kokoro")?.api).toBe("local-inference");
		} finally {
			auth.close();
		}
	});

	test("full/source exports preserve the original constructors and consumer subclass calls", async () => {
		await select("full");
		expect(TinyTitleClient).toBe(OriginalTinyTitleClient);
		expect(TtsClient).toBe(OriginalTtsClient);
		expect(SttClient).toBe(OriginalSttClient);
		expect(MnemopiEmbedClient).toBe(OriginalMnemopiEmbedClient);
		const messages: Array<readonly TinyChatMessage[]> = [];
		class ConsumerTinyClient extends TinyTitleClient {
			override async chat(_model: string, input: readonly TinyChatMessage[]): Promise<string> {
				messages.push(input);
				return "consumer completion";
			}
		}
		const client = new ConsumerTinyClient();
		try {
			expect(client instanceof TinyTitleClient).toBe(true);
			expect(client instanceof OriginalTinyTitleClient).toBe(true);
			expect(await client.complete("qwen3-1.7b", "consumer prompt", { systemPrompt: "consumer system" })).toBe(
				"consumer completion",
			);
			expect(messages).toEqual([
				[
					{ role: "system", content: "consumer system" },
					{ role: "user", content: "consumer prompt" },
				],
			]);
		} finally {
			await client.terminate();
		}
	});

	test("full client uses live public helper bindings for its real request lifecycle", async () => {
		await select("full");
		const handlers = new Set<(message: TinyWorkerResponse) => void>();
		let workerClosed = false;
		const worker: RefCountedWorkerHandle<TinyWorkerRequest, TinyWorkerResponse> = {
			send(message) {
				if (message.type === "chat")
					queueMicrotask(() => {
						for (const handler of handlers)
							handler({ type: "text", id: message.id, text: "public helper reply" });
					});
			},
			onMessage(handler) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
			onError() {
				return () => {};
			},
			async terminate() {
				workerClosed = true;
			},
			ref() {},
			unref() {},
		};
		const usesMlx = spyOn(titleClient, "tinyWorkerUsesMlx").mockReturnValue(false);
		const connect = spyOn(titleClient, "connectTinyWorker").mockResolvedValue(worker);
		const client = new titleClient.TinyTitleClient();
		try {
			expect(await client.complete("qwen3-1.7b", "public helper request")).toBe("public helper reply");
			expect(usesMlx).toHaveBeenCalledTimes(1);
			expect(connect).toHaveBeenCalledTimes(1);
			await client.terminate();
			expect(workerClosed).toBe(true);
		} finally {
			await client.terminate();
			connect.mockRestore();
			usesMlx.mockRestore();
		}
	});

	test("full embedding initialization and streaming use the consumer's load/embed overrides", async () => {
		await select("full");
		let loads = 0;
		class ConsumerEmbedClient extends MnemopiEmbedClient {
			override async load(_model: MnemopiEmbedModelId, _cacheDir: string | undefined): Promise<undefined> {
				loads++;
				return undefined;
			}
			override async embed(
				_model: MnemopiEmbedModelId,
				_cacheDir: string | undefined,
				texts: string[],
				_batchSize: number | undefined,
			): Promise<number[][]> {
				return texts.map(text => [text.length]);
			}
		}
		const client = new ConsumerEmbedClient();
		try {
			const model = await client.initialize("fast-bge-base-en-v1.5", directory.path());
			expect(loads).toBe(1);
			if (!model) throw new Error("Consumer embedding initializer was not used");
			const batches: number[][][] = [];
			for await (const batch of model.embed(["first", "second"])) batches.push(batch);
			expect(batches).toEqual([[[5], [6]]]);
			expect(client instanceof OriginalMnemopiEmbedClient).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	test("full synthesis worker failures dispatch through the consumer's terminate override", async () => {
		await select("full");
		const handlers = new Set<(message: TtsWorkerOutbound) => void>();
		let workerClosed = false;
		const worker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> = {
			send(message) {
				if (message.type === "synthesize")
					queueMicrotask(() => {
						for (const handler of handlers)
							handler({ type: "error", id: message.id, error: "consumer worker failure" });
					});
			},
			onMessage(handler) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
			onError() {
				return () => {};
			},
			async terminate() {
				workerClosed = true;
			},
			ref() {},
			unref() {},
		};
		let consumerClosed = false;
		class ConsumerTtsClient extends TtsClient {
			override async terminate(): Promise<void> {
				consumerClosed = true;
				await super.terminate();
			}
		}
		const client = new ConsumerTtsClient(() => worker);
		try {
			expect(await client.synthesize("kokoro", "consumer speech")).toBeNull();
			expect(consumerClosed).toBe(true);
			expect(workerClosed).toBe(true);
			expect(client instanceof OriginalTtsClient).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	test("compiled core runs from an unmarked source package and still rejects offline operations", async () => {
		await select();
		const result = await runCompiledCore();
		expect(result.exitCode, result.stderr).toBe(0);
		const observed = JSON.parse(result.stdout);
		expect(observed.core).toBe(true);
		expect(observed.disabledError).toMatch(/core Node SDK profile.*remote.*full SDK profile/);
	});

	test("compiled core refuses an explicitly installed full profile", async () => {
		await select("full");
		const result = await runCompiledCore();
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Node SDK profile mismatch: built core, installed full");
		expect(result.stdout).toBe("");
	});

	test("core rejects offline operations before any worker or download", async () => {
		await select("core");
		const unsupported = /core Node SDK profile.*remote.*full SDK profile/;
		await expect(new TinyTitleClient().chat("lfm2.5-350m", [])).rejects.toThrow(unsupported);
		await expect(new TinyTitleClient().downloadModel("lfm2.5-350m")).rejects.toThrow(unsupported);
		await expect(new TtsClient().synthesize("kokoro", "hello")).rejects.toThrow(unsupported);
		await expect(new TtsClient().downloadModel("kokoro")).rejects.toThrow(unsupported);
		await expect(new SttClient().transcribe("whisper-base", new Float32Array())).rejects.toThrow(unsupported);
		expect(() => new SttClient().startStream("whisper-base")).toThrow(unsupported);
		expect(() => new TtsClient().synthesizeStream("kokoro")).toThrow(unsupported);
		await expect(downloadSttModel("whisper-base")).rejects.toThrow(unsupported);
		expect(await isSttModelCached("whisper-base")).toBe(false);
		await expect(new MnemopiEmbedClient().load("fast-bge-base-en-v1.5", undefined)).rejects.toThrow(unsupported);
		await expect(ensureSmolLmWeights()).rejects.toThrow(unsupported);
	});

	test("core rejects memory configurations that would load excluded local runtimes", async () => {
		await select("core");
		expect(() => loadMnemopiConfig(Settings.isolated({}), directory.path())).toThrow(/embeddingApiUrl/);
		expect(() =>
			loadMnemopiConfig(
				Settings.isolated({ "mnemopi.embeddingApiUrl": "https://embeddings.example/v1" }),
				directory.path(),
			),
		).toThrow(/mnemopi.llmMode/);
	});

	test("core preserves explicitly configured remote and keyword-only memory", async () => {
		await select("core");
		const keyword = loadMnemopiConfig(
			Settings.isolated({ "mnemopi.scoping": "global", "mnemopi.noEmbeddings": true, "mnemopi.llmMode": "none" }),
			directory.path(),
		);
		expect(keyword.providerOptions.noEmbeddings).toBe(true);
		expect(keyword.llmMode).toBe("none");
		const remote = loadMnemopiConfig(
			Settings.isolated({
				"mnemopi.scoping": "global",
				"mnemopi.embeddingApiUrl": "https://embeddings.example/v1",
				"mnemopi.embeddingModel": "openai/text-embedding-3-small",
				"mnemopi.llmMode": "remote",
				"mnemopi.llmBaseUrl": "https://models.example/v1",
				"mnemopi.llmModel": "remote-memory-model",
			}),
			directory.path(),
		);
		expect(remote.providerOptions.embeddingApiUrl).toBe("https://embeddings.example/v1");
		expect(remote.llmModel).toBe("remote-memory-model");
	});

	test("core remote speech and embeddings execute their HTTP transports", async () => {
		await select("core");
		const requests: Array<{ pathname: string; body: unknown }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				requests.push({ pathname, body: await request.json() });
				return pathname === "/v1/embeddings"
					? Response.json({ data: [{ embedding: [0.25, 0.5, 0.75] }] })
					: new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
			},
		});
		try {
			const model = getBundledModel("deepinfra", "hexgrad/Kokoro-82M");
			if (!model) throw new Error("Missing bundled remote speech model");
			const baseUrl = `${server.url.origin}/v1`;
			const speech = await synthesizeSpeech(
				{ ...model, baseUrl },
				{ text: "Core cloud speech", voice: "sky", format: "mp3" },
				{ apiKey: "profile-test" },
			);
			expect([...speech.audio]).toEqual([1, 2, 3]);
			const vectors = await withMnemopiRuntimeOptions(
				{ embeddings: { model: "openai/text-embedding-3-small", apiUrl: baseUrl, apiKey: "profile-test" } },
				() => embed(["Core cloud embeddings"]),
			);
			expect(vectors?.map(vector => [...vector])).toEqual([[0.25, 0.5, 0.75]]);
			expect(requests).toEqual([
				{
					pathname: "/v1/audio/speech",
					body: { model: model.id, input: "Core cloud speech", response_format: "mp3", voice: "sky" },
				},
				{
					pathname: "/v1/embeddings",
					body: { model: "openai/text-embedding-3-small", input: ["Core cloud embeddings"] },
				},
			]);
		} finally {
			await server.stop(true);
		}
	});
});
