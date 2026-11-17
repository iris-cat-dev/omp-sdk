import { assertLocalRuntimeAvailable } from "../sdk-profile";
import { runIpcSubprocessWorker } from "../subprocess/ipc-worker-host";
import {
	MNEMOPI_EMBED_SERVER_WORKER_ARG,
	MNEMOPI_EMBED_WORKER_ARG,
	STT_WORKER_ARG,
	TINY_WORKER_ARG,
	TTS_WORKER_ARG,
	type OfflineWorkerSelector,
} from "./worker-selectors";

/** Full/source worker implementations stay lazy until their selector is dispatched. */
export async function runOfflineWorkerEntrypoint(arg: OfflineWorkerSelector): Promise<boolean> {
	if (arg === TINY_WORKER_ARG) {
		assertLocalRuntimeAvailable("Tiny local helper inference");
		const { startTinyWorkerFromEnvironment } = require("../tiny/worker");
		await startTinyWorkerFromEnvironment();
		return true;
	}
	if (arg === STT_WORKER_ARG) {
		assertLocalRuntimeAvailable("Offline speech recognition");
		const { startSttWorker } = require("../stt/asr-worker");
		await runIpcSubprocessWorker(startSttWorker);
		return true;
	}
	if (arg === TTS_WORKER_ARG) {
		assertLocalRuntimeAvailable("Offline speech synthesis");
		const { startTtsWorker } = require("../tts/tts-worker");
		await runIpcSubprocessWorker(startTtsWorker);
		return true;
	}
	if (arg === MNEMOPI_EMBED_WORKER_ARG) {
		assertLocalRuntimeAvailable("Local memory embeddings");
		const { startMnemopiEmbedWorker } = require("../mnemopi/embed-worker");
		await runIpcSubprocessWorker(startMnemopiEmbedWorker);
		return true;
	}
	if (arg === MNEMOPI_EMBED_SERVER_WORKER_ARG) {
		assertLocalRuntimeAvailable("Local memory embeddings");
		const { startMnemopiEmbedServerFromEnvironment } = require("../mnemopi/embed-server");
		await startMnemopiEmbedServerFromEnvironment();
		return true;
	}
	return false;
}
