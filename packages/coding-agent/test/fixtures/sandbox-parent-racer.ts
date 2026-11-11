import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const { root, outside, control } = workerData as { root: string; outside: string; control: SharedArrayBuffer };
const state = new Int32Array(control);
const parent = path.join(root, "nested");
const parked = path.join(root, "parked");
while (Atomics.load(state, 0) === 0) {
	fs.renameSync(parent, parked);
	fs.symlinkSync(outside, parent);
	fs.unlinkSync(parent);
	fs.renameSync(parked, parent);
	if (Atomics.add(state, 1, 1) === 0) parentPort!.postMessage("ready");
}
