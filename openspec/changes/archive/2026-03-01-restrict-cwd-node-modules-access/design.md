## Context

secure-exec module loading currently depends on whichever `VirtualFileSystem` is attached to the runtime. This keeps the `bridge` boundary tight, but it forces hosts to manually copy `node_modules` into sandbox paths before execution. The requested change adds a `driver` capability that reuses host-installed dependencies while preserving isolate/runtime security posture: module access must stay explicit, bounded, and read-only.

Constraints:
- `runtime` module resolution must remain sandbox-first and Node-compatible for CJS/ESM behavior.
- Any host-side helper used for dependency discovery must not become a runtime escape path.
- Dependency selection must be explicit (`allowPackages`) and scoped to `<cwd>/node_modules`.
- Existing deny-by-default permission semantics must remain intact for non-module filesystem access.

## Goals / Non-Goals

**Goals:**
- Provide a minimal API for allowed module access from host installs: `moduleAccess.cwd` and `moduleAccess.allowPackages`.
- Enforce strict realpath containment so all resolved module artifacts remain under `<cwd>/node_modules`.
- Materialize allowlisted package closures into sandbox filesystem under `/app/node_modules` as read-only.
- Preserve existing runtime behavior where unresolved modules fail with standard module-not-found behavior.

**Non-Goals:**
- Supporting Yarn Plug'n'Play or non-`node_modules` install models.
- Adding host-global module fallback behavior.
- Allowing native addons (`.node`) in this change.
- Introducing broad policy knobs (lockfile/integrity modes) in v1.

## Decisions

### Decision: Use host resolution only for discovery, not runtime execution
- The host will use `createRequire(...).resolve()` to discover package entry points and dependency closure from allowlisted roots.
- Every resolved path is canonicalized (`realpath`) and validated to stay within `<cwd>/node_modules`.
- Runtime execution still uses existing sandbox module resolution over `VirtualFileSystem`.

Rationale:
- Reuses Node's package-manager-aware resolution behavior for discovery.
- Avoids introducing host resolution into the isolate execution path.
- Keeps `runtime` behavior deterministic once snapshot materialization is complete.

Alternatives considered:
- Fully custom dependency resolver: rejected for higher semantic drift and maintenance risk.
- Live host filesystem passthrough at runtime: rejected for larger trust boundary and mutable host-state coupling.

### Decision: Materialize a read-only module snapshot into sandbox paths
- Build a projected filesystem view rooted at `/app/node_modules` containing only allowlisted packages and transitive runtime deps.
- Deny write/mkdir/remove/rename operations under projected module paths regardless of caller-level fs allow rules.

Rationale:
- Eliminates live host filesystem reads from untrusted execution.
- Preserves existing sandbox resolver semantics (`/app/node_modules` walking).
- Prevents dependency tampering from within sandbox code.

Alternatives considered:
- Mount host `node_modules` directly via adapter: rejected due to mutation and path-escape risks.
- Require users to manually pre-copy dependencies: rejected due to operational friction and inconsistent policy enforcement.

### Decision: Keep API minimal for v1
- Add only:
  - `moduleAccess.cwd?: string` (default `process.cwd()`)
  - `moduleAccess.allowPackages: string[]`
- Implicitly include transitive dependencies.

Rationale:
- Minimizes configuration complexity.
- Matches user intent: explicit root packages with Node-compatible dependency closure.

Alternatives considered:
- Expose `includeTransitiveDeps`, lockfile, and integrity knobs now: deferred to future hardening mode.

## Risks / Trade-offs

- [Risk] Dependency-graph discovery misses edge cases (peer/optional/platform variants) -> Mitigation: resolve each dependency from package-local `createRequire` context and add matrix fixtures covering optional/peer behaviors.
- [Risk] Strict `<cwd>/node_modules` containment may reject atypical symlinked setups -> Mitigation: fail with deterministic out-of-scope error and document compatibility friction.
- [Risk] Snapshot materialization cost on cold start -> Mitigation: cache projected closures by `(cwd, allowPackages)` fingerprint in future iteration if needed.
- [Risk] Read-only projection may differ from some host workflows expecting runtime writes into package dirs -> Mitigation: document this as intentional security posture and keep writes available outside projected module roots when permitted.

## Migration Plan

1. Add `moduleAccess` types and driver plumbing in `packages/secure-exec/src/types.ts` and `packages/secure-exec/src/node/driver.ts`.
2. Implement host-side closure discovery with strict `<cwd>/node_modules` containment checks and `.node` rejection.
3. Materialize the closure into sandbox `/app/node_modules` and enforce read-only module-path policy.
4. Add runtime and permissions tests plus compatibility fixture coverage for allowlisted success and non-allowlisted failure.
5. Update `docs/security-model.mdx` and `docs-internal/friction/secure-exec.md` with boundary behavior and known trade-offs.

Rollback:
- If regressions appear, disable `moduleAccess` path and continue requiring explicit caller-provided sandbox filesystem population.

## Open Questions

- Should unresolved peer dependencies in allowlisted packages fail hard during materialization or defer to runtime module-not-found behavior?
- Do we need a deterministic cache for projected closures in v1, or can we defer until perf data indicates need?
