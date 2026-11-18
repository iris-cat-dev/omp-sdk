# SDK

The SDK is the in-process integration surface for `@oh-my-pi/pi-coding-agent`.
Use it when you want direct access to agent state, event streaming, tool wiring, and session control from a Bun or headless Node.js process.

If you need cross-language/process isolation, use RPC mode instead.

## Installation

```bash
bun add @oh-my-pi/pi-coding-agent
```

Requires Bun 1.4.4 or newer, or Node.js 24 or newer for the headless backend (24.14+ recommended).
Before the first model-backed prompt, configure credentials for a provider or run
a keyless local provider; see [Providers](./providers.md). Session construction can
succeed without an available model, but prompting cannot.

### Node.js and Electron

The package root and `/sdk` select the compiled headless SDK under Node. No Bun
installation or embedded Bun runtime is needed by the application. The Bun CLI,
interactive terminal UI, and CLI-based RPC launcher remain separate Bun entrypoints.

For a source checkout, build the Node artifacts before importing the package:

```bash
bun --cwd=packages/coding-agent run gen:bundle:node
node client.mjs
```

Building uses Bun; running the resulting SDK does not. Keep the complete
`packages/coding-agent/dist/node/` directory, including `host.mjs`, `plugins.mjs`,
`modules.json`, chunks, and assets, together. Also retain `pi-utils/dist/node/`
adapters and package dependencies. Copying only `sdk.mjs` is insufficient.

Bundling itself does not load `pi-natives`. Build the matching platform's native
addon before staging or running the SDK.

Desktop can build a separate, bounded artifact without replacing the generic SDK:

```bash
bun --cwd=packages/coding-agent run gen:bundle:desktop
```

This writes `dist/node-desktop/`. The reusable `stageNodeSdk` API selects it with
`buildTarget: "desktop"` and installs the complete artifact at the normal
`dist/node/` location. Its extension module map retains package roots plus the
coding-agent `/sdk`, `/headless`, `/async`, and `/extensibility/host-api` aliases,
plus the provider helpers `pi-ai/providers/transform-messages`,
`pi-ai/utils/{retry-after,tool-call-arguments,empty-completion-retry}`,
`pi-catalog/build`, and `pi-tui/chrome/qrcode` (all under `@oh-my-pi/`).
It does not mirror every source-file export. Extensions needing other deep SDK
imports should use the generic target. Tools, RPC, and session persistence remain
reachable through the same SDK APIs; offline workers require the `full` profile.
`gen:bundle:node` writes the independent generic `dist/node/` artifact and defaults
to `full`; `gen:bundle:desktop` defaults to `core`.

Node uses its native SQLite driver with the existing OMP schemas and JSONL
session format. Executable plugins, extensions, custom tools/commands, and eval
support JavaScript only; no TypeScript compiler is shipped. Precompile
TS/TSX/MTS/CTS/JSX modules to `.js`, `.mjs`, or `.cjs` and point plugin manifests
at the emitted files. Reading or editing TypeScript source remains supported;
the standalone Bun CLI retains its built-in TypeScript transpilation.
Extension imports resolve to the host's shared SDK modules. Workers re-enter a
single Node host using the same selectors as the Bun CLI. Installing additional
JS dependencies or plugin packages under Node requires npm on PATH.
Concurrent Node plugin imports share a CommonJS reload wave; cache entries are
invalidated only between completed waves, never during an active module import.

In Electron, run the SDK in a Node-enabled utility process or backend rather
than an isolated renderer. Package the platform-specific native addon outside
the ASAR archive. The macOS arm64 addon has been exercised with Electron 41.2.0
(Node 24.14.0); other platforms require their matching addon and validation.

The macOS arm64 Desktop runtime `@iriscat/mini-electron` 0.1.12 (embedded Node
24.0.0-pre) has also exercised model streaming, native write/read/bash tools,
session save/restore and cancellation through the SDK RPC host.

Node-only entrypoints include targeted `core-js` shims and initialize them only
when the embedded engine lacks `RegExp.escape` or `DisposableStack`; native
implementations are retained. The complete `core-js` npm tree is not required.
Bun CLI entrypoints do not load this compatibility initialization.

Select the JavaScript profile when building, then stage that same profile:

```bash
bun --cwd=packages/coding-agent run gen:bundle:desktop --profile=core
bun --cwd=packages/coding-agent run gen:bundle:node --profile=full
```

Both targets accept `--profile=core|full`. The exported build API is
`bundleNodeSdk(outDir?, buildTarget = "generic", profile?)`; omitted profiles
default to `full` for generic and `core` for Desktop. `modules.json`,
`runtime-dependencies.json`, and `target/node-sdk-build-inputs/<target>.json`
record the built profile. Staging refuses a different profile; rebuild before
switching profiles. The installed package's `ompNodeSdk.profile` must match the
compiled artifact, independently of the launcher's environment. Unmarked source
builds use their compiled profile; source/Bun execution without a compiled profile
defaults to `full`.

