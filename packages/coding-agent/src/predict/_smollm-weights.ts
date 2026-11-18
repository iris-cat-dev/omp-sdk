import { runtime } from "@oh-my-pi/pi-utils/runtime";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import { withDownload } from "../downloads/activity";
import { assertLocalRuntimeAvailable, isCoreSdk } from "../sdk-profile";
import { assertNativeCapability, readNativeCapabilities } from "../native-capabilities";
import { sha256File } from "../utils/file-hash";
import { downloadFile } from "../utils/tools-manager";
import { getSmolLmModelDir, SMOLLM_FILES, SMOLLM_LABEL, SMOLLM_TOTAL_BYTES, type WeightFile } from "./smollm-model";

export { getSmolLmModelDir, SMOLLM_LABEL, SMOLLM_TOTAL_BYTES } from "./smollm-model";

/**
 * On-demand weights for the `smollm` word-completion engine
 * (`pi_predict::smollm`): the SmolLM2-135M base checkpoint (Apache-2.0), every
 * file pinned to one repo revision and verified by size and SHA-256.
 *
 * Format: `config.json` and `tokenizer.json` from the upstream repo, and the
 * weights as llama.cpp's `Q8_0` GGUF export (145 MB; 32 weights per 8-bit
 * block with an f16 scale) from QuantFactory/SmolLM2-135M-GGUF, which both
 * decoders run as stored. Provenance, checked against the upstream bf16
 * `model.safetensors` (269 MB): every `Q8_0` block is byte-identical to
 * quantizing it (after llama.cpp's q/k row permutation, which the loader
 * undoes) and the F32 norms are equal, so replay quality matches the bf16
 * research runs.
 *
 * Layout follows the tiny-model cache: `<tiny-models>/predict/<org>--<name>/`,
 * a cross-process install lock next to it, `.part` downloads renamed into
 * place, and a ready marker listing the pinned digests so a warm start is one
 * read and an install of other files (e.g. the bf16 weights) reads as not ready.
 *
 * Only interactive processes download (the composer on first use through
 * {@link prefetchSmolLmWeights}, shown in the download HUD, or
 * `omp tiny-models download smollm`); the prediction daemon just checks
 * {@link smolLmWeightsReady} and serves ngram until then.
 */

const HF_RESOLVE_BASE = "https://huggingface.co";
const READY_MARKER = ".omp-ready";
/** Whole-file transfer bound; the GGUF is 145 MB. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** Files of earlier installs, removed once the current set is in place. */
const OBSOLETE_FILES = ["model.safetensors"];

/** Ready-marker content: changes whenever a pinned file does. */
const READY_STAMP = SMOLLM_FILES.map(file => `${file.name} ${file.sha256}`).join("\n");

