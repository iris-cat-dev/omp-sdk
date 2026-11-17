import type * as Local from "./_tts-client";
import type { SpawnedSubprocess } from "../subprocess/worker-client";
import type { TtsProgressEvent, TtsWorkerOutbound } from "./tts-protocol";
import { throwLocalRuntimeUnavailable } from "../sdk-profile";

export type {
	TtsAudio,
	TtsSynthesizeOptions,
	TtsDownloadOptions,
	TtsStreamOptions,
	TtsAudioChunk,
	TtsStreamHandle,
} from "./_tts-client";
export { TTS_WORKER_ARG } from "../cli/worker-selectors";

export class TtsClient implements Pick<Local.TtsClient, keyof Local.TtsClient> {
	#listeners: Set<(event: TtsProgressEvent) => void> | undefined;

	onProgress(listener: (event: TtsProgressEvent) => void): () => void {
		const listeners = (this.#listeners ??= new Set());
		listeners.add(listener);
		return () => listeners.delete(listener);
	}
	async synthesize(
		_modelKey: string,
		_text: string,
		_options?: Local.TtsSynthesizeOptions,
	): Promise<Local.TtsAudio | null> {
		return throwLocalRuntimeUnavailable("Offline speech synthesis");
	}
	synthesizeStream(_modelKey: string, _options?: Local.TtsStreamOptions): Local.TtsStreamHandle {
		return throwLocalRuntimeUnavailable("Offline speech synthesis");
	}
	async downloadModel(_modelKey: string, _options?: Local.TtsDownloadOptions): Promise<boolean> {
		return throwLocalRuntimeUnavailable("Offline speech model download");
	}
	/** Core has no transport to close; progress subscriptions retain their lifecycle. */
	async terminate(): Promise<void> {}
}

export function createTtsSubprocess(): SpawnedSubprocess<TtsWorkerOutbound> {
	return throwLocalRuntimeUnavailable("Offline speech synthesis");
}
export async function smokeTestTtsWorker(_options?: { timeoutMs?: number }): Promise<void> {
	return throwLocalRuntimeUnavailable("Offline speech synthesis");
}
export const ttsClient = new TtsClient();
export async function shutdownTtsClient(): Promise<void> {
	await ttsClient.terminate();
}