Core excludes local embedding, offline speech, tiny inference worker/client
implementations, SmolLM downloads, and the MLX Python script from the JavaScript
graph. Public offline operations fail with guidance to configure a remote
service or use `full`, before workers or downloads start. Remote/API models,
remote TTS, embeddings and title models, native tools, browser support, RPC,
saved sessions, and cancellation remain available. Ngram and Apple prediction
also remain available when supported by the selected native addon.
Memory can use remote embeddings and remote inference, or explicitly disabled
embeddings/inference; default local memory configuration is unavailable in core.

Source/Bun and `full` builds re-export the original local clients and helpers,
preserving subclass overrides, live helper bindings, and process-shared client
shutdown. The `core` build selects separate disabled-capability implementations
for clients, downloaders, local embedding initialization, and offline worker
dispatch, with no import edge to their full inference implementations. Shared
worker inbox installation, IPC transport, and parent-disconnect cleanup remain
identical between profiles.

Node builds exclude the Bun-only extension loading and source-rewrite graph.
JavaScript ESM/CJS extensions retain host aliases, shared module identity,
cache/reload behavior, and access to adjacent resources. The Bun CLI keeps its
original loader and TypeScript support.

The JavaScript `core` profile is independent of native Cargo features. Desktop
also uses an isolated native addon built with:

```bash
bun run --cwd packages/natives build:desktop
```

This forces the release profile with `--no-default-features`, uses
`target/desktop`, and writes the canonical addon and JSON sidecar to
`packages/natives/native/desktop/`. Rebuild it after native source or package
version changes before staging Desktop. It disables the default-on `pi-natives`
features `smollm`, `live-voice`, `wasm-grammars`, `pdf`, `vcs-jj`, `snapcompact`,
`audio`, `local-assistance`, and `syntax-highlighting`. Native PDF extraction,
Jujutsu, image-based Snapcompact compression, recording/playback, prediction,
spelling, Apple Foundation Models, and syntect TUI syntax highlighting are
unavailable in Desktop, including its `full` profile. OMP Desktop's independent
Lezer renderer/editor highlighter remains available.
Git, file editing/search, Shell, ordinary images, and built-in code parsing and
AST operations remain available. Browser PDF screenshots/printing are independent
of native PDF extraction; remote TTS/transcription data APIs remain independent
of local capture/playback.

For incremental Desktop source development, use:

```bash
bun --cwd=packages/natives run build:desktop --development --baseline
```

Omit `--baseline` on non-x64 hosts. This fixes the Cargo profile to `local`
(thin LTO, 16 codegen units, incremental), retains the same disabled features,
and isolates the addon/sidecar in `native/desktop/local/`. Cargo uses a separate
profile directory under `target/desktop`; its first build must populate that
cache. Default `build:desktop` remains release-only, and `--development` without
`--desktop` is rejected. Development staging must explicitly select
`buildMode: "development"`; release staging never borrows the local addon.

With `buildTarget: "desktop"`, staging requires this isolated artifact,
checks its sidecar and raw binary capabilities, package version, and SHA-256,
and excludes optional full-native platform leaf packages so they cannot
reintroduce the full addon. The `generic` target retains normal full-native
selection; generic SDK and Bun CLI defaults remain full. Rebuild full bindings
with `bun run --cwd packages/natives build:bindings`; only a full build
regenerates the full native declarations and exports.

For an x64 shipping build, pass `--baseline` to `build:desktop`. It selects the
existing x86-64-v2 baseline filename and CPU floor even on an AVX2 build host;
ordinary local builds retain their automatic baseline/modern selection.

Import `readNativeCapabilities()` from the SDK to inspect the loaded binary's
`smollm`, `liveVoice`, `wasmGrammars`, `pdf`, `jujutsu`, `snapcompact`, `audio`,
`localAssistance`, and `syntaxHighlighting` flags rather than inferring support from the JS profile or
declarations. The validated report is immutable and cached. Explicit activation
of an omitted engine fails before downloads or native construction; saved
settings are effectively disabled. Existing Snapcompact archives remain readable
without rendering new frames. Live sessions with a caller-supplied `sdpOffer`
still support signaling and return `sdpAnswer` without native WebRTC or local
audio: the caller owns its peer, microphone, playback, and track muting.

For an isolated Node child that needs the existing full RPC protocol rather than
an in-process session, import `startNodeRpcHost` from
`@oh-my-pi/pi-coding-agent/sdk/rpc`:

```ts
import { startNodeRpcHost } from "@oh-my-pi/pi-coding-agent/sdk/rpc";

await startNodeRpcHost({ cwd: process.cwd(), protocolMode: "rpc-ui" });
```

This owns stdin/stdout for the RPC protocol and runs until shutdown. Use a separate
process for each top-level agent to isolate environment, extension hooks and
cancellation. Discovered extensions must support Node; Bun-only extensions fail
startup rather than being silently ignored.

### Platform-specific Desktop core releases

`scripts/stage-node-sdk.mjs` owns the single staging implementation. Its API is:

```js
import { stageNodeSdk } from "./scripts/stage-node-sdk.mjs";

const staged = await stageNodeSdk(absoluteCodingAgentPackageRoot, outputDirectory, {
  platform: process.platform,
  arch: process.arch,
  buildTarget: "desktop",
  profile: "core",
  buildMode: "release",
  // Optional: persistent npm file-list cache root; defaults to an OS-temp cache.
  // cacheDir: absoluteCacheDirectory,
});
```

