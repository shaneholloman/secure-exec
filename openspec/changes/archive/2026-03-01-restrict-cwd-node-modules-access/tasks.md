## 1. Module Access API And Types

- [x] 1.1 Add `moduleAccess` configuration types (`cwd`, `allowPackages`) to secure-exec runtime/driver type surfaces.
- [x] 1.2 Wire `moduleAccess` through `createNodeDriver` and `NodeProcess` construction paths without changing existing behavior when unset.
- [x] 1.3 Add deterministic validation errors for invalid `moduleAccess` input (missing/empty `allowPackages`, non-absolute `cwd` after normalization, or unsupported package names).

## 2. Host Discovery And Scoped Projection

- [x] 2.1 Implement host-side allowed-module closure discovery seeded from `allowPackages`, resolving each package from `moduleAccess.cwd` context.
- [x] 2.2 Enforce strict canonical-path containment so every discovered artifact remains under `<cwd>/node_modules`; fail closed on out-of-scope paths.
- [x] 2.3 Reject native addon artifacts (`.node`) during discovery/materialization with deterministic error output.
- [x] 2.4 Materialize the discovered closure into sandbox filesystem paths under `/app/node_modules`.

## 3. Runtime And Permission Enforcement

- [x] 3.1 Enforce read-only behavior for projected `/app/node_modules` paths (deny write/mkdir/rm/rename mutations).
- [x] 3.2 Ensure runtime/module resolver behavior remains sandbox-first with no host-global fallback when projected modules are missing.
- [x] 3.3 Add tests for allowlisted package success, non-allowlisted package failure, out-of-scope containment rejection, and native-addon rejection.

## 4. Compatibility Coverage And Documentation

- [x] 4.1 Add/update black-box compatibility fixture project(s) under `packages/secure-exec/tests/projects/` to validate host-node vs secure-exec parity for allowed-module loading behavior.
- [x] 4.2 Update `docs-internal/friction/secure-exec.md` with scoped-projection trade-offs and mark resolved friction entries with fix notes where applicable.
- [x] 4.3 Update `docs/security-model.mdx` to document module-loading trust boundaries, including enforced `<cwd>/node_modules` containment.
- [x] 4.4 Run required verification for this change (`pnpm -C packages/secure-exec check-types`, targeted vitest coverage, and `pnpm turbo build --filter secure-exec`) and record results in task notes.
  - `2026-02-28`: `pnpm -C packages/secure-exec check-types` passed.
  - `2026-02-28`: `pnpm -C packages/secure-exec exec vitest run tests/module-access.test.ts tests/module-access-compat.test.ts` passed (6 tests).
  - `2026-02-28`: `pnpm -C packages/secure-exec exec vitest run tests/index.test.ts` passed (43 tests).
  - `2026-02-28`: `pnpm -C packages/secure-exec exec vitest run tests/permissions.test.ts` passed (8 tests).
  - `2026-02-28`: `pnpm turbo build --filter secure-exec` passed.
