#!/usr/bin/env node
// Run against built, real Node SDK artifacts and a tool-capable real provider.
// No mocked model stream or echoed synthetic RPC response is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const [sdkDirectory, model] = process.argv.slice(2);
if (!sdkDirectory || !model) throw new Error("Usage: node scripts/smoke-sandbox.mjs <dist/node or dist/node-desktop> <provider/model>");
const load = createRequire(import.meta.url);
const sdk = load(path.resolve(sdkDirectory, "sdk.mjs"));
const rpc = load(path.resolve(sdkDirectory, "rpc.mjs"));
assert([1, 2].includes(rpc.NODE_RPC_SANDBOX_VERSION), "Old or unknown SDK must fail closed");
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-smoke-")));
const root = path.join(base, "root");
const agentDir = path.join(base, "agent");
const journalDir = path.join(base, "journals");
await fs.mkdir(root); await fs.mkdir(agentDir);
await fs.writeFile(path.join(base, "outside.txt"), "SANDBOX_OUTSIDE_SECRET");
const options = {
  cwd: root, agentDir, sandbox: { root }, modelPattern: model,
  systemPrompt: "TRUSTED_USER_PROMPT_SENTINEL {{env.HOME}}",
  settings: await sdk.Settings.loadIsolated({ cwd: root, agentDir, globalOnly: true }),
  sessionManager: sdk.SessionManager.create(root, journalDir),
};
let session;
let sessionFile;
try {
  ({ session } = await sdk.createAgentSession(options));
  const names = session.agent.state.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ["sandbox_list", "sandbox_read", "sandbox_write"]);
  for (const forbidden of [root, os.homedir(), process.cwd()]) assert(!session.systemPrompt.join("\n").includes(forbidden));
  assert(session.systemPrompt.join("\n").includes(options.systemPrompt));
  assert.throws(() => session.executeBash("whoami"), /Sandbox/);
  await assert.rejects(session.setActiveToolsByName(["bash", "eval", "task", "read"]), /Sandbox/);
  const observed = new Set();
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start") {
      assert(names.includes(event.toolName), `Unexpected model tool: ${event.toolName}`);
      observed.add(event.toolName);
    }
  });
  await session.prompt("Use sandbox_write to create smoke.txt containing exactly sandbox-ok. Then use sandbox_read to read smoke.txt. Finally use sandbox_list on . and report completion. Do not skip any of the three tool calls.");
  await session.waitForIdle();
  assert.deepEqual([...observed].sort(), names, "Real model must use all three sandbox tools");
  assert.equal(await fs.readFile(path.join(root, "smoke.txt"), "utf8"), "sandbox-ok");
  // Exercise native tool implementations directly as well as the real model catalog.
  await fs.symlink(path.join(base, "outside.txt"), path.join(root, "link.txt"));
  await fs.link(path.join(base, "outside.txt"), path.join(root, "hardlink.txt"));
  for (const target of ["../outside.txt", path.join(base, "outside.txt"), "file:///etc/passwd", "link.txt", "hardlink.txt"]) {
    const read = session.agent.state.tools.find(tool => tool.name === "sandbox_read");
    const write = session.agent.state.tools.find(tool => tool.name === "sandbox_write");
    assert.equal((await read.execute("read-denied", { path: target })).isError, true);
    assert.equal((await write.execute("write-denied", { path: target, content: "tamper" })).isError, true);
  }
  assert.equal(await fs.readFile(path.join(base, "outside.txt"), "utf8"), "SANDBOX_OUTSIDE_SECRET");
  unsubscribe();
  await session.sessionManager.ensureOnDisk();
  await session.sessionManager.flush();
  sessionFile = session.sessionFile;
  await session.dispose(); session = undefined;
  const manager = await sdk.SessionManager.open(sessionFile, journalDir, undefined, { throwIfMissing: true });
  ({ session } = await sdk.createAgentSession({ ...options, settings: await sdk.Settings.loadIsolated({ cwd: root, agentDir, globalOnly: true }), sessionManager: manager }));
  assert.deepEqual(session.agent.state.tools.map(tool => tool.name).sort(), names);
  assert(!session.systemPrompt.join("\n").includes(root));
  assert(session.systemPrompt.join("\n").includes(options.systemPrompt));
  assert.throws(() => session.executeBash("whoami"), /Sandbox/);
  await assert.rejects(session.switchSession(sessionFile), /Sandbox/);
  await session.dispose(); session = undefined;
  const unguarded = await sdk.SessionManager.open(sessionFile, journalDir, undefined, { throwIfMissing: true });
  await assert.rejects(sdk.createAgentSession({ ...options, sandbox: undefined, sessionManager: unguarded }), /sandbox/i);
  await unguarded.close();
  process.stdout.write("Real Node SDK sandbox smoke passed (model calls, file denials, persisted resume).\n");
} finally {
  await session?.dispose();
  await fs.rm(base, { recursive: true, force: true });
}
