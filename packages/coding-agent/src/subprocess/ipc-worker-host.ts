import { startParentWatchdog } from "./parent-watchdog";

/**
 * Attach a subprocess worker's typed IPC transport synchronously, then keep it
 * alive until its parent disconnects or dies. JS eval, stats, and full-profile
 * inference workers share this lifecycle and its hard-kill shutdown contract.
 */
export async function runIpcSubprocessWorker<In, Out>(
	start: (transport: {
		send(message: Out): void;
		sendAndFlush(message: Out): Promise<void>;
		onMessage(handler: (message: In) => void): () => void;
	}) => void,
	options?: {
		/**
		 * Rethrow send failures while the IPC channel is still connected instead
		 * of shutting down. A connected-channel failure means this particular
		 * message could not be serialized (e.g. a JS eval cell passed a function
		 * into tool args, a DataCloneError under advanced serialization) — the
		 * caller must see that error, exactly as Worker `postMessage` would
		 * deliver it, rather than losing the whole worker and its state.
		 * Channel-gone failures still shut down.
		 */
		rethrowConnectedSendErrors?: boolean;
	},
): Promise<void> {
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
	// `process.send` only exists when spawned with an IPC channel; the parent
	// always spawns us that way. If it's missing, the parent vanished and
	// there's no one to talk to.
	const ipcSend = (): IpcSend | undefined => (process as NodeJS.Process & { send?: IpcSend }).send;
	if (!ipcSend()) {
		// Intentional fall-through: shutdown() only resolves the promise;
		// the await + SIGKILL tail below is what actually exits.
		shutdown();
	}
	const send = (message: Out): void => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch (error) {
			if (options?.rethrowConnectedSendErrors && process.connected) throw error;
			shutdown();
		}
	};
	const sendAndFlush = (message: Out): Promise<void> => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			sender.call(process, message, () => resolve());
		} catch {
			shutdown();
			resolve();
		}
		return promise;
	};
	start({
		send,
		sendAndFlush,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as In);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	const initialParentPid = process.ppid;
	if (process.platform === "win32" && initialParentPid <= 0) {
		shutdown();
	} else if (initialParentPid > 0) {
		startParentWatchdog(initialParentPid);
	}
	const keepalive = setInterval(() => {}, 2 ** 30);
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical with
	// the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
	}
	process.kill(process.pid, "SIGKILL");
}
