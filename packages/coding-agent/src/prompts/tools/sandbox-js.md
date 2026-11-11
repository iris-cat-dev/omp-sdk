Execute a JavaScript function body with `return` and `await` in a fresh, isolated QuickJS guest.

Available APIs:
- Standard JavaScript and `console.log(...values)`.
- `sandbox.read(path)` returns UTF-8 text; `sandbox.write(path, content)` writes UTF-8 text. Parent directories must already exist. Files are limited to 1 MiB.
- `sandbox.list(path = ".")` returns directory entries with `name`, `isDirectory`, `size`, and `modifiedAt`.
- When sandbox networking is enabled, `fetch(url, { method?, headers?, body? })` uses the same controlled public HTTP/HTTPS boundary as `sandbox_fetch`. Its response has `ok`, `status`, `url`, a frozen lowercase header record, and async `text()` / `json()` methods. HTTP error statuses remain readable responses; `json()` rejects invalid JSON. At most 16 requests may be pending.

No shell, Node globals, host imports, host paths, localhost/private/metadata access, or ambient host proxies, Cookies, or credentials. Without networking, `fetch` is absent.

Limits: source 64 KiB, guest memory 32 MiB (a hard WASM linear-memory ceiling, including VM overhead), guest stack guard 128 KiB to leave headroom for the host call stack, cumulative guest CPU 5 seconds, total wall time 30 seconds, JSON result 256 KiB, logs 64 KiB, public error text 8 KiB. Network waiting consumes wall time, not guest CPU. Completion or cancellation closes outstanding requests.

The tool returns JSON `{ "result": ..., "logs": [...] }`; `undefined` becomes `null`. Results must be JSON serializable. Failures are tool errors; file writes already performed are not rolled back. Guest memory and globals never persist between calls.
