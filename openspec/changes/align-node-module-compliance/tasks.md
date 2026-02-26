## 1. Resolver And Module-Format Semantics

- [x] 1.1 Add package-metadata-aware module format classification (extension + nearest `package.json` type) and remove regex-only classification dependence.
- [x] 1.2 Align package entrypoint selection for `require`/`import` so Node-compatible metadata precedence is applied consistently.
- [x] 1.3 Unify builtin handling in resolver helper paths so `require.resolve` and `createRequire(...).resolve` return builtin identifiers instead of filesystem lookup failures.

## 2. Dynamic Import Semantics And Interop

- [x] 2.1 Update dynamic import precompile/evaluation flow to stop masking ESM compile/evaluation failures behind fallback behavior.
- [x] 2.2 Restrict CommonJS fallback behavior to intended cases and preserve ESM-origin error fidelity for true ESM failures.
- [x] 2.3 Implement safe CJS namespace construction for dynamic import results so primitive and null `module.exports` values resolve via `default` without runtime throw paths.

## 3. Builtin ESM Import Surface

- [x] 3.1 Add ESM wrapper export behavior for bridged/polyfilled builtins to support both default and named imports for supported APIs.
- [x] 3.2 Verify builtin named-import behavior remains consistent with default export access for targeted modules (`fs`, `path`, and other exposed builtins in scope).

## 4. Conformance Coverage And Documentation

- [x] 4.1 Add regression tests for package metadata semantics (`type` handling and require/import entrypoint behavior) and builtin resolver helper behavior.
- [x] 4.2 Add regression tests for dynamic import error fidelity and CJS namespace shape edge cases (primitive/null exports).
- [x] 4.3 Update compatibility artifacts (`docs-internal/node/stdlib-compat.md`, `docs-internal/friction/sandboxed-node.md`) for any intentional or remaining Node deviations.
- [x] 4.4 Run targeted sandboxed-node checks (`pnpm vitest` scoped module tests, `pnpm tsc`/project type checks) and record outcomes in the change notes.
  - `2026-02-26`: `pnpm --filter sandboxed-node test -- tests/index.test.ts` passed (`27` tests).
  - `2026-02-26`: `pnpm --filter sandboxed-node check-types` still reports pre-existing bridge/browser type errors; no errors were reported in modified module-compliance files when filtered to touched paths.
