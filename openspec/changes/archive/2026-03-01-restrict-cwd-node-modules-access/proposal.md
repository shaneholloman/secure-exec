## Why

secure-exec currently requires callers to pre-populate sandbox `node_modules` in the virtual filesystem, which makes selective reuse of already-installed workspace dependencies cumbersome and error-prone. We need a secure, first-class way for a driver to expose only approved packages from host `cwd/node_modules` without widening the runtime trust boundary.

## What Changes

- Add driver-level module access configuration for Node runtime with a minimal API:
  - `moduleAccess.cwd` (defaults to host `process.cwd()`)
  - `moduleAccess.allowPackages` (explicit allowlist)
- Implement host-side allowed-module discovery using Node resolution, with strict containment checks that require every resolved path to remain under `<cwd>/node_modules`.
- Materialize the allowed package closure (allowlisted roots plus transitive runtime dependencies) into sandbox filesystem paths under `/app/node_modules` as read-only content.
- Deny native addon loading (`.node`) from module-access materialization.
- Keep existing runtime resolution behavior sandbox-first (no host-global fallback); unresolved dependencies continue to fail with standard module-not-found behavior.
- Add compatibility and friction documentation updates for the new module-access security boundary and Node-compatibility tradeoffs.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: add requirements for configurable allowed-module materialization from host `cwd/node_modules` into sandbox filesystem.
- `node-permissions`: add requirements that module-access projections are read-only and remain deny-by-default for non-projected paths.
- `compatibility-governance`: add requirements to document module-access boundary constraints and any Node compatibility friction introduced by strict containment rules.

## Impact

- Affected code:
  - `packages/secure-exec/src/node/driver.ts`
  - `packages/secure-exec/src/index.ts`
  - `packages/secure-exec/src/types.ts`
  - `packages/secure-exec/src/package-bundler.ts` (if resolver edge-handling updates are needed)
  - new helper(s) for module-access discovery/materialization under `packages/secure-exec/src/node/`
- Affected tests:
  - Node runtime/module-loading coverage in `packages/secure-exec/tests/index.test.ts`
  - permission and filesystem write-denial coverage in `packages/secure-exec/tests/permissions.test.ts`
  - compatibility fixtures under `packages/secure-exec/tests/projects/`
- Docs/governance:
  - `docs-internal/friction/secure-exec.md`
  - `docs/security-model.mdx` (module trust-boundary clarification)
