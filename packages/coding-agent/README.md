# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Mandatory sandbox sessions

For QQ and other untrusted conversation inputs, create a session with an existing dedicated directory:

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";

const { session } = await createAgentSession({
  sandbox: { root: "/srv/qq-files" },
  modelPattern: "openai/gpt-4o-mini",
  systemPrompt: "Answer briefly and in the user's language.",
});
```

By default the model receives only `sandbox_read`, `sandbox_write` and `sandbox_list`. Reads/writes are limited to 1 MiB; directory lists to 1024 entries. Paths are relative; `.` lists the namespace root. Absolute paths, traversal, URI/drive/UNC aliases, symlinks, special files and multiply-linked files are rejected. Parent directories for model writes must already exist.

The native POSIX implementation opens every component relative to a pinned directory descriptor with `O_NOFOLLOW`; replacing the root or racing a parent symlink cannot widen the grant. Writes publish a fresh inode instead of truncating a potentially linked file. The root must be absolute, must exist as a real directory, and cannot be the filesystem root or user home. Unsupported platforms or addons without this primitive fail closed; there is no realpath-only fallback. This restricts model capabilities, not the trusted host process or its model transport.

Opt in to isolated JavaScript and public HTTP requests independently:

```ts
const { session } = await createAgentSession({
  sandbox: { root: "/srv/qq-files", javascript: true, network: "public" },
  modelPattern: "openai/gpt-4o-mini",
});
```

`javascript: true` adds `sandbox_js`. Code is an async function body with `return`, standard JavaScript, `console.log`, and synchronous `sandbox.read/write/list`. Each call uses a fresh QuickJS-NG WASM guest: no Node globals, host imports, shell, or persistent guest state. Limits are 64 KiB source, a 32 MiB hard WASM memory ceiling including VM overhead, a 512 KiB guest stack guard reserving host-call-stack headroom, 5 seconds cumulative guest CPU, 30 seconds total wall time, 256 KiB JSON result and 64 KiB logs. File writes already performed survive an error or cancellation.

`network: "public"` adds `sandbox_fetch` and, when JavaScript is enabled, guest `fetch(url, { method, headers, body })`. It permits HTTP/HTTPS requests and data submission to arbitrary public addresses: authorized conversation users can send sandbox data off-host. Requests use a separate transport without ambient proxies, Cookies or credentials. Every DNS answer and redirect is checked; connections use a pinned public address. Private/localhost/metadata addresses, URL userinfo and transport/proxy headers are rejected. Cross-origin redirects clear explicit headers. Request and response bodies are limited to 1 MiB, redirects to five and the total request deadline to 30 seconds. Non-2xx responses retain their status and body. HEAD and HTTP no-content responses return an empty body without decoding representation headers. Guest responses provide `ok`, `status`, `url`, a lowercase header record, and async `text()`/`json()`.

Model selection and trusted model credentials remain available. An explicitly supplied `systemPrompt` string (or SDK string array) is retained as literal user instructions beneath the fixed sandbox policy, without filepath resolution or nested template/environment interpolation. Ambient context, prompt files/functions, append prompts, rules, skills, memory, MCP, extensions, host tools, command execution, browser/eval/task tools and identity/environment discovery are unavailable. Provider requests also omit the implicit date/cwd reminder. Later tool refreshes cannot widen the original catalog.

Saved sessions carry an SDK-owned sandbox policy. Reopening requires the same root and capabilities; changing permissions requires a new conversation. Unrestricted transcripts cannot be imported into a sandbox, and sandbox transcripts cannot resume without their sandbox configuration. Hosts must reopen the durable session through `createAgentSession` rather than switching arbitrary transcripts. Node RPC exports `NODE_RPC_SANDBOX_VERSION = 2`; Desktop accepts versions 1/2 for file-only sessions, requires version 2 for JavaScript/public networking, and rejects unknown versions.

Trusted gateways can import `openSandboxFs` from `@oh-my-pi/pi-coding-agent/sdk/sandbox` (`dist/node/sandbox.mjs`) without bootstrapping an agent. This pinned handle adds host-only `mkdir`, `stat`, `remove`, `close`, binary reads/writes and exclusive publication. The default byte bound is 1 MiB; a trusted caller may select up to 200 MiB with `maxBytes`. Close handles when the gateway stops; never expose the trusted media handle as model tools.

### Focused verification

Build Node artifacts with `bun --cwd=packages/coding-agent run gen:bundle:desktop`. Rebuild the native addon only when its source changes, and stage the development addon without replacing a user's installed App or unrelated generic addon.

From the monorepo root, with the source test process resolving the newly built real addon:

```sh
bun test packages/coding-agent/test/sandbox-fs.test.ts packages/coding-agent/test/sdk-sandbox.test.ts packages/coding-agent/test/sandbox-js.test.ts packages/coding-agent/test/sandbox-fetch.test.ts
OMP_SANDBOX_TEST_RPC_ENTRY=/path/to/staged-sdk/dist/node/rpc.mjs bun test packages/coding-agent/test/node-rpc-sandbox.test.ts
```

The RPC regression requires an explicit staged entry and otherwise skips; it inspects actual startup, tool mounting, literal prompts, provider request privacy and durable resume using an isolated local SSE transport. For genuine model tool calls, supply a real tool-capable provider and its approved credentials, isolate `HOME` and `PASEO_HOME`, then run:

```sh
node packages/coding-agent/scripts/smoke-sandbox.mjs /path/to/staged-sdk/dist/node openai/gpt-4o-mini
```

The smoke script creates and removes its own temporary files, checks real model use of all three tools, attempts outside/link escapes, and reopens the durable session. It never contacts or restarts the user's Desktop daemon.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
