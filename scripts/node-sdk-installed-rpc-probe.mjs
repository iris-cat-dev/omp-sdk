import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

// Keep the subprocess on the installed package's public Node RPC entrypoint.
const host = `import { startNodeRpcHost } from "@oh-my-pi/pi-coding-agent/sdk/rpc";
await startNodeRpcHost(JSON.parse(process.argv[1]));`;

function launch(options, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", host, JSON.stringify(options)], {
    cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const pending = new Map();
  let failure;
  let stderr = "";
  let sequence = 0;
  const fail = (error) => {
    failure ??= error;
    ready.reject(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.once("close", (code, signal) => {
    fail(new Error(`Installed SDK RPC exited: ${code}/${signal}\n${stderr}`));
    closed.resolve({ code, signal });
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    try {
      const frame = JSON.parse(line);
      if (frame.type === "ready") ready.resolve();
      if (frame.type !== "response") return;
      const request = pending.get(frame.id);
      if (!request) return;
      pending.delete(frame.id);
      if (frame.success === true && frame.command === request.command) request.resolve(frame.data);
      else request.reject(new Error(`Installed SDK RPC ${request.command} failed: ${JSON.stringify(frame)}`));
    } catch (error) { fail(error); }
  });
  async function bounded(promise, label) {
    const timeout = setTimeout(() => fail(new Error(`Installed SDK RPC ${label} timed out\n${stderr}`)), 30_000);
    try { return await promise; }
    finally { clearTimeout(timeout); }
  }
  return {
    ready: () => bounded(ready.promise, "ready"),
    async request(command, params = {}) {
      if (failure) throw failure;
      const id = `installed-smoke-${++sequence}`;
      const response = Promise.withResolvers();
      pending.set(id, { ...response, command });
      child.stdin.write(`${JSON.stringify({ id, type: command, ...params })}\n`);
      return await bounded(response.promise, command);
    },
    async close() {
      // EOF exercises the real RPC disposal path, then a fresh process reopens disk.
      child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
      try {
        const { code, signal } = await closed.promise;
        assert.equal(signal, null, `Installed SDK RPC shutdown signal\n${stderr}`);
        assert.equal(code, 0, `Installed SDK RPC shutdown failed\n${stderr}`);
      } finally { clearTimeout(timeout); lines.close(); }
    },
  };
}

async function journal(file, sessionId) {
  const entries = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const header = entries.find((entry) => entry.type === "session");
  assert.ok(header, "Ready session file lacks its session header");
  assert.equal(header.id, sessionId);
  assert.equal(entries.some((entry) => entry.type === "message"), false, "Idle RPC must not synthesize model messages");
  return entries;
}

export async function smokeInstalledRpc(cwd) {
  await fs.mkdir(cwd);
  // Never inherit provider credentials, auth brokers, proxies or the user's config.
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME",
    "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "PI_PROFILE", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const options = {
    cwd, agentDir: env.PI_CODING_AGENT_DIR,
    extraArgs: ["--no-extensions", "--no-lsp", "--no-context-files", "--no-skills", "--no-rules", "--no-tools"],
  };
  const customType = "desktop-local-submission";
  const data = { clientMessageId: "installed-sdk-annotation", text: "/save-local 😀", attachments: [{ type: "text", text: "first line\nsecond line" }] };
  let state;
  let annotation;
  const client = launch(options, env);
  try {
    await client.ready();
    state = await client.request("get_state");
    assert.equal(typeof state.sessionId, "string");
    assert.equal(typeof state.sessionFile, "string", "Ready must publish a durable session file");
    // Read before annotation or shutdown: those must not be what first creates it.
    await journal(state.sessionFile, state.sessionId);
    assert.deepEqual(await client.request("get_messages"), { messages: [] });
    const { entryId } = await client.request("append_session_annotation", { customType, data });
    assert.equal(typeof entryId, "string");
    // Acknowledgement must already be visible on disk, without waiting for close.
    const disk = await journal(state.sessionFile, state.sessionId);
    annotation = disk.find((entry) => entry.id === entryId);
    assert.ok(annotation, "Annotation ack preceded its durable journal entry");
    assert.equal(annotation.type, "custom");
    assert.equal(annotation.customType, customType);
    assert.deepEqual(annotation.data, data);
    const { entries } = await client.request("get_entries");
    assert.deepEqual(entries.find((entry) => entry.id === entryId), annotation);
    assert.deepEqual(await client.request("get_messages"), { messages: [] });
  } finally { await client.close(); }

  const resumed = launch({ ...options, session: state.sessionFile }, env);
  try {
    await resumed.ready();
    const restored = await resumed.request("get_state");
    assert.equal(restored.sessionId, state.sessionId);
    assert.equal(restored.sessionFile, state.sessionFile);
    const { entries } = await resumed.request("get_entries");
    assert.deepEqual(entries.find((entry) => entry.id === annotation.id), annotation, "Cold resume lost or changed the annotation");
    assert.deepEqual(await resumed.request("get_messages"), { messages: [] });
    const disk = await journal(restored.sessionFile, restored.sessionId);
    assert.deepEqual(disk.find((entry) => entry.id === annotation.id), annotation);
  } finally { await resumed.close(); }
}
