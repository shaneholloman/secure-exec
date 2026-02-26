## 1. Core Permission Logic

- [x] 1.1 Change `checkPermission` in `packages/sandboxed-node/src/shared/permissions.ts` to throw `EACCES` when `check` is `undefined` (flip `if (!check) return` to `if (!check) throw onDenied(request)`)
- [x] 1.2 Change `filterEnv` in `packages/sandboxed-node/src/shared/permissions.ts` to return `{}` when `permissions?.env` is `undefined` (instead of `{ ...env }`)
- [x] 1.3 Change `envAccessAllowed` in `packages/sandboxed-node/src/shared/permissions.ts` to throw `EACCES` when `permissions?.env` is `undefined`

## 2. Permission Helpers

- [x] 2.1 Export `allowAll` constant (`Permissions` with all four domain checkers returning `{ allow: true }`) from `packages/sandboxed-node/src/shared/permissions.ts`
- [x] 2.2 Export per-domain helpers (`allowAllFs`, `allowAllNetwork`, `allowAllChildProcess`, `allowAllEnv`) from `packages/sandboxed-node/src/shared/permissions.ts`
- [x] 2.3 Re-export helpers from `packages/sandboxed-node/src/index.ts`

## 3. Update Existing Code

- [x] 3.1 Update `createNodeDriver` in `packages/sandboxed-node/src/node/driver.ts` to pass `allowAll` or explicit permissions when adapters are provided without permissions
- [x] 3.2 Update `NodeProcess` constructor in `packages/sandboxed-node/src/index.ts` to propagate permissions consistently (no double-wrap regression)
- [x] 3.3 Update example code in `examples/hono/` to pass explicit permissions

## 4. Tests

- [x] 4.1 Add unit tests for `checkPermission` deny-by-default behavior (each domain: fs, network, childProcess, env)
- [x] 4.2 Add unit tests for `filterEnv` deny-by-default (returns empty when no checker)
- [x] 4.3 Add unit tests for `allowAll` and per-domain helpers
- [x] 4.4 Update any existing tests that create sandboxes without permissions to pass explicit permissions
- [x] 4.5 Run `pnpm run check-types:test` in sandboxed-node to verify type conformance

## 5. Documentation

- [x] 5.1 Update `docs-internal/node/stdlib-compat.md` to note deny-by-default permission model
- [x] 5.2 Mark the permission todo item as done in `docs-internal/todo/sandboxed-node.md`
