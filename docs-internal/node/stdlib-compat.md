# Node.js Standard Library Compatibility

Status of each Node.js core module in sandboxed-node.

## Support Tiers

## Permission model

- Runtime permissions are deny-by-default per domain (`fs`, `network`, `childProcess`, `env`).
- When a domain checker is not configured, operations fail with `EACCES`.
- `filterEnv` strips all environment variables unless `permissions.env` explicitly allows them.
- Embedders can opt in to permissive behavior with `allowAll`, or selectively via
  `allowAllFs`, `allowAllNetwork`, `allowAllChildProcess`, and `allowAllEnv`.

| Tier | Label | Runtime behavior |
| --- | --- | --- |
| 1 | Bridge | Custom implementation in `packages/sandboxed-node/src/bridge/` with host bridge hooks where needed. |
| 2 | Polyfill | Provided by `node-stdlib-browser` and related browser-compatible packages. |
| 3 | Stub | Minimal compatibility surface, usually for `instanceof` checks or lightweight usage. |
| 4 | Deferred | Not fully implemented; `require()` succeeds and returned APIs throw deterministic unsupported errors on call. |
| 5 | Unsupported | Not implemented by design; `require()` throws immediately. |

Deterministic unsupported API format: `"<module>.<api> is not supported in sandbox"`.

## fs (Tier 1: Bridge)

- Bridge implementation (`src/bridge/fs.ts`)
- Implemented: `readFile`, `writeFile`, `appendFile`, `open`, `read`, `write`, `close`, `readdir`, `mkdir`, `rmdir`, `rm`, `unlink`, `stat`, `lstat`, `rename`, `copyFile`, `exists`, `createReadStream`, `createWriteStream`, `writev`, `access`, `realpath`
- `fs.promises` exposes async variants of implemented APIs
- ESM support includes both default and named imports for common APIs (for example `import fs, { readFileSync } from "node:fs"`)
- Deferred APIs with deterministic errors:
  - `fs.watch is not supported in sandbox`
  - `fs.watchFile is not supported in sandbox`
  - `fs.chmod is not supported in sandbox`
  - `fs.chown is not supported in sandbox`
  - `fs.link is not supported in sandbox`
  - `fs.symlink is not supported in sandbox`
  - `fs.readlink is not supported in sandbox`
  - `fs.truncate is not supported in sandbox`
  - `fs.utimes is not supported in sandbox`

## process (Tier 1: Bridge)

- Bridge implementation (`src/bridge/process.ts`)
- Supports env access (permission-gated), cwd/chdir, exit semantics, timers, stdio, eventing, and basic usage/system metadata APIs

## os (Tier 1: Bridge)

- Bridge implementation (`src/bridge/os.ts`)
- Supports platform/arch/version, user/system info, and `os.constants`

## child_process (Tier 1: Bridge)

- Bridge implementation (`src/bridge/child-process.ts`)
- Implemented: `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`
- Unsupported API with deterministic error:
  - `child_process.fork is not supported in sandbox`
- Rationale: `fork()` requires Node IPC across isolate boundaries and is intentionally unsupported

## http (Tier 1: Bridge)

- Bridge implementation (`src/bridge/network.ts`)
- Implemented: `request`, `get`, `createServer`
- Includes bridged `ClientRequest`, `IncomingMessage`, `Server`, `ServerResponse`, `Agent`, and constants
- Server bindings are loopback-restricted by the Node driver

## https (Tier 1: Bridge)

- Bridge implementation (`src/bridge/network.ts`)
- Implemented: `request`, `get`, `createServer` with the same bridge contract as `http`

## http2 (Tier 3: Stub, Tier 5 full support)

- Stub implementation (`src/bridge/network.ts`) for compatibility checks only
- Exposes `Http2ServerRequest` and `Http2ServerResponse` classes for `instanceof` compatibility
- Unsupported APIs with deterministic errors:
  - `http2.createServer is not supported in sandbox`
  - `http2.createSecureServer is not supported in sandbox`
- Rationale: full HTTP/2 session/stream behavior is not implemented

## dns (Tier 1: Bridge)