The source is an absolute package root with built SDK artifacts and installed
production dependencies, not `dist/node` or an entry file. The target, capability
profile, and build-mode options have the defaults shown above. `generic`/`full`
remain available explicitly. Release staging returns the manifest fields plus
`archive` (`omp-sdk.tgz`) and `directory` (the staged SDK package). It verifies
the final npm archive rather than just the build tree.

Koffi staging keeps its JavaScript entries, target-native addon (including the
Linux musl fallback), and root/vendor licenses. Source, documentation, types,
install scripts, and build configuration are not runtime dependencies.

`buildMode: "development"` instead validates and copies the complete runnable
directory without the final npm pack/compression step and returns `archive: null`.
The manifest and installed package record the build mode. Desktop development
requires the isolated `local` addon and checks the same version, SHA-256 and
capabilities as release staging. Production consumers reject this mode.

Staging persistently caches npm's package file selections, keyed by actual
package/workspace contents, lock/configuration/build inputs, host target, and
Node/npm versions. It still copies current bytes and validates runtime paths;
changing a package without changing its version cannot silently reuse its old
file selection. `cacheDir` changes only the cache location. Build-only dependency
resolution edges are returned as `dependencyInputs`, not shipped in the manifest.

Staging never reads Desktop environment configuration or modifies source inputs.
Native staging is host-only: a macOS arm64 installation cannot generate a Linux
or x64 native dependency closure. Complete modules, worker host, chunks, runtime
resources, licenses, and selected native sidecars are retained in both modes.

The pinned release contract is `sdk/node-release.json`:
`iris-cat-dev/omp-sdk`, tag `sdk-v18.14.0-desktop-core.1`, Desktop/core, and
`darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`. Linux hosts must use
glibc; Windows and musl are not supported. The SDK version comes from the
coding-agent package manifest, not a separate npm version or a `latest` tag.
Each target asset is `omp-sdk-desktop-core-${target}.tgz` and is an installable npm
archive with its real matching native dependencies. The index asset is
`omp-sdk-release.json` (schema 1), containing package/version/minimum Node version,
build target/profile and the exact asset name, SHA-256, byte size and SHA-512 SRI
for every target.

On **each matching native host**, using Node.js 24.14.0, npm 11.17.0, Bun 1.4.4
and the repository-pinned Rust toolchain:

```bash
bun install --frozen-lockfile
# x64: use --baseline; arm64: omit --baseline.
bun --cwd=packages/natives run build:desktop --baseline
bun --cwd=packages/coding-agent run gen:bundle:desktop
node scripts/release-node-sdk.mjs stage sdk-release-dist
node scripts/smoke-node-sdk.mjs sdk-release-dist
```

The smoke copies the exact tarball into a throwaway npm project, generates its
lockfile, checks the archive integrity, and runs `npm ci --offline --ignore-scripts`.
Its installed Node probe exercises SDK imports, native version/capabilities,
write/read/Shell tools, embedded SDK documentation, native SQLite, the real sharp
image codec, koffi, an extension-module alias and the installed shared worker host.
It cannot import the source SDK or silently use the source `node_modules` tree.
A successful smoke produces a target/byte-hash/Node-version receipt; a failed
smoke removes any old receipt. Local model/API credentials are not needed.

Collect all four tarballs, target records and smoke receipts in one directory:

```bash
node scripts/release-node-sdk.mjs index sdk-release-dist
```

Index generation rejects missing, duplicate or incompatible targets, modified
bytes, non-baseline x64 addons and absent/mismatched installed-smoke receipts.
It also writes bilingual `release-notes.txt`. Dispatch **Node SDK release (draft
only)** (`.github/workflows/sdk-node-release.yml`) to do this end-to-end on public
GitHub-hosted native runners. Only after all four jobs pass does the workflow
generate an index and upload four tarballs plus the index to the same draft,
then download and hash the uploaded bytes. It uses the repository Actions token,
not private CI runners/caches, signing credentials or local `gh` login. It never
publishes npm packages, upstream CLI binaries or the draft itself. Review the
bilingual notes and all five assets before publishing in GitHub. A published tag
is immutable for this workflow; use a new pinned SDK release tag for new bytes.

Before publishing, select the exact tag from `sdk/node-release.json` and the
commit used by the successful Actions run. GitHub may display an `untagged-*`
placeholder for a draft; do not publish that placeholder. Desktop's download
URLs require the configured SDK tag.

**中文：** SDK 暂存实现统一位于子模块 `stageNodeSdk`，通过显式参数选择
desktop/core；不会读取 Desktop 环境配置，也不会伪造跨平台原生依赖。
四个平台必须分别在对应真实主机安装锁定依赖、构建原生插件并运行最终压缩包
的 npm ci 烟测。x64 发布使用 `--baseline`，Linux 仅支持 glibc。
固定发布配置为 `sdk/node-release.json`；SDK npm 版本不变，每个平台发布独立
压缩包，完整索引记录文件名、大小、SHA-256 与 SHA-512 SRI。
手动运行独立的 **Node SDK release (draft only)** 工作流即可构建四个平台，
无需上游私有运行器或密钥，也不会触发 npm/CLI 发布。
只有四个平台烟测全部通过后才生成索引、上传同一发布草稿并重新下载校验资产。
必须人工核对双语说明和四个压缩包加索引，再正式发布；失败或资产缺失时不得
声称发布就绪。已发布标签不会被覆盖，更新时必须使用新的固定 SDK 标签。

