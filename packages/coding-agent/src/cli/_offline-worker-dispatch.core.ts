import { throwLocalRuntimeUnavailable } from "../sdk-profile";
import { OFFLINE_WORKER_FEATURES, type OfflineWorkerSelector } from "./worker-selectors";

/** The core worker host has no import edge to an offline worker implementation. */
export async function runOfflineWorkerEntrypoint(arg: OfflineWorkerSelector): Promise<boolean> {
	return throwLocalRuntimeUnavailable(OFFLINE_WORKER_FEATURES[arg]);
}
