## Why

The public naming around Node runtime orchestration and driver contracts was still mixed between generic and sandbox-specific terms. Aligning names to `NodeRuntime` and `RuntimeDriver` makes ownership clearer and matches the current architecture split (`NodeRuntime` facade over driver-owned execution internals).

## What Changes

- **BREAKING**: Rename `NodeProcess` to `NodeRuntime` and `NodeProcessOptions` to `NodeRuntimeOptions` in the `secure-exec` public API.
- **BREAKING**: Rename `SandboxDriver` to `RuntimeDriver` in public and internal driver-facing type contracts.
- Rename `packages/secure-exec/src/driver-types.ts` to `packages/secure-exec/src/runtime-driver.ts` and update re-exports from `types.ts`.
- Update tests/examples/docs/spec references to the new names.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: rename runtime facade and driver contract terms from `NodeProcess`/`SandboxDriver` to `NodeRuntime`/`RuntimeDriver`.
- `node-permissions`: update permission scenarios to reference `NodeRuntime` construction semantics.

## Impact

- `packages/secure-exec/src/index.ts`
- `packages/secure-exec/src/runtime-driver.ts`
- `packages/secure-exec/src/types.ts`
- `packages/secure-exec/src/node/driver.ts`
- `packages/secure-exec/tests/*` (renamed helper/type usages)
- `examples/hono/*`, `examples/just-bash/*`
- `openspec/specs/node-runtime/spec.md`
- `openspec/specs/node-permissions/spec.md`
- `docs-internal/arch/overview.md`
