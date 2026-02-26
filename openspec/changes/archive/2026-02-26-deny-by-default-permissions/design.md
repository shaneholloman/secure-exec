## Context

The sandbox permission system uses `checkPermission` in `packages/sandboxed-node/src/shared/permissions.ts` as the single enforcement point for all four capability domains: filesystem, network, child process, and environment variables. Currently, when a `PermissionCheck<T>` callback is `undefined` for a domain, `checkPermission` returns early and the operation proceeds unrestricted. This means providing a `VirtualFileSystem` or `NetworkAdapter` without a corresponding permission checker silently grants full access.

The `NodeProcess` constructor already uses stub adapters (`createFsStub`, `createNetworkStub`, `createCommandExecutorStub`) when no adapter is provided—these throw `ENOSYS`. But when an adapter *is* provided without a matching permission checker, there is no gate.

## Goals / Non-Goals

**Goals:**
- Make `checkPermission` deny operations when no checker is provided (flip `if (!check) return` to `if (!check) throw`).
- Make `filterEnv` return an empty object when no `env` permission checker is provided.
- Provide `allowAll` and `denyAll` permission helper constants so embedders can easily express intent.
- Keep the change minimal—same function signatures, same error types (`EACCES`).

**Non-Goals:**
- Redesigning the `Permissions` type or adding per-operation granularity.
- Adding a "strict mode" flag or dual-mode system—deny-by-default becomes the only mode.
- Changing how stubs work (they already deny via `ENOSYS`; that's fine).

## Decisions

### 1. Flip `checkPermission` default from allow to deny

**Choice**: When `check` is `undefined`, throw the same `EACCES` error that a `{ allow: false }` decision produces.

**Rationale**: This is the smallest change with the biggest safety improvement. All enforcement flows through this one function. No new types or flags needed.

**Alternative considered**: Adding a `defaultPolicy: "allow" | "deny"` option to `Permissions`. Rejected because it adds API surface for a setting that should always be "deny" in a sandbox.

### 2. Export `allowAll` helper constant

**Choice**: Export a `Permissions` object where every domain callback returns `{ allow: true }`. Embedders who want the old behavior pass `permissions: allowAll`.

```ts
export const allowAll: Permissions = {
  fs: () => ({ allow: true }),
  network: () => ({ allow: true }),
  childProcess: () => ({ allow: true }),
  env: () => ({ allow: true }),
};
```

**Rationale**: One import replaces four inline lambdas. Makes the opt-in explicit and discoverable.

### 3. Export per-domain helpers

**Choice**: Also export `allowAllFs`, `allowAllNetwork`, `allowAllChildProcess`, `allowAllEnv` for embedders who want to open specific domains without opening everything.

**Rationale**: Common pattern is "I want filesystem + network but not child_process". Per-domain helpers compose via spread: `{ ...allowAllFs, ...allowAllNetwork }`.

### 4. Update `filterEnv` to deny when no checker

**Choice**: When `permissions?.env` is `undefined`, return `{}` (empty) instead of `{ ...env }`.

**Rationale**: Consistent with `checkPermission` flip. Environment variables often contain secrets; denying by default prevents leaking `DATABASE_URL`, API keys, etc.

### 5. `createNodeDriver` passes permissions through

**Choice**: `createNodeDriver` continues to wrap adapters with permissions when provided. No change to its signature. Callers who want access must pass explicit permissions.

**Rationale**: The driver is a convenience constructor. The deny-by-default enforcement happens at the `checkPermission` level regardless of how drivers are created.

## Risks / Trade-offs

- **Breaking change for all existing embedders** → Mitigated by providing `allowAll` helper and clear migration guidance. The fix is a one-line change at each call site: `permissions: allowAll`.
- **Double-wrapping permissions** — `createNodeDriver` wraps, then `NodeProcess` constructor wraps again → Already exists today, not made worse. Could be cleaned up separately.
- **Tests will fail until updated** → Each test that creates a sandbox with adapters but no permissions needs explicit permissions. This is a feature—it surfaces tests that were implicitly relying on unrestricted access.
