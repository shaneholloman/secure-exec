## Why

Sandboxed-node currently has no runtime CPU budget enforcement, so untrusted code can block execution indefinitely with tight loops or long-running module evaluation. We need a first-class CPU time limit contract to make untrusted execution predictable and fail-fast while keeping default behavior Node-compatible when no limit is configured.

## What Changes

- Add a configurable CPU execution limit (`cpuTimeLimitMs`) for Node runtime executions.
- Enforce one shared per-execution deadline across all isolate execution entry points (`script.run`, `context.eval`, ESM `evaluate`, dynamic import evaluation, and active-handle wait paths).
- Define deterministic timeout behavior: execution fails with a stable timeout contract and isolate state is recycled after timeout.
- Add runtime tests that cover CJS, ESM, dynamic import, and active-handle timeout enforcement.
- Update compatibility/friction docs to reflect the new timeout contract and any Node parity impact when the limit is enabled.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: Define configurable CPU time limit semantics and timeout behavior for sandbox execution paths.
- `compatibility-governance`: Require compatibility/friction documentation updates for the new timeout contract and parity notes.

## Impact

- Affected code: `packages/sandboxed-node/src/index.ts`, `packages/sandboxed-node/src/shared/api-types.ts`, and Node runtime tests.
- API surface: `NodeProcessOptions` and `ExecOptions` gain `cpuTimeLimitMs`.
- Operational impact: protects hosts from unbounded CPU consumption in configured deployments.
- Documentation impact: updates in compatibility and friction tracking docs.
