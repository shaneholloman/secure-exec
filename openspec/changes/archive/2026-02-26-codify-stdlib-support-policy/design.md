## Context

The compatibility matrix (`stdlib-compat.md`) was originally written during early development and has not been systematically reconciled since. Several bridge changes have landed (removal of `@hono/node-server` bridge, addition of `http.createServer`, implementation of `fs.access`/`fs.realpath`) without corresponding doc updates. Meanwhile, 16 unimplemented core modules and several missing API gaps in `fs`, `child_process`, and `crypto` remain as open questions with no recorded decision.

The existing `compatibility-governance` spec requires keeping the matrix synchronized but does not require explicit support-tier classification for every module.

## Goals / Non-Goals

**Goals:**
- Every Node.js core module in the matrix has an explicit support tier with defined runtime behavior
- The matrix accurately reflects what the code actually does today
- Missing/unsupported APIs throw deterministic, descriptive errors rather than silently failing or returning undefined
- Support decisions are recorded as policy so future contributors don't re-debate them

**Non-Goals:**
- Implementing any new bridge functionality (this change is docs + error contracts + policy)
- Changing which modules are bridged, polyfilled, or stubbed
- Adding new polyfills or replacing existing ones
- Performance work

## Decisions

### Decision 1: Five support tiers

**Choice**: Classify every module into one of five tiers:

| Tier | Label | Runtime Behavior |
|------|-------|-----------------|
| 1 | **Bridge** | Custom implementation in `src/bridge/`, full or near-full API coverage |
| 2 | **Polyfill** | Provided by `node-stdlib-browser`, generally complete |
| 3 | **Stub** | Minimal implementation for compatibility, limited surface |
| 4 | **Deferred** | Not implemented, `require()` returns a stub that throws descriptive errors on method calls. May be implemented in a future change. |
| 5 | **Unsupported** | Not implemented, `require()` throws immediately. Will not be implemented (infeasible in sandbox or deprecated). |

**Rationale**: The current matrix uses ad-hoc labels. A fixed tier system makes the runtime contract predictable and testable. Tier 4 vs 5 distinguishes "we might do this" from "we won't" so contributors know where effort is welcome.

**Alternative considered**: Three tiers (supported/partial/unsupported). Rejected because it doesn't distinguish "polyfill we trust" from "stub we wrote" or "deferred" from "never."

### Decision 2: Deterministic errors for unsupported APIs

**Choice**: All Tier 4 and 5 modules, and known-missing APIs within Tier 1-3 modules (e.g., `fs.watch`, `child_process.fork`), throw errors with a consistent message format: `"<module>.<api> is not supported in sandbox"`.

**Rationale**: Silent failures or `undefined` returns are worse than explicit errors. A consistent format makes it possible to test the error contract and helps users understand what's available.

### Decision 3: fs missing API classification

**Choice**:
- **Implement nothing new** — this change only codifies decisions, it does not add bridge code.
- `access`, `realpath` → Already implemented, remove from "missing" list.
- `watch`, `watchFile` → Deferred (useful but requires host-side watcher plumbing).
- `chmod`, `chown`, `link`, `symlink`, `readlink` → Deferred (filesystem metadata ops that VirtualFileSystem could support).
- `truncate`, `utimes` → Deferred (straightforward to add if VirtualFileSystem expands).

### Decision 4: child_process.fork() is permanently unsupported

**Choice**: Mark `fork()` as Tier 5 (unsupported). It currently throws or is absent; this change ensures a deterministic error message.

**Rationale**: `fork()` requires Node-to-Node IPC which cannot cross the `isolated-vm` boundary. Implementing a constrained model would be a significant new capability requiring its own proposal.

### Decision 5: Crypto policy — document current state, flag insecurity

**Choice**: Keep current behavior (`Math.random()`-based `getRandomValues`, `subtle.*` throws) but add explicit documentation that `getRandomValues()` is **not cryptographically secure**. Classify `crypto` as Tier 3 (Stub) with a clear warning. Defer real crypto to a future change.

**Rationale**: Replacing `Math.random()` with a CSPRNG requires a bridge to host-side `crypto.getRandomValues()`, which is new capability and out of scope for a docs/policy change.

### Decision 6: Unimplemented module classification

**Choice**:
- **Deferred** (Tier 4): `net`, `tls`, `readline`, `perf_hooks`, `async_hooks`, `worker_threads`
- **Unsupported** (Tier 5): `dgram`, `http2` (full), `cluster`, `wasi`, `diagnostics_channel`, `inspector`, `repl`, `trace_events`, `domain`

**Rationale**: Tier 4 modules have realistic use cases in sandbox contexts (e.g., `net`/`tls` for database clients, `readline` for interactive scripts, `perf_hooks` for timing). Tier 5 modules are either deprecated (`domain`), require OS-level access the sandbox cannot provide (`dgram`, `cluster`), or serve debugging/introspection purposes irrelevant in a sandbox (`inspector`, `trace_events`, `diagnostics_channel`).

## Risks / Trade-offs

- **[Risk] Tier classifications may be contentious** → Mitigated by recording rationale per module in the compatibility doc. Reclassification is a future change, not a breaking one.
- **[Risk] Adding throw-on-access behavior to Tier 4 modules could break packages that soft-require them** → Mitigated by providing a stub object that only throws on method call, not on `require()`. Packages that only check for module existence still work.
- **[Risk] The `@hono/node-server` entry removal could confuse users who relied on the doc** → Low risk since the bridge was already removed from code and hono loads from node_modules correctly.
