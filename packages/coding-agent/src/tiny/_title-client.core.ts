import type * as Local from "./_title-client";
import type { RefCountedWorkerHandle } from "../subprocess/worker-client";
import type { TinyChatMessage, TinyTitleProgressEvent, TinyWorkerRequest, TinyWorkerResponse } from "./title-protocol";
import type { TinyLocalModelKey } from "./models";
import { throwLocalRuntimeUnavailable } from "../sdk-profile";

export type {
	TinyModelChatOptions,
	TinyModelCompletionOptions,
	TinyTitleDownloadOptions,
	TinyTitleDownloadResult,
	TinyTitleGenerateOptions,
	TinyWorkerLaunch,
} from "./_title-client";

type WorkerHandle = RefCountedWorkerHandle<TinyWorkerRequest, TinyWorkerResponse>;

/** The compiled core surface owns no inference transport or local private state. */
export class TinyTitleClient implements Pick<Local.TinyTitleClient, keyof Local.TinyTitleClient> {
	#listeners: Set<(event: TinyTitleProgressEvent) => void> | undefined;

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		const listeners = (this.#listeners ??= new Set());
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** Existing core prewarming does not launch workers. */
	prewarm(_modelKey: string): void {}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: Local.TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		_modelKey: string,
		_message: string,
		_options?: AbortSignal | Local.TinyTitleGenerateOptions,
	): Promise<string | null> {
		return throwLocalRuntimeUnavailable("Tiny local helper inference");
	}

	async chat(
		_modelKey: string,
		_messages: readonly TinyChatMessage[],
		_options?: Local.TinyModelChatOptions,
	): Promise<string | null> {
		return throwLocalRuntimeUnavailable("Tiny local helper inference");
	}

	async complete(
		_modelKey: string,
		_prompt: string,
		_options?: Local.TinyModelCompletionOptions,
	): Promise<string | null> {
		return throwLocalRuntimeUnavailable("Tiny local helper inference");
	}

	async downloadModel(
		_modelKey: string,
		_options?: Local.TinyTitleDownloadOptions,
	): Promise<Local.TinyTitleDownloadResult> {
		return throwLocalRuntimeUnavailable("Tiny local model download");
	}

	/** No worker resources exist in core; subscriptions survive shutdown as in full. */
	async terminate(): Promise<void> {}
}

export function tinyWorkerEnvOverlay(_device?: string, _dtype?: string): Record<string, string> {
	return throwLocalRuntimeUnavailable("Tiny local helper inference");
}
export function tinyModelEnvKey(): string {
	return throwLocalRuntimeUnavailable("Tiny local helper inference");
}
export function tinyWorkerEnv(): Record<string, string> {
	return throwLocalRuntimeUnavailable("Tiny local helper inference");
}
export function tinyWorkerUsesMlx(): boolean {
	return throwLocalRuntimeUnavailable("Tiny local helper inference");
}
export function onnxLaunch(_modelKey: TinyLocalModelKey, _env: Record<string, string>): Local.TinyWorkerLaunch {
	return throwLocalRuntimeUnavailable("Tiny local helper inference");
}
export function connectTinyWorker(
	_launch: Local.TinyWorkerLaunch,
	_modelKey: TinyLocalModelKey,
	_runtimeDir?: string,
): Promise<WorkerHandle> {
	return throwLocalRuntimeUnavailable("Tiny local helper inference");
}
export async function smokeTestTinyTitleWorker(_options?: { timeoutMs?: number }): Promise<void> {
	return throwLocalRuntimeUnavailable("Tiny local helper inference");
}

export const tinyTitleClient = new TinyTitleClient();
export const tinyModelClient = tinyTitleClient;
export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}
