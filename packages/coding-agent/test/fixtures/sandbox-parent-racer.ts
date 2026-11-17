import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const { root, outside, control } = workerData as { root: string; outside: string; control: SharedArrayBuffer };
const state = new Int32Array(control);
const parent = path.join(root, "nested");
const parked = path.join(root, "parked");
const linked = path.join(root, "linked");
// Reuse one junction: recreating a removed junction can race Windows'
// delete-pending state instead of exercising the sandbox's path resolution.
fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
function rename(source: string, target: string) {
	const deadline = Date.now() + 5_000;
	for (;;) {
		try { fs.renameSync(source, target); return; }
		catch (error) {
			// Native write temporaries deliberately deny sharing while publishing.
			// A blocked swap is safe; retry it, but keep unexpected errors fatal.
			if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
			Atomics.wait(state, 0, 0, 1);
		}
	}
}
while (Atomics.load(state, 0) === 0) {
	rename(parent, parked);
	rename(linked, parent);
	rename(parent, linked);
	rename(parked, parent);
	if (Atomics.add(state, 1, 1) === 0) parentPort!.postMessage("ready");
}
