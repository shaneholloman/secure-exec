## Why

The sandbox permission system is currently allow-by-default: when a `Permissions` callback is not provided for a domain (fs, network, childProcess, env), all operations in that domain pass through unrestricted. This means embedders who forget to set up permissions—or who provide a driver with capabilities but no permission checks—silently grant sandboxed code full access to host resources. A sandbox should be safe by default; capabilities should require explicit opt-in.

## What Changes

- **BREAKING**: When no `PermissionCheck` callback is provided for a domain, operations in that domain are **denied** instead of allowed. Embedders must explicitly pass a permission callback (even a simple `() => ({ allow: true })`) to grant access.
- Add a built-in `allowAll` permission helper so embedders can easily opt into permissive mode when they want the old behavior.
- Update `checkPermission` in `permissions.ts` to deny when the checker is `undefined`.
- Update `filterEnv` to deny all env access when no `env` permission callback is provided.
- Update all tests, examples, and driver constructors (`createNodeDriver`) to pass explicit permissions where access is needed.

## Capabilities

### New Capabilities
- `deny-by-default-permissions`: Permission system denies operations when no checker is provided, with built-in `allowAll`/`denyAll` helpers for common patterns.

### Modified Capabilities

_(none — no existing specs have requirements that change at the spec level)_

## Impact

- `packages/sandboxed-node/src/shared/permissions.ts` — core change to `checkPermission`, `filterEnv`, and new helpers.
- `packages/sandboxed-node/src/types.ts` — possible additions for helper types.
- `packages/sandboxed-node/src/node/driver.ts` — `createNodeDriver` must propagate explicit permissions.
- `packages/sandboxed-node/src/index.ts` — `NodeProcess` constructor fallback behavior.
- `examples/hono/` — must pass permissions to retain working network/fs access.
- All existing tests that create sandboxes without permissions will need updates.
- Downstream consumers upgrading will see `EACCES` errors until they add explicit permission callbacks — this is the intended breaking change.