async function readReadyMarker(dir: string): Promise<string | null> {
	try {
		return (await runtime.file(path.join(dir, READY_MARKER)).text()).trim();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function hasVerifiedFile(filePath: string, file: WeightFile): Promise<boolean> {
	try {
		if ((await fs.stat(filePath)).size !== file.size) return false;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	return (await sha256File(filePath)) === file.sha256;
}

async function fetchVerified(
	dir: string,
	file: WeightFile,
	signal: AbortSignal | undefined,
	onBytes: (loaded: number) => void,
): Promise<void> {
	const target = path.join(dir, file.name);
	if (await hasVerifiedFile(target, file)) return;
	const part = `${target}.part`;
	const url = `${HF_RESOLVE_BASE}/${file.repo}/resolve/${file.revision}/${file.name}`;
	const startedAt = performance.now();
	logger.debug("smollm weights: downloading", { url, bytes: file.size });
	try {
		await downloadFile(url, part, { signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, onProgress: onBytes });
		const { size } = await fs.stat(part);
		if (size !== file.size) throw new Error(`${file.name}: expected ${file.size} bytes, received ${size}`);
		const digest = await sha256File(part);
		if (digest !== file.sha256) throw new Error(`${file.name}: SHA-256 mismatch (${digest})`);
		// Rename, never rewrite in place: a running engine may have the old file mapped.
		await fs.rename(part, target);
	} catch (error) {
		await fs.rm(part, { force: true });
		throw error;
	}
	logger.debug("smollm weights: downloaded", {
		file: file.name,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
}

/** Whether the pinned weights are fully downloaded and verified (one small file read). */
export async function smolLmWeightsReady(): Promise<boolean> {
	if (isCoreSdk() || !readNativeCapabilities().localAssistance || !readNativeCapabilities().smollm) return false;
	return (await readReadyMarker(getSmolLmModelDir())) === READY_STAMP;
}

/** Options for {@link ensureSmolLmWeights}. */
export interface EnsureSmolLmWeightsOptions {
	signal?: AbortSignal;
	/** Bytes present so far out of {@link SMOLLM_TOTAL_BYTES}, and the file being fetched. */
	onProgress?: (loaded: number, file: string) => void;
}

/**
 * Ensure the pinned SmolLM2-135M files are present and verified, downloading
 * any that are missing or corrupt, and return the model directory to pass as
 * `TextPredictorOptions.modelDir`. Cross-process safe via an OS file lock.
 *
 * @throws when a download fails, is aborted through `signal`, or does not
 * match the pinned size/digest.
 */
export async function ensureSmolLmWeights(options: EnsureSmolLmWeightsOptions = {}): Promise<string> {
	assertLocalRuntimeAvailable("SmolLM word completion");
	assertNativeCapability("localAssistance", "SmolLM word completion");
	assertNativeCapability("smollm", "SmolLM word completion (choose ngram or apple instead)");
	const { signal, onProgress } = options;
	const dir = getSmolLmModelDir();
	if ((await readReadyMarker(dir)) === READY_STAMP) return dir;
	await fs.mkdir(dir, { recursive: true });
	return withFileLock(`${dir}.install`, async () => {
		if ((await readReadyMarker(dir)) === READY_STAMP) return dir;
		let finished = 0;
		for (const file of SMOLLM_FILES) {
			signal?.throwIfAborted();
			onProgress?.(finished, file.name);
			await fetchVerified(dir, file, signal, loaded => onProgress?.(finished + loaded, file.name));
			finished += file.size;
		}
		onProgress?.(finished, "verified");
		await runtime.write(path.join(dir, READY_MARKER), `${READY_STAMP}\n`);
		// Engines read their weights at load, so a running one is unaffected.
		for (const name of OBSOLETE_FILES) await fs.rm(path.join(dir, name), { force: true });
		logger.debug("smollm weights: ready", { dir, files: SMOLLM_FILES.map(file => file.name) });
		return dir;
	});
}

/** After a failed background fetch, wait this long before the next attempt. */
const PREFETCH_RETRY_MS = 10 * 60_000;
let prefetching = false;
let prefetchRetryAt = 0;
let weightsReady = false;

/**
 * Start fetching the weights in the background, shown in the download HUD,
 * unless they are ready, already downloading, or a failure is backing off.
 * Called by the composer's word-completion backend on each `smollm`
 * request, so the fetch starts on first use; cheap after that.
 */
export function prefetchSmolLmWeights(): void {
	if (isCoreSdk() || !readNativeCapabilities().localAssistance || !readNativeCapabilities().smollm) return;
	if (weightsReady || prefetching || Date.now() < prefetchRetryAt) return;
	prefetching = true;
	void (async () => {
		if (await smolLmWeightsReady()) return;
		await withDownload(
			SMOLLM_LABEL,
			tracker => ensureSmolLmWeights({ onProgress: (loaded, file) => tracker.update({ loaded, detail: file }) }),
			{ loaded: 0, total: SMOLLM_TOTAL_BYTES, detail: "word completion model" },
		);
	})()
		.then(
			() => {
				weightsReady = true;
			},
			(error: unknown) => {
				prefetchRetryAt = Date.now() + PREFETCH_RETRY_MS;
				logger.warn("smollm weights: download failed; word completion stays on n-gram", {
					error: String(error),
				});
			},
		)
		.finally(() => {
			prefetching = false;
		});
}