正式发布前，必须选择 `sdk/node-release.json` 中的准确标签，以及已通过烟测的
Actions 运行对应提交。GitHub 草稿可能显示 `untagged-*` 占位标识；不要使用该
占位标签发布，否则 Desktop 固定版本的下载地址无法访问。


### Plugin management in a dedicated Node child

`@oh-my-pi/pi-coding-agent/sdk/plugins` exports `runNodePluginCommand(args)`.
Pass the complete plugin argv, including `plugin`:

```ts
import { runNodePluginCommand } from "@oh-my-pi/pi-coding-agent/sdk/plugins";

await runNodePluginCommand(["plugin", "list", "--json"]);
```

Run this entry in a separate child: it preserves the CLI parser, stdout/stderr,
exit codes, cwd, profiles, plugin stores and marketplace behavior, including
commands that call `process.exit`. It does not create a model session. Local
linking, listing and toggling do not need a package manager; npm/Git package
installation still needs npm or Bun on PATH. Do not silently substitute a CLI
when a selected SDK is missing or incompatible.


## Entry points

Under Bun, the package root, `@oh-my-pi/pi-coding-agent`, is the complete embedding surface. Under Node, it exports the headless surface without CLI modes or interactive frontend exports. Both include session, auth, model, extension, and tool APIs.

Import these core embedding APIs from the package root:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `AgentRegistry`
- `discoverAuthStorage`
- Discovery helpers (`discoverExtensions`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`, `discoverMCPServers`)
- Tool factory surface (`createTools`, `BUILTIN_TOOLS`, tool classes)

Under Bun, the narrower `@oh-my-pi/pi-coding-agent/sdk` subpath exports `createAgentSession`, its option/result types, `Settings`, `AgentRegistry`, discovery and system-prompt helpers, workspace-tree helpers, selected extension/MCP/tool types, and selected tool classes/factories. It does **not** export `SessionManager`, `AuthStorage`, or `ModelRegistry`; import those three from the package root as the examples below do. Under Node, `/sdk` and the package root share the same headless entry and include these three APIs.

The injected `api.pi` in extensions, hooks, custom commands, and custom tools resolves the host SDK on first access. Registering callbacks or loading bundled commands does not eagerly load the full SDK and interactive composer.

## Quick start (auto-discovery defaults)

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
	process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

## What `createAgentSession()` discovers by default

`createAgentSession()` follows “provide to override, omit to discover”.

If omitted, it resolves:

- `cwd`: `getProjectDir()`
- `agentDir`: `~/.omp/agent` (via `getAgentDir()`)
- `authStorage`: `discoverAuthStorage(agentDir, { settings, cwd })`
- `modelRegistry`: a `ModelRegistry` using that auth store, `<agentDir>/models.yml`, effective settings, and the agent-directory model cache; background `refreshInBackground()` when the registry is not provided
- `settings`: `await Settings.init({ cwd, agentDir })`
- `sessionManager`: `SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))` (file-backed)
- skills/rules/context files/prompt templates/slash commands/extensions/custom TS commands
- built-in tools via `createTools(...)`
- MCP tools (enabled by default; Exa MCP servers are folded into native Exa integration, and browser automation MCP servers are filtered when the built-in Eval browser prelude is enabled)
- LSP integration (enabled by default)
- `eventBus`: new `EventBus()` unless supplied

### Required vs optional inputs

Typically you must provide only what you want to control:

```ts
function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
```

- **Must provide**: nothing for a minimal session
- **Usually provide explicitly** in embedders:
   - `sessionManager` (if you need in-memory or custom location)
   - `authStorage` + `modelRegistry` (if you own credential/model lifecycle)
   - `model` or `modelPattern` (if deterministic model selection matters)
   - `settings` (if you need isolated/test config)

For multiple concurrent top-level sessions in one process, pass a private
`AgentRegistry` to each session. The default process-global registry admits
only one `"Main"` identity per generation.

## Proxy routing

Pass an explicit policy when constructing a session, then replace it through the live session API:

```ts
const { session } = await createAgentSession({
	proxyPolicy: {
		enabled: true,
		default: { mode: "proxy", url: "http://127.0.0.1:7890" },
		providers: {
			anthropic: { mode: "proxy", url: "http://127.0.0.1:7891" },
			"openai-codex": { mode: "direct" },
		},
		noProxy: [".internal.example"],
	},
});

