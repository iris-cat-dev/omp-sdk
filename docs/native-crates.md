# Native Crates

Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@oh-my-pi/pi-natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` lists every crate under `crates/` explicitly in `workspace.members` — add new crates there. Its `[patch.crates-io]` selects vendored `cfg_aliases`, `grep-searcher`, `jaq-core`, `jaq-json`, `jaq-std`, `napi`, and `tree-sitter-go`.

## First-party crates

| Crate         | Path                                          | Role and consumers                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-natives`  | [`crates/pi-natives`](../crates/pi-natives)   | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `pi-ast`, `pi-diff`, `pi-edit`, `pi-iso`, `pi-predict`, `pi-shell`, `pi-vcs`, `pi-vfs`, `pi-voice`, and `pi-walker`.                                                                                                                                                                                                                                |
| `pi-builtins` | [`crates/pi-builtins`](../crates/pi-builtins) | In-process utility and process commands (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, …). `src/extras.rs` dispatches commands against explicit per-invocation I/O, cwd, environment, filesystem and cancellation. Language builtins belong to `pi-shell`; utility ports and their third-party notices remain here.                                                                            |
| `pi-diff`     | [`crates/pi-diff`](../crates/pi-diff)         | N-API-free jsdiff-compatible Myers, line, word, and structured-patch primitives, consumed by native diff bindings and the edit engine.                                                                                                                                                                                                                                                                                     |
| `pi-edit`     | [`crates/pi-edit`](../crates/pi-edit)         | Edit-mode parsing, matching, staging, streaming previews, snapshots, and host-writer application (missing-path suffix recovery lives in the async layer of `pi-natives/src/edit.rs`); wrapped by native `EditSession` / `EditStore`.                                                                                                                                                                                       |
| `pi-predict`  | [`crates/pi-predict`](../crates/pi-predict)   | N-API-free ngram, SmolLM, and macOS spelling-backed word-completion engines, wrapped by `TextPredictor`.                                                                                                                                                                                                                                                                                                                   |
| `pi-vfs`      | [`crates/pi-vfs`](../crates/pi-vfs)           | Injectable async filesystem (with a blocking facade for sync callers), native host fast paths, and URL-preserving lexical helpers shared by shell, builtins, and traversal.                                                                                                                                                                                                                                                |
| `pi-shell`    | [`crates/pi-shell`](../crates/pi-shell)       | Embedded Bash parser/VM, persistent step-driven sessions, native execution traces, process plumbing, minimization, and utility integration. `session.rs` drives the engine; `host.rs` adapts filesystem, streams and external processes.                                                                                                                                                                                   |
| `pi-voice`    | [`crates/pi-voice`](../crates/pi-voice)       | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings.                                                                                                                                                                                                                                                                                     |
| `pi-ast`      | [`crates/pi-ast`](../crates/pi-ast)           | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization. Common grammars are linked in; the rest load as WebAssembly modules the agent downloads on first use (`src/language/grammar.rs`). They are built and published by [stencil-hq/wasm-grammars](https://github.com/stencil-hq/wasm-grammars); `bun run gen:grammars` pins the latest release in `src/language/wasm_grammars.rs`. |
| `pi-iso`      | [`crates/pi-iso`](../crates/pi-iso)           | Isolation backend implementations and diffing for APFS, btrfs, ZFS, Linux reflinks, overlayfs, Windows block clones, and ProjFS; fallback uses a Git worktree for Git repositories and recursive copy otherwise.                                                                                                                                                                                                           |
| `pi-walker`   | [`crates/pi-walker`](../crates/pi-walker)     | Parallel ignore-aware walker, per-directory listing cache, glob selection, and content search, all async over the caller's Tokio runtime (tasks are `tokio::spawn`ed per call, bounded by a permit semaphore; dropping a future cancels its work), shared by native scans and shell `rg`/`grep`/`fd`/`find`. Native reads use per-platform syscall fast paths; providers go through `pi-vfs` and are never cached.         |
| `pi-vcs`      | [`crates/pi-vcs`](../crates/pi-vcs)           | In-process version control: git on gitoxide (the git binary also handles credential-bound network transfers, reftable repos, and whole-worktree status/untracked walks) and Jujutsu on jj-lib; unified discovery and operations used by the `vcs*` native bindings.                                                                                                                                                        |

## Vendored workspace crates

| Group                       | Paths                                                                                                                                                                                                                                          | Purpose                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build/runtime compatibility | [`crates/vendor/cfg_aliases`](../crates/vendor/cfg_aliases), [`crates/vendor/grep-searcher`](../crates/vendor/grep-searcher), [`crates/vendor/napi`](../crates/vendor/napi), [`crates/vendor/tree-sitter-go`](../crates/vendor/tree-sitter-go) | Workspace patches fix macro compatibility, add a chunk-fed search (`Searcher::search_push`), fix N-API environment teardown, and fix Go grammar support respectively. |
| Embedded jq                 | `crates/vendor/jaq-core`, `crates/vendor/jaq-json`, `crates/vendor/jaq-std`                                                                                                                                                                    | Preserve jq 1.8 semantics while polling shell cancellation through the evaluator.                                                                                     |

Language builtins live under `pi-shell/src/bash/`; optional utility registration and dispatch live in `pi-builtins/src/extras.rs`. `pi-shell` applies session environment switches before exposing them, and the native `shellBuiltins()` API reports the configured inventory. Workspace membership does not itself expose a JavaScript API.

## Boundary map

```text
@oh-my-pi/pi-natives JS entrypoints
  -> pi-natives (N-API conversion, platform bindings, task boundaries)
       -> pi-ast / pi-diff / pi-edit / pi-iso / pi-predict / pi-vcs / pi-voice
       -> pi-walker / pi-vfs
       -> pi-shell
            -> bash/ (parser, expansion, VM, language builtins, trace)
            -> pi-builtins (utility/process commands; extras.rs: per-invocation I/O and cwd)
            -> pi-vfs / pi-walker (filesystem provider and traversal)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@oh-my-pi/pi-natives`; see [`user-facing-packages.md`](./user-facing-packages.md).
