## 1. Fix Stale Documentation Entries

- [x] 1.1 Remove the `@hono/node-server` entry from the "Third-party stubs" section of `stdlib-compat.md`
- [x] 1.2 Move `fs.access` and `fs.realpath` from the "Missing" list to the "Implemented" list in the `fs` section
- [x] 1.3 Verify the `http`/`https` section accurately describes the built-in bridge (request, get, createServer) with no third-party references
- [x] 1.4 Ensure the `http2` entry clarifies it is stub-only (instanceof checks) with createServer/createSecureServer throwing

## 2. Add Tier Classifications to Compatibility Matrix

- [x] 2.1 Add a "Support Tiers" legend section at the top of `stdlib-compat.md` defining the five tiers (Bridge, Polyfill, Stub, Deferred, Unsupported)
- [x] 2.2 Tag each existing module section with its tier label (fs=Bridge, path=Polyfill, tty=Stub, etc.)
- [x] 2.3 Classify unimplemented modules into Deferred vs Unsupported per design decisions — Deferred: `net`, `tls`, `readline`, `perf_hooks`, `async_hooks`, `worker_threads`; Unsupported: `dgram`, `http2` (full), `cluster`, `wasi`, `diagnostics_channel`, `inspector`, `repl`, `trace_events`, `domain`
- [x] 2.4 Add rationale notes for each Deferred/Unsupported classification

## 3. Codify Missing API Error Contracts

- [x] 3.1 Verify `fs.watch` already throws `"fs.watch is not supported in sandbox"` in bridge code; if not, add the error
- [x] 3.2 Add deterministic throw for remaining missing fs APIs (`watchFile`, `chmod`, `chown`, `link`, `symlink`, `readlink`, `truncate`, `utimes`) in the fs bridge if not already present
- [x] 3.3 Verify `child_process.fork()` throws a deterministic error; add `"child_process.fork is not supported in sandbox"` if missing
- [x] 3.4 Document the missing-API error contract in each module's compatibility matrix entry

## 4. Crypto Policy Documentation

- [x] 4.1 Add an explicit warning in the crypto section that `getRandomValues()` is backed by `Math.random()` and is NOT cryptographically secure
- [x] 4.2 Confirm `subtle.*` methods throw unsupported errors and document in matrix
- [x] 4.3 Classify crypto as Tier 3 (Stub) with the insecurity caveat

## 5. Backlog and Tracking

- [x] 5.1 Record completion in this change's OpenSpec tasks/spec deltas and link any remaining follow-up work as new OpenSpec changes
  - Completion notes recorded in this tasks file and `docs-internal/todo/sandboxed-node.md`.
  - No additional follow-up OpenSpec change was required for this scoped policy/documentation update.
