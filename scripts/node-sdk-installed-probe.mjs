import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This file is copied into the fresh npm project, so bare SDK imports cannot
// accidentally resolve the source checkout or any of its installed dependencies.
const sdk = await import("@oh-my-pi/pi-coding-agent/sdk");
assert.equal(globalThis.Bun, undefined);
assert.equal(typeof sdk.createAgentSession, "function");
const require = createRequire(import.meta.url);
const sdkManifestPath = require.resolve("@oh-my-pi/pi-coding-agent/package.json");
const sdkRoot = path.dirname(sdkManifestPath);
const sdkRequire = createRequire(sdkManifestPath);
const manifest = JSON.parse(await readFile(sdkManifestPath, "utf8"));
assert.equal(manifest.ompNodeSdk?.profile, "core");
assert.equal(manifest.ompNodeSdk?.target, "desktop");
assert.equal(manifest.version, process.env.OMP_SDK_SMOKE_VERSION);
const native = sdkRequire("@oh-my-pi/pi-natives");
assert.equal(native.__piNativesBuildVersion(), manifest.version);
const capabilities = sdk.readNativeCapabilities();
for (const name of ["smollm", "liveVoice", "wasmGrammars", "pdf", "jujutsu", "snapcompact", "audio", "localAssistance", "syntaxHighlighting"])
  assert.equal(capabilities[name], false, name);
assert.throws(() => native.highlightCode("const value = 1;", "javascript", {}), /syntaxHighlighting|unavailable/);

const cwd = path.join(process.cwd(), "work");
await mkdir(cwd);
const session = {
  cwd, hasUI: false, enableLsp: false, enableMCP: false, hasEditTool: true,
  settings: sdk.Settings.isolated({ "lsp.enabled": false, "lsp.formatOnWrite": false, "lsp.diagnosticsOnWrite": false }),
  getSessionSpawns: () => null,
  getSessionFile: () => null,
};
const writer = new sdk.WriteTool(session);
const reader = new sdk.ReadTool(session);
const shell = new sdk.BashTool(session);
function text(result) {
  assert.notEqual(result.isError, true);
  assert.notEqual(result.details?.isError, true);
  return result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
}
await writer.execute("sdk-smoke-write", { path: "hello.txt", content: "SDK native smoke\n" });
assert.equal(await readFile(path.join(cwd, "hello.txt"), "utf8"), "SDK native smoke\n");
assert.match(text(await reader.execute("sdk-smoke-read", { path: "hello.txt:raw" })), /SDK native smoke/u);
assert.match(text(await shell.execute("sdk-smoke-shell", { command: "printf 'SDK shell smoke'", cwd, timeout: 15, pty: false })), /SDK shell smoke/u);
// The docs corpus is a real compressed build-time resource, not the checkout's docs.
assert.match(text(await reader.execute("sdk-smoke-resource", { path: "omp://sdk.md:1-20:raw" })), /# SDK/u);

const utilsRoot = path.dirname(sdkRequire.resolve("@oh-my-pi/pi-utils/package.json"));
const { Database } = await import(pathToFileURL(path.join(utilsRoot, "dist/node/sqlite-driver.mjs")).href);
const db = new Database(path.join(cwd, "smoke.db"));
try {
  db.run("CREATE TABLE smoke (value TEXT NOT NULL)");
  db.run("INSERT INTO smoke VALUES (?)", "native-sqlite");
  assert.equal(db.query("SELECT value FROM smoke").get().value, "native-sqlite");
} finally { db.close(); }
const { Image } = await import(pathToFileURL(path.join(utilsRoot, "dist/node/runtime-image.mjs")).href);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
const png = await new Image(svg).resize(2, 3).png().bytes();
assert.deepEqual(await new Image(png).metadata(), { width: 2, height: 3, format: "png" });
const ffi = sdkRequire("koffi");
const system = ffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6");
try {
  assert.equal(system.func("int getpid(void)")(), process.pid);
} finally { system.unload(); }

const registry = JSON.parse(await readFile(path.join(sdkRoot, "dist/node/modules.json"), "utf8"));
const alias = registry.modules["@oh-my-pi/pi-coding-agent/sdk"];
assert.equal(typeof alias, "string");
assert.equal(typeof (await import(pathToFileURL(path.join(sdkRoot, "dist/node", alias)).href)).createAgentSession, "function");
// Ping the exact installed shared host over its real IPC protocol. This executes
// the activity worker's lazy graph, not just an import of the main SDK module.
const worker = fork(path.join(sdkRoot, "dist/node/host.mjs"), ["__omp_worker_stats_activity"], {
  cwd, execPath: process.execPath, execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"],
});
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Installed SDK worker smoke timed out")), 30_000);
    const cleanup = () => { clearTimeout(timeout); worker.removeListener("message", onMessage); worker.removeListener("exit", onExit); worker.removeListener("error", onError); };
    const onMessage = (message) => {
      if (message.type === "pong" && message.id === 1) { cleanup(); resolve(); }
      else if (message.type === "error") { cleanup(); reject(new Error(message.error)); }
    };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`Installed SDK worker exited: ${code}/${signal}`)); };
    const onError = (error) => { cleanup(); reject(error); };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.once("error", onError);
    worker.send({ type: "ping", id: 1 }, (error) => { if (error) onError(error); });
  });
} finally {
  if (worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    await exited;
  }
}
console.log(`Installed SDK ${manifest.version} smoke passed on ${process.platform}-${process.arch}`);
