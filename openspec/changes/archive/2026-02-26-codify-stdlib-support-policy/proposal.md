## Why

The stdlib compatibility docs (`docs-internal/node/stdlib-compat.md`) have drifted from the actual runtime. Stale entries (e.g., `@hono/node-server` "full bridge") remain after the third-party bridge was removed. Some APIs listed as "missing" are now implemented (`fs.access`, `fs.realpath`). And several large categories — missing `fs` APIs, `child_process.fork()`, crypto policy, and 16 unimplemented core modules — have no explicit support-level decision recorded, leaving ambiguity for both contributors and consumers.

## What Changes

- **Reconcile stdlib-compat.md with runtime reality**: Remove the stale `@hono/node-server` bridge entry, correct the `fs` missing-API list (`access` and `realpath` are now implemented), and ensure `http`/`https`/`http2` sections reflect built-in-only bridge policy.
- **Codify missing `fs` API support levels**: For each genuinely missing API (`watch`, `watchFile`, `chmod`, `chown`, `link`, `symlink`, `readlink`, `truncate`, `utimes`), record an explicit decision: implement, defer, or permanently unsupported with a deterministic runtime error.
- **Codify `child_process.fork()` support level**: Mark `fork()` as explicitly unsupported with a deterministic error and document why (IPC across isolate boundary is not feasible).
- **Tighten crypto policy**: Document that `getRandomValues()` uses `Math.random()` (not cryptographically secure), mark `subtle.*` as explicitly unsupported, and decide whether `crypto-browserify` hashing should be exposed or blocked.
- **Classify all unimplemented core modules**: For each of the 16 listed modules (`net`, `tls`, `dgram`, `http2`, `cluster`, `worker_threads`, `wasi`, `perf_hooks`, `async_hooks`, `diagnostics_channel`, `inspector`, `repl`, `readline`, `trace_events`, `domain`), record an explicit tier: deferred (may implement later) vs permanently unsupported.
- **Remove stale third-party stub for `@hono/node-server`** from the "Third-party stubs" section since it no longer exists in code.

## Capabilities

### New Capabilities

- `stdlib-support-tiers`: Formal support-tier classification for all Node.js core modules in the sandbox (bridged, polyfilled, stubbed, deferred, unsupported) with deterministic runtime behavior for each tier.

### Modified Capabilities

- `compatibility-governance`: Add a requirement that each module in the compatibility matrix must carry an explicit support-tier classification, not just presence/absence.

## Impact

- `docs-internal/node/stdlib-compat.md` — primary target, rewritten to reflect actual state and include support-tier decisions.
- `packages/sandboxed-node/src/bridge/child-process.ts` — add deterministic `fork()` error if not already present.
- `packages/sandboxed-node/src/shared/require-setup.ts` — verify third-party stubs section is accurate (chalk, supports-color remain; @hono/node-server already gone).
- `docs-internal/todo/sandboxed-node.md` — check off the five resolved TODO items.
- No API surface changes — this is a docs/policy/error-contract change.