session.setProxyPolicy({ ...session.getProxyPolicy(), enabled: false });
```

`setProxyPolicy` validates and replaces the whole policy. Provider IDs are exact, not normalized environment-key names. Missing provider routes use `default`; a missing default or `enabled: false` means direct. HTTP(S) URLs must have no path, query, or fragment. Unsupported proxies fail before changing the active policy.

Independent sessions have independent controllers. Nested task/eval sessions inherit their conversation's live controller. Changes take effect on subsequent HTTP requests and WebSocket responses without interrupting active work or restarting a process. The SDK does not persist this embedding option in JSONL: restore the policy from the embedding application's conversation configuration. Desktop persists that configuration and supports host inheritance.

Provider-scoped OAuth, usage, discovery, model/media/judgment calls, and remote compaction follow the same routing. Ordinary tool/MCP fetches, private/metadata destinations, and `noProxy` matches stay direct. Proxy environment variables no longer choose OMP routes. RPC hosts expose the same operation as `{ "type": "set_proxy_policy", "policy": { "enabled": false } }`; `RpcClient.setProxyPolicy(policy)` returns the accepted policy.

Broker refresh uses `POST /v1/credential/:id/refresh-with-proxy-policy` with the effective policy. Upgrade broker and clients together; the old refresh endpoint is removed. A proxy used by delegated refresh must be reachable from the broker host, not only from the desktop.

## Session manager behavior (persistent vs in-memory)

`AgentSession` always uses a `SessionManager`; behavior depends on which factory you use.

### File-backed (default)

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd()),
});

console.log(session.sessionFile); // absolute .jsonl path
```

- Persists conversation/messages/state deltas to session files.
- Supports resume/open/list/fork workflows.
- `session.sessionFile` is defined.

File-backed history retains lightweight lazy entry facades, not every parsed
body. Hot body retention is budgeted at 8 MiB with a separate 8 MiB body LRU;
evicted bodies are reread from the persisted source for history and fork use.
Complete `File` bodies are persisted without generic 500,000-character tool-text
truncation. Images remain externalized and private fields are stripped from
public history. Body accounting is not a physical-memory or live-heap limit.

Cold readers use the indexed session journal; Node embedders resolve
`@oh-my-pi/pi-coding-agent/session/indexed-session-journal` through the selected
build's `dist/node/modules.json`. Do not start a session host or add another
scanner for history. Report initial index/catalog scanning separately from warm
small-page I/O. Cold metadata/history reads do not wake sessions; dynamic state
without a retained snapshot is explicitly unavailable.
This requires a real built Node SDK containing the manifest and journal export,
including for embedders whose agent execution uses CLI. Missing packages or
artifacts are a cold-history prerequisite error, not permission to fall back to
another scanner or launch a host.

### In-memory

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});

console.log(session.sessionFile); // undefined
```

- No filesystem persistence.
- Useful for tests, ephemeral workers, request-scoped agents.
- Session methods still work, but persistence-specific behaviors (file resume/fork paths) are naturally limited.

### Resume/open/list helpers

```ts
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

## Model and auth wiring

`createAgentSession()` uses `ModelRegistry` + `AuthStorage` for model selection and API key resolution.

If both `authStorage` and `modelRegistry` are supplied,
`modelRegistry.authStorage` MUST be the same instance; session creation rejects
divergent stores.

### Explicit wiring

```ts
import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager } from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const available = modelRegistry.getAvailable();
if (available.length === 0) throw new Error("No authenticated models available");

const { session } = await createAgentSession({
	authStorage,
	modelRegistry,
	model: available[0],
	thinkingLevel: "medium",
	sessionManager: SessionManager.inMemory(),
});
```

### Selection order when `model` is omitted

When no explicit `model`/`modelPattern` is provided:

1. restore model from existing session (if restorable + key available)
2. settings default model role (`default`)
3. an authenticated provider-default model in availability order (falling back to the first authenticated available model when no provider default is present)

If restore fails, `modelFallbackMessage` explains fallback.

### Auth priority

`AuthStorage.keys.get(...)` resolves in this order:

1. runtime override (`keys.setRuntime`, used by CLI `--api-key`)
2. config-sourced API key override (`models.yml` provider `apiKey`)
3. stored OAuth credential, including refresh when needed
4. API key persisted by a successful `/login`
5. provider environment variables
6. other stored API-key credential in `agent.db` / broker-backed storage

Configured values are resolved asynchronously through the registry-installed resolver; catalog construction does not execute credential commands. `ModelRegistry.getProviderHeaders(provider)` and `resolveModelHeaders(model, signal?)` return promises. For direct provider requests, await the latter instead of reading config-backed values from `model.headers`. The AI client's `stream()` and `streamSimple()` materialize `model.resolveHeaders` automatically for each request attempt, including authentication retries.

## Event subscription model

Subscribe with `session.subscribe(listener)`; it returns an unsubscribe function.

```ts
const unsubscribe = session.subscribe(event => {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
		case "tool_execution_start":
			break;
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
			break;
	}
});
```

`AgentSessionEvent` includes core `AgentEvent` plus session-level events:

- `auto_compaction_start` / `auto_compaction_end`
- `manual_compaction_start` / `manual_compaction_end` (`compact()`, `/compact`, extension `ctx.compact()`)
- `auto_retry_start` / `auto_retry_end`
- `retry_fallback_applied` / `retry_fallback_succeeded`
- `model_changed`
- `thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder` / `todo_auto_clear`
- `irc_message`
- `notice`
- `goal_updated`
- `queue_update` (displayable `steering` and `followUp` string-array snapshots)
- `cache_warming_start` / `cache_warming_end`
- `config_warnings_changed`
- `advisor_cost_changed` / `advisor_yielded`

