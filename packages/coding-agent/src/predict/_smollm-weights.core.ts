import { throwLocalRuntimeUnavailable } from "../sdk-profile";
import type * as Local from "./_smollm-weights";

export { getSmolLmModelDir, SMOLLM_LABEL, SMOLLM_TOTAL_BYTES } from "./smollm-model";
export type { EnsureSmolLmWeightsOptions } from "./_smollm-weights";

export async function smolLmWeightsReady(): Promise<boolean> {
	return false;
}

export async function ensureSmolLmWeights(_options?: Local.EnsureSmolLmWeightsOptions): Promise<string> {
	return throwLocalRuntimeUnavailable("SmolLM word completion");
}

/** Core cannot prefetch a disabled model, matching its existing background policy. */
export function prefetchSmolLmWeights(): void {}
