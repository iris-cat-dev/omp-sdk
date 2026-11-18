import assert from "node:assert/strict";
import { fork } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = path.resolve(process.argv[2]);
const profile = process.argv[3];
assert.ok(profile === "core" || profile === "full", "usage: node node-sdk-profile-probe.mjs <installed coding-agent dir> <core|full>");
const artifactDir = path.join(packageDir, "dist/node");
const registry = JSON.parse(await fs.readFile(path.join(artifactDir, "modules.json"), "utf8"));
const runtime = JSON.parse(await fs.readFile(path.join(artifactDir, "runtime-dependencies.json"), "utf8"));
assert.equal(registry.profile, profile);
assert.equal(runtime.profile, profile);
const sdk = await import(pathToFileURL(path.join(artifactDir, "sdk.mjs")).href);
const ai = await import(pathToFileURL(path.join(artifactDir, registry.modules["@oh-my-pi/pi-ai"])).href);
const auth = await sdk.AuthStorage.create(":memory:");
try {
	const models = new sdk.ModelRegistry(auth, path.join(packageDir, "profile-probe-models.yml"));
	assert.equal(models.getAll("all").some(model => model.api === "local-inference"), profile === "full");
	const cloud = models.getAll("all").find(model => model.api === "openai-speech");
	assert.ok(cloud, "remote speech remains discoverable");
	let payload;
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		payload = JSON.parse(Buffer.concat(chunks).toString());
		assert.equal(request.url, "/v1/audio/speech");
		response.writeHead(200, { "content-type": "audio/mpeg" });
		response.end(Buffer.from([1, 2, 3]));
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const result = await ai.synthesizeSpeech(
			{ ...cloud, baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
			{ text: "Remote speech survives profile trimming", voice: "sky", format: "mp3" },
			{ apiKey: "profile-probe" },
		);
		assert.deepEqual([...result.audio], [1, 2, 3]);
		assert.equal(payload.model, cloud.id);
		assert.equal(payload.input, "Remote speech survives profile trimming");
	} finally {
		await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
} finally {
	auth.close();
}

async function runWorker(selector, rejectOffline) {
	const child = fork(path.join(artifactDir, "host.mjs"), [selector], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += chunk; });
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Worker ${selector} timed out: ${stderr}`)), 20_000);
			child.once("error", error => { clearTimeout(timer); reject(error); });
			child.once("exit", code => {
				clearTimeout(timer);
				if (rejectOffline && code !== 0 && /core Node SDK profile.*remote.*full SDK profile/.test(stderr)) resolve();
				else reject(new Error(`Unexpected ${selector} exit ${code}: ${stderr}`));
			});
			if (!rejectOffline) {
				child.on("message", message => {
					if (message.type === "pong" && message.id === "profile-probe") { clearTimeout(timer); resolve(); }
				});
				child.send({ type: "ping", id: "profile-probe" });
			}
		});
	} finally {
		child.kill("SIGKILL");
	}
}

if (profile === "core") {
	const dependencies = Object.values(runtime.packages).flatMap(scope => [...scope.dependencies, ...(scope.optionalDependencies ?? [])]);
	for (const dependency of Object.values(runtime.optionalCapabilities).flat()) assert.ok(!dependencies.includes(dependency), `${dependency} leaked into core runtime`);
	for (const selector of ["__omp_worker_tiny_inference", "__omp_worker_stt", "__omp_worker_tts", "__omp_worker_mnemopi_embed", "__omp_worker_mnemopi_embed_server"]) await runWorker(selector, true);
} else {
	for (const selector of ["__omp_worker_stt", "__omp_worker_tts", "__omp_worker_mnemopi_embed"]) await runWorker(selector, false);
}
process.stdout.write(JSON.stringify({ profile, remoteSpeech: true, workerContract: true }) + "\n");
