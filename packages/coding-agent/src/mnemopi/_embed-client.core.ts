import type * as Local from "./_embed-client";
import type { SpawnedSubprocess } from "../subprocess/worker-client";
import type { SharedWorkerLaunch } from "../subprocess/shared-worker";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerOutbound } from "./embed-protocol";
import { throwLocalRuntimeUnavailable } from "../sdk-profile";

export type { MnemopiEmbedWorkerHandle, MnemopiSubprocessEmbeddingModel } from "./_embed-client";
export { MNEMOPI_EMBED_WORKER_ARG } from "../cli/worker-selectors";

export class MnemopiEmbedClient implements Pick<Local.MnemopiEmbedClient, keyof Local.MnemopiEmbedClient> {
	async initialize(
		_model: MnemopiEmbedModelId,
		_cacheDir: string | undefined,
	): Promise<Local.MnemopiSubprocessEmbeddingModel | null> {
		return throwLocalRuntimeUnavailable("Local memory embeddings");
	}
	async load(_model: MnemopiEmbedModelId, _cacheDir: string | undefined): Promise<string | undefined> {
		return throwLocalRuntimeUnavailable("Local memory embeddings");
	}
	async embed(
		_model: MnemopiEmbedModelId,
		_cacheDir: string | undefined,
		_texts: string[],
		_batchSize: number | undefined,
	): Promise<number[][]> {
		return throwLocalRuntimeUnavailable("Local memory embeddings");
	}
	/** Core cannot hold embedding worker connections. */
	async terminate(): Promise<void> {}
}

export function createMnemopiEmbedSubprocess(): SpawnedSubprocess<MnemopiEmbedWorkerOutbound> {
	return throwLocalRuntimeUnavailable("Local memory embeddings");
}
export function spawnMnemopiEmbedWorker(): Local.MnemopiEmbedWorkerHandle {
	return throwLocalRuntimeUnavailable("Local memory embeddings");
}
export function mnemopiEmbedServerName(_model: MnemopiEmbedModelId, _cacheDir: string): string {
	return throwLocalRuntimeUnavailable("Local memory embeddings");
}
export function mnemopiEmbedLaunch(_model: MnemopiEmbedModelId, _env?: Record<string, string>): SharedWorkerLaunch {
	return throwLocalRuntimeUnavailable("Local memory embeddings");
}
export async function smokeTestMnemopiEmbedWorker(_options?: { timeoutMs?: number }): Promise<void> {
	return throwLocalRuntimeUnavailable("Local memory embeddings");
}
export const mnemopiEmbedClient = new MnemopiEmbedClient();
export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}
