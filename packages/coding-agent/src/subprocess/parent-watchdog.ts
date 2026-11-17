import { workerHostEntry, nodeWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { Worker as NodeWorker } from "node:worker_threads";
import { PARENT_WATCHDOG_WORKER_ARG } from "../cli/worker-selectors";

/**
 * SIGKILL this process once `parentPid` exits or this process is reparented.
 *
 * Called by `runIpcSubprocessWorker` (`./ipc-worker-host`) for every IPC subprocess worker.
 * Liveness is polled on a dedicated worker thread rather than the main event
 * loop: inference workers pin their main thread inside synchronous native calls
 * (onnxruntime `session.run`) for minutes at a time, and a main-loop watchdog
 * cannot fire until that call returns — leaving a multi-GiB orphan behind a
 * dead parent (issue #14340). The thread is `unref`'d; it never keeps the
 * process alive by itself.
 */
export function startParentWatchdog(parentPid: number): void {
	const hostEntry = workerHostEntry() ?? (typeof Bun === "undefined" ? nodeWorkerHostEntry() : null);
	if (typeof Bun === "undefined" && !hostEntry)
		throw new Error("Parent watchdog requires the shared Node worker host");
	const worker =
		typeof Bun === "undefined"
			? new NodeWorker(hostEntry!, { argv: [PARENT_WATCHDOG_WORKER_ARG] })
			: hostEntry
				? new Worker(hostEntry, { type: "module", argv: [PARENT_WATCHDOG_WORKER_ARG] })
				: new Worker(new URL("./parent-watchdog-worker.ts", import.meta.url).href, { type: "module" });
	if (worker instanceof NodeWorker) worker.postMessage(parentPid);
	else worker.postMessage(parentPid, []);
	worker.unref();
}
