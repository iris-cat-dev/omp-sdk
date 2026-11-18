import type * as Local from "./_downloader";
import { throwLocalRuntimeUnavailable } from "../sdk-profile";

export type { DownloadProgress, EnsureOptions, SttDownloadProgress } from "./_downloader";

export async function isSttModelCached(_key: string): Promise<boolean> {
	return false;
}

export async function downloadSttModel(
	_key: string,
	_onProgress?: (progress: Local.SttDownloadProgress) => void,
	_options?: { signal?: AbortSignal },
): Promise<void> {
	return throwLocalRuntimeUnavailable("Offline speech model download");
}

export async function ensureSTTDependencies(_options?: Local.EnsureOptions): Promise<void> {
	return throwLocalRuntimeUnavailable("Offline speech model download");
}
