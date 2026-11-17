import type { MessagePort } from "node:worker_threads";
import type * as WorkerThreads from "node:worker_threads";
import type * as Postmortem from "@oh-my-pi/pi-utils/postmortem";
import { installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type * as JsProcessEntry from "../eval/js/process-entry";
import type { WorkerInbound as JsWorkerInbound, WorkerOutbound as JsWorkerOutbound } from "../eval/js/worker-protocol";
import { runIpcSubprocessWorker } from "../subprocess/ipc-worker-host";
import { runOfflineWorkerEntrypoint } from "#coding-agent-offline-worker-dispatch";
import { assertNativeCapability } from "../native-capabilities";
import {
	BLOB_BROKER_WORKER_ARG,
	COMPUTER_WORKER_ARG,
	DAEMON_BROKER_WORKER_ARG,
	IDA_HOST_WORKER_ARG,
	LSP_MUX_WORKER_ARG,
	PARENT_WATCHDOG_WORKER_ARG,
	STATS_ACTIVITY_WORKER_ARG,
	TERMINAL_OUTPUT_WORKER_ARG,
	TEXT_PREDICT_WORKER_ARG,
	isOfflineWorkerSelector,
} from "./worker-selectors";

/**
 * Worker inboxes must attach before this entry module reaches its first await.
 * The synchronous module boundary keeps worker_threads out of ordinary CLI startup.
 */
function getWorkerParentPort(): MessagePort | null {
	const workerThreads: typeof WorkerThreads = require("node:worker_threads");
	return workerThreads.parentPort;
}

const STATS_SYNC_WORKER_ARG = "__omp_worker_stats_sync";
const TAB_WORKER_ARG = "__omp_worker_tab";
const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";
const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";

/** Dispatch the shared hidden selectors without loading a CLI frontend. */
export async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === STATS_SYNC_WORKER_ARG) {
		// The sync worker handles messages via `self.onmessage`, assigned while
		// its module loads. Bun flushes the worker's initial message
		// buffer when the entry module's top-level evaluation finishes — before
		// this dispatch completes — so anything the parent posted right after
		// spawning (the smoke ping, the first parse request) would be dropped.
		// Park early events and replay them once the module's handler is live.
		// Worker-thread entries using `parentPort` need the same sync-prefix
		// buffering; the computer/tab/eval cases install that inbox below.
		const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null };
		const pending: MessageEvent[] = [];
		const buffer = (event: MessageEvent): void => {
			pending.push(event);
		};
		scope.onmessage = buffer;
		require("@oh-my-pi/omp-stats/sync-worker");
		const handler = scope.onmessage;
		if (handler && handler !== buffer) {
			for (const event of pending) handler.call(scope, event);
		}
		return true;
	}
	// Bun flushes messages the parent posted before spawn once this entry's
	// top-level evaluation completes. Install a buffering inbox synchronously
	// before binding the selected worker's real handler so the parent's
	// synchronous `init` survives. The dynamically imported tab/eval modules
	// consume the same inbox after their module evaluation begins.
	if (arg === TAB_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		require("../tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === COMPUTER_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		const { startComputerWorker } = require("../tools/computer/worker-entry");
		startComputerWorker();
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		require("../eval/js/worker-entry");
		return true;
	}
	if (arg === JS_EVAL_PROCESS_ARG) {
		// This selector is the synchronous bootstrap boundary: keep the evaluator
		// runtime and postmortem/inspector graph out of ordinary startup without
		// putting an await ahead of the subprocess message handler.
		const { startJsEvalProcess }: typeof JsProcessEntry = require("../eval/js/process-entry");
		// The .js subpath is the package's unconditional export for synchronous loading.
		const { interceptUnhandledRejections }: typeof Postmortem = require("@oh-my-pi/pi-utils/postmortem.js");
		// The JS evaluator forwards user-controlled payloads (tool-call args,
		// display outputs); a non-serializable one must fail that cell, not
		// SIGKILL the kernel and erase the eval session's state.
		await runIpcSubprocessWorker<JsWorkerInbound, JsWorkerOutbound>(
			transport => startJsEvalProcess(transport, interceptUnhandledRejections),
			{ rethrowConnectedSendErrors: true },
		);
		return true;
	}
	if (isOfflineWorkerSelector(arg)) return runOfflineWorkerEntrypoint(arg);
	if (arg === STATS_ACTIVITY_WORKER_ARG) {
		const { startStatsActivityWorker } = require("../stats/activity-worker");
		await runIpcSubprocessWorker(startStatsActivityWorker);
		return true;
	}
	if (arg === TERMINAL_OUTPUT_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		// This selector is the isolation boundary; a static import would evaluate xterm in normal CLI startup.
		require("../launch/terminal-output-worker");
		return true;
	}
	if (arg === PARENT_WATCHDOG_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		require("../subprocess/parent-watchdog-worker");
		return true;
	}
	if (arg === DAEMON_BROKER_WORKER_ARG) {
		// Worker selectors must dispatch before the normal command graph loads.
		const { startDaemonBrokerFromEnvironment } = require("../launch/broker");
		await startDaemonBrokerFromEnvironment();
		return true;
	}
	if (arg === LSP_MUX_WORKER_ARG) {
		const { startLspMuxFromEnvironment } = require("../lsp/mux/server");
		await startLspMuxFromEnvironment();
		return true;
	}
	if (arg === IDA_HOST_WORKER_ARG) {
		const { startIdaHostFromEnvironment } = require("../ida/host");
		await startIdaHostFromEnvironment();
		return true;
	}
	if (arg === BLOB_BROKER_WORKER_ARG) {
		const { startBlobBrokerFromEnvironment } = require("../blob-broker/server");
		await startBlobBrokerFromEnvironment();
		return true;
	}
	if (arg === TEXT_PREDICT_WORKER_ARG) {
		assertNativeCapability("localAssistance", "Word prediction daemon");
		const { startTextPredictDaemonFromEnvironment } = require("../predict/daemon");
		await startTextPredictDaemonFromEnvironment();
		return true;
	}
	return false;
}
