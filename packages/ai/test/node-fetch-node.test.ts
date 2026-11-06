import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const nodeExecutable = process.env.OMP_NODE_EXECUTABLE ?? Bun.which("node");
it.skipIf(!nodeExecutable)(
	"preserves host fetch contracts in actual Node",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-node-fetch-"));
		try {
			const bundle = path.join(directory, "node-fetch-node-probe.mjs");
			const build = await Bun.build({
				entrypoints: [path.join(import.meta.dir, "fixtures/node-fetch-node-probe.ts")],
				target: "node",
				format: "esm",
				packages: "bundle",
				plugins: [
					{
						name: "node-fetch-probe-dependencies",
						setup(build) {
							build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
								path: Bun.resolveSync("jsonc-parser/lib/esm/main.js", import.meta.dir),
							}));
							build.onResolve({ filter: /^@oh-my-pi\/pi-natives(?:\/.*)?$/ }, args => ({
								path: pathToFileURL(Bun.resolveSync(args.path, import.meta.dir)).href,
								external: true,
							}));
						},
					},
				],
			});
			if (!build.success) throw new AggregateError(build.logs, "Node fetch probe failed to bundle");
			await Bun.write(bundle, build.outputs[0]!);
			const child = Bun.spawn([nodeExecutable!, "--test", bundle], {
				env: { ...process.env, HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: directory },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (exitCode !== 0) throw new Error(`Node fetch probes exited ${exitCode}\n${stdout}\n${stderr}`);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	60_000,
);
