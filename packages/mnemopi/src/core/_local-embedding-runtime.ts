import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { getFastembedCacheDir, logger } from "@oh-my-pi/pi-utils";
import type * as FastembedRuntime from "./fastembed-runtime";
import type { LocalEmbeddingModel, LocalModelInitOptions } from "./embeddings";

/**
 * Quarantine the exact ONNX file named by a "Protobuf parsing failed" init
 * error. A truncated cached model blocks local embeddings forever: the
 * downloader treats the existing file as complete, so every init re-parses
 * the same broken bytes. The extracted path is error-message CONTENT, so it
 * is only honored when it resolves inside the fastembed cache directory —
 * never rename an arbitrary file a dependency happens to mention. Atomic
 * rename; losing a concurrent-heal race (file already renamed/removed)
 * still returns true because a retry is safe either way.
 * @internal exported for tests
 */
export async function quarantineCorruptModelFile(message: string, cacheDir?: string): Promise<boolean> {
	const match = /Load model from (.+?\.onnx) failed:.*Protobuf parsing failed/i.exec(message);
	if (!match) return false;
	const modelFile = nodePath.resolve(match[1]);
	const cacheRoot = nodePath.resolve(cacheDir ?? getFastembedCacheDir());
	if (!modelFile.startsWith(cacheRoot + nodePath.sep)) return false;
	try {
		await fsp.rename(modelFile, `${modelFile}.corrupt-${Date.now()}`);
		logger.warn("mnemopi: quarantined corrupt local embedding model; retrying init", { modelFile });
	} catch {
		// Concurrent heal or vanished file: the single retry stays safe. A
		// rename that failed with the file still in place just makes the
		// retry surface the original error again.
	}
	return true;
}

/**
 * Shared local-model initializer: FlagEmbedding.init with a corrupt-cache heal.
 * A corrupt model blob (Protobuf parse failure) quarantines the file and
 * retries once; fastembed re-downloads any file missing from the model's
 * cache directory. Also the initializer the embed worker uses in its
 * subprocess; the in-process seam stays {@link setLocalModelInitializer}.
 *
 * The ONNX sessions fastembed builds here from the model cache carry the
 * embedding thread budget ({@link withEmbedSessionBudget}); it is off again by
 * the time this returns, and never touches a session built from anywhere else,
 * so a consumer sharing the same onnxruntime copy keeps its own defaults.
 */
export async function defaultLocalModelInitializer(options: LocalModelInitOptions): Promise<LocalEmbeddingModel> {
	const { loadFastembed, withEmbedSessionBudget }: typeof FastembedRuntime = require("./fastembed-runtime");
	const cacheDir = options.cacheDir ?? getFastembedCacheDir();
	const initOptions = options.cacheDir === undefined ? { ...options, cacheDir } : options;
	const { FlagEmbedding } = await loadFastembed();
	return withEmbedSessionBudget(cacheDir, async () => {
		try {
			return await FlagEmbedding.init(initOptions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (/Protobuf parsing failed/i.test(message) && (await quarantineCorruptModelFile(message, cacheDir))) {
				return FlagEmbedding.init(initOptions);
			}
			throw error;
		}
	});
}