`agent_end` includes `messages`, optional telemetry fields, and
`isTerminal?: boolean`. When `isTerminal` is `false`, maintenance or async
delivery will resume the session before its true final settle. Subscribers that
use `agent_end` as a completion signal MUST wait for `isTerminal !== false`.
Treat an absent field as terminal for compatibility with older runtimes.

`yielded?: boolean` distinguishes an agent that finished its work from one
continuing through retry, compaction, or stop-time reminders.
`awaitingAsyncWork?: boolean` marks a non-terminal end whose only possible wake
is a background-job result; that wake is not guaranteed if the job is cancelled
or its delivery is suppressed.

## Prompt lifecycle

`session.prompt(text, options?)` is the primary entry point.

Behavior:

1. optional command/template expansion (`/` commands, custom commands, file slash commands, prompt templates)
2. if currently streaming:
   - `streamingBehavior: "steer" | "followUp"` chooses how `prompt()` queues
   - extension `sendUserMessage(content)` defaults to steer when `deliverAs` is omitted
   - queued messages are preserved instead of throwing work away
3. if idle:
   - validates model + API key
   - appends user message
   - starts agent turn

Related APIs:

- `sendUserMessage(content, { deliverAs?, attribution? })`
- `steer(text, images?, { attribution?, clientMessageId? })`
- `followUp(text, images?, { synthetic?, attribution?, clientMessageId? })`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

`deliverAs: "aside"` (both APIs) delivers at the next agent step boundary without interrupting the current tool batch, instead of steering (which skips remaining tools) or waiting for the run to finish. The one exception is a running interruptible `wait` or `vibe_wait`, which an aside ends so the message is not delayed behind it. When the session is idle both start a turn instead (in plan mode the custom message is folded into context without a turn).

Hosts can pass a distinct `clientMessageId` in `prompt` options or the third options argument of `steer`/`followUp`. The identifier survives prompt expansion, queues, user-message events, and persisted history; it is kept out of model input. Correlate native echoes by this identifier rather than transformed or repeated text.

`getUserMessagesForBranching({ activeBranchOnly: true })` returns user-message targets on the current branch, including their optional `clientMessageId`. Omitting the option retains the default query over all stored entries in the current session. Branching to a prompt creates a transcript containing its preceding history.

## Idle maintenance

A session starts no autonomous idle work until its owner opts in with `session.enableIdleMaintenance({ isBlocked?, scheduledTurn?, onRecap? })`; the interactive TUI does, SDK, RPC and print sessions do not. After a turn whose last message is a generated assistant reply (text, thinking or a tool call, even if the turn was then aborted), once nothing is live, admitted, queued or scheduled, the session generates the idle recap (`recap.*` settings), journals it in the history database and passes the full nonblank reply to `onRecap`; the recap never enters the transcript or model context. Idle compaction (`compaction.idle*` settings) also waits until no background job or delivery can wake the session. `isBlocked` says the owner wants no autonomous work (a draft being composed, a view that left, startup unfinished); `scheduledTurn` says the owner has decided to start a turn it has not yet admitted. Call `session.refreshIdleMaintenance()` when either answer changes: work that is no longer wanted is dropped and what the stretch still owes is re-armed with a fresh delay. Repeated activation keeps the first owner's options; session disposal owns cleanup.

## `AgentSession` lifecycle and disposal

Call `await session.dispose()` when the embedder is completely done with a session. `dispose()` starts disposal itself and is idempotent: repeated or concurrent calls receive the same teardown promise, so shutdown events and owned resources are not drained twice.

`beginDispose()` is the synchronous admission barrier for wrappers that must await their own teardown before calling `dispose()`. Call it before the wrapper's first `await`; otherwise deferred work can enter the gap. It immediately marks the session disposed, cancels memory startup, title generation, and auto-learn capture, clears queued yield/asides, stops advisor runtime, detaches aside delivery, and rejects new eval executions. Deferred session work checks the disposed state and is dropped or skipped. `beginDispose()` is also idempotent, and the later `dispose()` call remains required to finish asynchronous cleanup.

```ts
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

async function closeEmbeddedSession(session: AgentSession, closeHostInputAndUi: () => Promise<void>): Promise<void> {
	session.beginDispose(); // no new deferred work may enter after this point
	await closeHostInputAndUi();
	await session.dispose();
}
```

During asynchronous disposal, the session records and synchronously flushes its exit diagnostic, emits `session_shutdown` once, stops extension fallback timers, aborts retries, compaction, and the active agent turn, and gives post-prompt and auto-learn work bounded time to settle. It then tears down session-owned async jobs, eval kernels, browser tabs, native computer sessions, MCP connections, advisor state, and memory state concurrently. These subsystem drains are best-effort and bounded where applicable; failures are logged rather than preventing the remaining subsystem cleanup.

Only after work capable of appending session entries has settled does disposal clean up an empty moved session, close the `SessionManager`, close provider session state, disconnect the agent, and remove listeners. A failure from the final persistence cleanup or `SessionManager.close()` rejects the shared disposal promise; individual provider-session close failures are logged.

