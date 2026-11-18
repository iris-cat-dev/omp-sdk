import type * as Local from "./_asr-client";
import type { SpawnedSubprocess } from "../subprocess/worker-client";
import type { SttProgressEvent, SttWorkerOutbound } from "./asr-protocol";
import type { SttModelKey } from "./models";
import { throwLocalRuntimeUnavailable } from "../sdk-profile";

export type {
	SttTranscribeOptions,
	SttDownloadOptions,
	SttDownloadResult,
	SttStreamHandle,
	SttStreamOptions,
} from "./_asr-client";
export { STT_WORKER_ARG } from "../cli/worker-selectors";

export class SttClient implements Pick<Local.SttClient, keyof Local.SttClient> {
	#listeners: Set<(event: SttProgressEvent) => void> | undefined;

	onProgress(listener: (event: SttProgressEvent) => void): () => void {
		const listeners = (this.#listeners ??= new Set());
		listeners.add(listener);
		return () => listeners.delete(listener);
	}
	async transcribe(
		_modelKey: SttModelKey,
		_audio: Float32Array,
		_options?: Local.SttTranscribeOptions,
	): Promise<string> {
		return throwLocalRuntimeUnavailable("Offline speech recognition");
	}
	startStream(_modelKey: SttModelKey, _options?: Local.SttStreamOptions): Local.SttStreamHandle {
		return throwLocalRuntimeUnavailable("Offline speech recognition");
	}
	downloadModel(_modelKey: SttModelKey, _options?: Local.SttDownloadOptions): Promise<Local.SttDownloadResult> {
		return throwLocalRuntimeUnavailable("Offline speech model download");
	}
	/** Core has no transport to close; progress subscriptions retain their lifecycle. */
	async terminate(): Promise<void> {}
}

export function createSttSubprocess(): SpawnedSubprocess<SttWorkerOutbound> {
	return throwLocalRuntimeUnavailable("Offline speech recognition");
}
export async function smokeTestSttWorker(_options?: { timeoutMs?: number }): Promise<void> {
	return throwLocalRuntimeUnavailable("Offline speech recognition");
}
export const sttClient = new SttClient();
export async function shutdownSttClient(): Promise<void> {
	await sttClient.terminate();
}
