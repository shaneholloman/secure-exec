## Why

The runtime currently exposes high-resolution wall-clock behavior (`Date.now`, `performance.now`, `process.hrtime`) and has no execution budget, which makes timing side-channel probing and denial-of-service loops easier than they should be for untrusted code execution. We need a security-first default that reduces timing signal quality even when it intentionally diverges from Node timing semantics.

## What Changes

- Add a runtime hardening profile where timing mitigation defaults to `freeze`, with explicit opt-out (`off`) for compatibility-sensitive workloads.
- Add an execution budget (`executionTimeoutMs`) that terminates long-running user code paths instead of allowing unbounded CPU loops.
- Route bridge-level timer APIs and process timing helpers through the same hardened clock source when hardening is enabled.
- Ensure `SharedArrayBuffer` is unavailable in the hardened profile to remove high-precision shared-memory timing primitives.
- Add regression tests that verify both modes:
  - default mode uses frozen/deterministic timing behavior;
  - compatibility mode (`off`) restores Node-like timing behavior.
- Update internal compatibility/friction documentation to record the intentional default Node deviation and the compatibility opt-out.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: add execution-time hardening controls (clock policy + timeout budget) and define security-first default timing behavior.
- `compatibility-governance`: require explicit compatibility/friction documentation updates when security controls intentionally diverge from Node timing semantics, including default-on deviations.

## Impact

- Affected code: `packages/sandboxed-node/src/index.ts`, `packages/sandboxed-node/src/shared/api-types.ts`, and bridge timing paths under `packages/sandboxed-node/src/bridge/`.
- Affected tests: `packages/sandboxed-node/tests/index.test.ts` and/or targeted compatibility fixtures for timing behavior.
- Affected docs: `docs-internal/research/comparison/cloudflare-workers-isolates.md` and `docs-internal/friction/sandboxed-node.md`.