`session.getRuntimeResources()` returns resource `id`, `kind`
(`python_kernel`, `javascript_kernel`, `shell`, `helper`), `ownerSessionId`,
optional `ownerAgentId`/`pid`, `state`, `retentionReasons`, `liveHandles`, and
`releasable`. `session.releaseRuntimeResource(resourceId)` is an explicit,
destructive release of that resource's variables. Busy/shared resources and
resources required by background work refuse release. RPC hosts expose
`get_runtime_resources` and `release_runtime_resource` with `resourceId`.

Safe runtime unload is distinct from abort or unconditional disposal. Embedders
must inventory, drain persistence, inventory again, and synchronously close
admission at the final eligibility check. Active/admitted work, unconfirmed
content, permissions, background dependencies and retained variables/resources
prevent unload. Desktop uses stable owner `desktop:<agentId>` across rewind and
considers idle unload after five minutes, with a 30-second recheck.

`SessionManager.releaseRetainedEntries()` is a terminal release after session
disposal and persistence close, not a cache eviction for a reusable session.
It must not be used to bypass data or variable retention gates. Accounting bytes,
JavaScript heap, macOS `phys_footprint`, and Windows process commit are distinct;
body budgets do not enlarge the compressed 4 GiB V8 cage or prove native UI or
Windows qualification.

## Tools and extension integration

### Live tool approval mode

Read `session.approvalMode` or call `session.setApprovalMode(mode)` to change permissions while the session is working or awaiting approval:

```ts
session.setApprovalMode("always-ask");
session.setApprovalMode("yolo");
```

Supported modes are `always-ask`, `always-ask-cached`, `write`, and `yolo`. `createAgentSession({ autoApprove: true })` selects `yolo` initially; it does not prevent later changes. The setter writes the session's in-memory settings override, not a persisted default. Embedders sharing one `Settings` instance also share its approval mode.

