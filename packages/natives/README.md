# @oh-my-pi/pi-natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Native glob-based file/directory discovery with gitignore support
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)
- **Audio**: Cross-platform low-latency microphone capture and gapless speaker playback
- **WebRTC**: Native Opus media, SDP offer/answer negotiation, and data-channel events for live sessions
- **File locking**: Process-owned cross-process locks with in-memory kernel names on Linux/Windows and `flock(2)` sidecars on other Unix platforms
- **Local IPC**: `IpcServer`/`IpcConnection` over Unix sockets and Windows named pipes — owner-only access, single-instance binding with stale-endpoint takeover, newline or raw framing; `ipcEndpoint(dir, name)` names endpoints per platform
- **PDF**: In-memory PDF-to-Markdown extraction with OCR-page classification via `pdf-inspector`
- **Binary patches**: `applyBinaryPatch(oldPath, patchPath, outPath)` applies an HDiffPatch single-stream patch (HDIFFSF20, zstd or uncompressed), streaming from files; callers verify digests

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { encodeSixelAsync, grep, pdfToMarkdown } from "@oh-my-pi/pi-natives";

// Grep for a pattern
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// Find files
const files = await find({
	pattern: "*.rs",
	path: "/path/to/project",
	fileType: "file",
});

// SIXEL encode for a terminal cell box (px), off the JS thread
// (`encodeSixel` is the synchronous form)
const backgroundRgb = 0x202040; // Actual terminal background, packed 0xRRGGBB
const sequence = await encodeSixelAsync(pngBytes, widthPx, heightPx, backgroundRgb);

// Extract PDF text and identify pages that still need OCR
const pdf = await pdfToMarkdown(pdfBytes);
console.log(pdf.markdown, pdf.pagesNeedingOcr);
```

Both SIXEL encoder forms require the terminal background as a fourth argument,
packed as a 24-bit `0xRRGGBB` number. When resizing images with alpha, RGB is
premultiplied before Lanczos filtering so transparent pixels cannot darken or
discolor visible edges. After resizing, the terminal background is composited
without applying alpha twice. Fully transparent pixels remain transparent;
unscaled images retain their existing blending path. Re-encode when the terminal
background RGB changes.

### PTY dimensions

`normalizePtyDimensions(cols, rows)` returns `{ cols, rows }` with fractional
values truncated toward zero and dimensions clamped to 20–400 columns and
5–200 rows. It shares the native bounds used by `PtySession.start`,
`startArgv`, and `resize`. Use the returned dimensions when sizing a screen
emulator so its viewport matches the native PTY.

### Lazy Windows path helpers

Import `expandWindowsLongPath` and `getWindowsShortPath` from
`@oh-my-pi/pi-natives/path` when importing a module must not load the native addon.
The addon loads only when a helper is called on Windows; other platforms preserve
the input path without loading it. These helpers change long/8.3 spellings without
resolving symlinks or junctions.

## Building

```bash
# Build native addon from workspace root (requires Rust)
bun run build

# Type check
bun run check
```

### Full and Desktop native builds

The optional `pi-natives` Cargo features below are **enabled by default**.
Normal native builds, the generic SDK, and the Bun CLI retain them all:

- `smollm` includes SmolLM/Candle word prediction and enables `local-assistance`.
- `live-voice` includes native WebRTC/Opus live media and enables `audio`.
- `wasm-grammars` includes on-demand WebAssembly tree-sitter grammar support.
  Disabling it preserves built-in languages and their parsing, AST search/edit,
  and summaries; languages requiring a WASM grammar are unavailable.
- `pdf` includes native PDF-to-Markdown extraction.
- `vcs-jj` includes Jujutsu; Git and the pure-JJ Git safety guard remain without it.
- `snapcompact` includes image-based context compression and its embedded fonts.
- `audio` includes microphone capture and speaker playback.
- `local-assistance` includes ngram/macOS prediction, macOS spelling, and Apple
  Foundation Models.
- `syntax-highlighting` includes syntect grammars, ANSI code highlighting, and
  the stateful TUI highlighter.

The Desktop target disables all of these features, independently of the
JavaScript `core`/`full` profile. File editing, search, Git, Shell, ordinary
images, and built-in code parsing remain available. OMP Desktop retains its
independent Lezer code-block/editor highlighter; SDK TUI highlighting requires
the full native addon. Browser PDF screenshots and printing do not depend on
the native PDF extractor.

From the workspace root:

```bash
# Full host build; regenerate the full declarations and ESM exports
bun run --cwd packages/natives build:bindings

# Isolated Desktop host build; release profile, --no-default-features
bun run --cwd packages/natives build:desktop
```

The Desktop build uses `target/desktop` for Cargo output and installs its
canonical `.node` addon plus JSON metadata sidecar under `native/desktop/`.
It does not replace the full addon or regenerate the full public declarations.
Rebuild this artifact after native source, feature, or package-version changes;
use `build:bindings` when changing the full exported API. Desktop staging
validates the isolated addon's version, SHA-256, and raw capability report
against its sidecar before packaging it.

`nativeCapabilities()` reports the loaded binary's `smollm`, `liveVoice`,
`wasmGrammars`, `pdf`, `jujutsu`, `snapcompact`, `audio`, `localAssistance`, and `syntaxHighlighting`
facts; declarations do not imply that an optional feature is enabled. The SDK
exposes a validated, immutable report through `readNativeCapabilities()`.
Disabled-feature operations fail before downloads or native construction.
Saved settings cannot activate omitted engines. Existing Snapcompact archives
remain readable without generating new frames. A caller-owned WebRTC peer can
still supply an SDP offer and use signaling without native WebRTC or local audio.

These native features are separate from the SDK's JavaScript `core` profile.

## Architecture

`@oh-my-pi/pi-natives` publishes a small core package plus generated
platform-specific optional dependency packages:

```
crates/pi-natives/       # Rust source (workspace member)
  src/lib.rs             # N-API exports
  src/sixel.rs           # SIXEL terminal-image encoding
  Cargo.toml             # Rust dependencies
native/                  # Core loader files and local/CI native build outputs
  index.js               # Public native export surface
  loader-state.js        # Platform, ISA variant, and addon resolution
  embedded-addon.js      # Null embed stub; binary builds replace it in memory
  pi_natives.<platform>-<arch>-modern.node   # x64 modern ISA (local/CI artifact)
  pi_natives.<platform>-<arch>-baseline.node # x64 baseline ISA (local/CI artifact)
  pi_natives.<platform>-<arch>.node          # non-x64 build artifact
npm/<platform>-<arch>/   # Generated at publish time, not committed
  package.json           # @oh-my-pi/pi-natives-<platform>-<arch>
  *.node                 # Only that platform's addon binary or x64 ISA variants
```

The published core package contains only the JS loader, declarations, README,
and `package.json`. Release publishing generates one leaf package per supported
`os`/`cpu` pair and injects those leaves into the core manifest as pinned
`optionalDependencies`, so package managers install only the host platform's
native addon. x64 leaves include every built ISA variant, and the loader keeps
choosing between `baseline` and `modern` at runtime.