- Bridge implementation (`src/bridge/network.ts`)
- Implemented: `lookup`, `resolve`, `resolve4`, `resolve6`, and `dns.promises` variants

## module (Tier 1: Bridge)

- Bridge implementation (`src/bridge/module.ts`)
- Implements `createRequire`, `Module` basics, and runtime builtin resolution
- `require.resolve("fs")` and `createRequire(...).resolve("path")` return builtin identifiers instead of filesystem paths

## timers (Tier 1: Bridge)

- Bridge implementation (`src/bridge/process.ts`)
- Implements `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`

## path (Tier 2: Polyfill)

- Polyfill via `path-browserify`
- ESM support includes both default and named imports for common APIs (for example `import path, { sep } from "node:path"`)

## buffer (Tier 2: Polyfill)

- Polyfill via `buffer`

## url (Tier 2: Polyfill)

- Polyfill via `whatwg-url` and node-stdlib-browser compatibility shims

## events (Tier 2: Polyfill)

- Polyfill via `events`

## stream (Tier 2: Polyfill)

- Polyfill via `readable-stream`

## util (Tier 2: Polyfill)

- Polyfill via node-stdlib-browser

## assert (Tier 2: Polyfill)

- Polyfill via node-stdlib-browser

## querystring (Tier 2: Polyfill)

- Polyfill via node-stdlib-browser

## string_decoder (Tier 2: Polyfill)

- Polyfill via node-stdlib-browser

## zlib (Tier 2: Polyfill)

- Polyfill via node-stdlib-browser

## vm (Tier 2: Polyfill)

- Polyfill via node-stdlib-browser

## crypto (Tier 3: Stub)

- Bridge/polyfill blend with intentionally limited surface
- `getRandomValues()` is backed by `Math.random()` and is **NOT cryptographically secure**
- `randomUUID()` is available
- `subtle.*` is unsupported and throws deterministic errors:
  - `crypto.subtle.digest is not supported in sandbox`
  - `crypto.subtle.encrypt is not supported in sandbox`
  - `crypto.subtle.decrypt is not supported in sandbox`
- No hashing, signing, cipher, or HMAC APIs are supported

## tty (Tier 2: Polyfill)

- Polyfill via `node-stdlib-browser` (`tty-browserify`)
- `isatty()` returns `false`
- `ReadStream`/`WriteStream` are compatibility constructors

## v8 (Tier 3: Stub)

- Pre-registered module-cache stub in `src/index.ts`
- Provides mock heap stats and JSON-based `serialize`/`deserialize`

## constants (Tier 2: Polyfill)

- Polyfill via `node-stdlib-browser` (`constants-browserify`)
- `os.constants` remains available from the `os` bridge module

## fetch API (Tier 1: Bridge)

- Global fetch surface (`fetch`, `Headers`, `Request`, `Response`) bridged via `src/bridge/network.ts`

## Deferred Core Modules (Tier 4)

`require()` returns a stub object; calling its APIs throws deterministic unsupported errors.

- `net`: deferred for future socket client/server compatibility work
- `tls`: deferred because practical client use-cases exist once `net` is expanded
- `readline`: deferred for CLI compatibility after richer stdin/tty behavior
- `perf_hooks`: deferred for diagnostic/timing parity work
- `async_hooks`: deferred for advanced framework compatibility
- `worker_threads`: deferred for future isolate/runtime architecture work

## Unsupported Core Modules (Tier 5)

`require()` throws immediately with `"<module> is not supported in sandbox"`.

- `dgram`: UDP sockets are out of scope for sandbox runtime design
- `cluster`: multi-process clustering is incompatible with isolate model
- `wasi`: WASI host bindings are intentionally out of scope
- `diagnostics_channel`: diagnostics bus is not part of sandbox contract
- `inspector`: debugger protocol is intentionally unavailable inside sandbox
- `repl`: interactive shell is not part of runtime embedding model
- `trace_events`: tracing pipeline is unsupported in sandbox runtime
- `domain`: deprecated Node API, intentionally unsupported

Full HTTP/2 behavior is also Tier 5 unsupported; only compatibility stubs are provided under the `http2` module section above.

## Third-Party Stubs

No third-party module stubs are currently registered in runtime require setup.