Session-generated tool calls use the live mode. Pending approvals are re-evaluated without restarting the turn; already-executing tools continue. Explicit tool/user policies, restricted folders, and provider safety checks remain authoritative. For process-isolated backends, use RPC [`set_approval_mode`](./rpc.md#set_approval_mode-payload).


### Built-ins and filtering

- Built-ins come from `createTools(...)` and `BUILTIN_TOOLS`.
- `toolNames` requests named tools and can enable tools that are disabled by
  default; by itself it is **not** an allowlist.
- Set `restrictToolNames: true` to limit the session to the names in
  `toolNames`. Restricted sessions disable ambient MCP, extensions, custom
  commands, and LSP by default.
- Restricted children retain hooks/providers from the parent's
  `preloadedPreparedExtensions`, rebound to their own session. Contributed tools
  cannot extend or replace the restricted tool set, even when registered later.
- In a restricted session, SDK-supplied `customTools` are excluded unless
  `allowRestrictedCustomTools: true` and their names also appear in
  `toolNames`.
- Hidden tools (for example `yield`) are opt-in unless required by options.

```ts
const { session } = await createAgentSession({
	toolNames: ["read", "grep", "glob", "write"],
	restrictToolNames: true,
	requireYieldTool: true,
});
```

### Extensions

- `extensions`: inline `ExtensionFactory[]`
- `additionalExtensionPaths`: load extra extension files
- `disableExtensionDiscovery`: disable ambient scanning; explicit paths and
  inline factories still load
- `preloadedExtensions`: reuse an extension set loaded early by the same
  session-owning process. Never pass loaded extension instances from a parent
  to another session; use `preloadedPreparedExtensions` so each session gets its
  own `ExtensionAPI` binding.
- `preloadedPreparedExtensions`: already-imported factories to rebind, including
  in restricted children; does not reevaluate the module graph.
- `extensionRoots`: a live owner-root provider for child discovery and revival.
  Its explicit roots, discovery mode, and configured roots take precedence over
  the child's local extension-loading inputs.

### Runtime tool set changes

`AgentSession` supports runtime activation updates:

- `getActiveToolNames()`
- `getAllToolNames()`
- `setActiveToolsByName(names)`
- `refreshMCPTools(mcpTools)`

System prompt is rebuilt to reflect active tool changes.

## Discovery helpers

Use these when you want partial control without recreating internal discovery logic:

- `discoverAuthStorage(agentDir?, options?)` (effective settings/cwd and credential-discovery options)
- `discoverExtensions(cwd?)`
- `discoverSkills(cwd?, _agentDir?, settings?)`
- `discoverContextFiles(cwd?, _agentDir?, disabledExtensions?)`
- `discoverPromptTemplates(cwd?, agentDir?)`
- `discoverSlashCommands(cwd?)`
- `discoverCustomTSCommands(cwd?, agentDir?)`
- `discoverMCPServers(cwd?)`
- `buildSystemPrompt(options?)`

## Host integration options

- `hasUI` defaults to `false`; enable it only for hosts with interactive UI.
- `interactivePrompts` defaults to `hasUI`. A non-TUI host that can answer
  synchronous prompts can set it to `true` to enable `ask` without enabling
  UI-only startup behavior such as LSP warmup.
- `telemetry: {}` enables agent-loop OpenTelemetry spans. Without a registered
  host OpenTelemetry SDK, the API uses a no-op tracer.
- `additionalDirectories` adds absolute or cwd-relative workspace roots.
- `providerSessionId` can reuse provider-side session identity while session
  persistence stays isolated; `providerPromptCacheKey` sets a separate cache key.
- `systemPromptTemplate`, `customSystemPrompt`, `appendSystemPrompt`, and
  `systemPrompt` control different prompt layers. See
  [System prompt customization](./system-prompt-customization.md) for their
  replacement and discovery contracts.

## Subagent-oriented options

For SDK consumers building orchestrators (similar to task executor flow):

- `outputSchema`: passes structured output expectation into tool context
- `outputSchemaMode`: selects permissive or strict structured-output enforcement
- `requireYieldTool`: forces `yield` tool inclusion
- `taskDepth`: recursion-depth context for nested task sessions
- `parentTaskPrefix`: artifact naming prefix for nested task outputs
- `bindProcessState`: `false` for helper sessions spawned on a host session's behalf (see below)

These are optional for normal single-agent embedding.

Process-wide state that follows one settings instance — setting effects (theme, request limits, the fallback credential-redaction switch) and discovery provider toggles — is held by every top-level session on its own `settings` until it is disposed. With several live sessions the newest holder drives it, and disposing a session hands it back to the previous holder. Sessions with `parentTaskPrefix`/`taskDepth` or `bindProcessState: false` never take it. Independently of the holder, each session's own provider requests redact credential-shaped tokens per that session's `secrets.enabled`.

## `createAgentSession()` return value

```ts
type CreateAgentSessionResult = {
	session: AgentSession;
	extensionsResult: LoadExtensionsResult;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	mcpManager?: MCPManager;
	modelFallbackMessage?: string;
	lspServers?: Array<{
		name: string;
		status: "connecting" | "ready" | "error" | "available";
		fileTypes: string[];
		error?: string;
	}>;
	startBackgroundModelDiscovery?: () => Promise<void>;
	eventBus: EventBus;
	subagentEventBus?: EventBus;
};
```

Use `setToolUIContext(...)` only if your embedder provides UI capabilities that tools/extensions should call into.

`subagentEventBus` carries `task:subagent:*` observability frames across the session tree. UI hosts can call `startBackgroundModelDiscovery()` after their first paint to start cache-aware online model discovery.

## Startup performance

`createAgentSession()` runs two background optimizations to overlap I/O with the rest of session setup:

- **Model-host warm-up.** `prewarmModelConnection(model)` (`packages/ai/src/providers/connection-prewarm.ts`) sends a credential-less `HEAD` to the model's API origin through the same transport (proxy, extra CA, TLS options) real requests use, so the next request reuses the pooled socket instead of paying DNS + TCP + TLS. The SDK fires it as soon as the model is resolved, overlapping session setup; the interactive UI repeats it while idle (first frame, model change, typing), throttled to once per 30 s per origin. First-party Anthropic resolves its official endpoint up front; every other model warms only the origin its last inference request actually reached, so dispatch-time rewrites (Copilot plan hosts, `MOONSHOT_BASE_URL`, regional hosts) are never guessed and nothing is warmed before the first request. The origin must be the provider's own endpoint (its bundled base URL host or a KDL `endpoint-hosts` entry): custom `models.yml` providers, built-in provider ids routed to a gateway, and `ANTHROPIC_BASE_URL`/Foundry gateways are never probed. Failures are silently skipped. Applies to every mode (interactive, print, RPC, ACP).
- **Conditional LSP warmup.** Startup LSP servers (those returned by `discoverStartupLspServers(cwd)`) are only warmed when **all** of these hold:
   - LSP integration is enabled on the session options and `lsp.enabled` is `true`, **and**
   - `options.hasUI === true` (interactive TUI), **and**
   - the `lsp.lazy` setting is disabled (it defaults to `true`).

   With `lsp.lazy` enabled — the default — no language servers are launched at startup at all; each server cold-starts on first use, i.e. when the agent invokes the `lsp` tool or an edit/write touches a file whose extension matches the server's `fileTypes`. Print / script / RPC / ACP invocations (`hasUI=false`) skip the warmup regardless of the setting: they don't render the warmup status indicator and typically finish before the language servers would stabilize, so warming them just spends CPU parsing big `initialize` responses concurrently with the LLM stream consumer and jitters perceived latency. Tools that actually need an LSP server still spin one up on demand through `getOrCreateClient()` — only the _startup_ warmup is skipped. The returned `lspServers` field in `CreateAgentSessionResult` is still populated for UI sessions in lazy mode — recognized servers are discovered (no processes spawned) and reported with status `"available"` so the welcome screen and `/status` can list them; it is `undefined` when LSP integration or `lsp.enabled` is disabled, or `hasUI` is false. Turning `lsp.lazy` off mid-session (via `/settings` or any `settings.set()`/reload) runs the same warmup once for those servers, updating their status in place and emitting the usual `lsp:startup` event.

## Minimal controlled embed example

```ts
import {
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
	"compaction.enabled": true,
	"retry.enabled": true,
});

const { session } = await createAgentSession({
	authStorage,
	modelRegistry,
	settings,
	sessionManager: SessionManager.inMemory(),
	toolNames: ["read", "grep", "glob", "edit", "write"],
	restrictToolNames: true,
	enableMCP: false,
	enableLsp: true,
});

session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("Find all TODO comments in this repo and propose fixes.");
await session.dispose();
```
