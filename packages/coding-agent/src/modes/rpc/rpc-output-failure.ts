import type { Writable } from "node:stream";
import { RpcOutputError } from "./rpc-output";

interface RpcOutputFailureBoundary {
	stderr: Writable;
	log: (diagnostic: string) => void;
	dispose: () => Promise<void>;
	exit: (code: number) => void;
}

/** Never use the failed protocol writer to report its own failure. */
export async function handleRpcOutputFailure(failure: Error, boundary: RpcOutputFailureBoundary): Promise<void> {
	const diagnostic = `[OMP_RPC_FATAL] ${failure instanceof RpcOutputError ? failure.message : "RPC output failed (stage=stdout)"}`;
	const mirror = Promise.withResolvers<void>();
	const settle = (): void => {
		clearTimeout(timer);
		mirror.resolve();
	};
	const timer = setTimeout(settle, 500);
	boundary.stderr.on("error", settle);
	boundary.stderr.on("close", settle);
	try {
		boundary.stderr.write(`${diagnostic}\n`, error => {
			// A failed write also emits error; retain its listener until that event.
			if (!error) settle();
		});
	} catch {
		settle();
	}
	try {
		boundary.log(diagnostic);
	} catch {
		// A broken logger must not prevent the independent stderr mirror or disposal.
	}
	const disposalTimeout = Promise.withResolvers<void>();
	const disposalTimer = setTimeout(disposalTimeout.resolve, 2_000);
	try {
		await Promise.all([
			mirror.promise,
			Promise.race([
				Promise.resolve()
					.then(() => boundary.dispose())
					.catch(() => {}),
				disposalTimeout.promise,
			]),
		]);
	} finally {
		clearTimeout(disposalTimer);
		clearTimeout(timer);
		// A write may fail after the mirror timeout while disposal is still pending.
		boundary.stderr.off("error", settle);
		boundary.stderr.off("close", settle);
		boundary.exit(1);
	}
}
