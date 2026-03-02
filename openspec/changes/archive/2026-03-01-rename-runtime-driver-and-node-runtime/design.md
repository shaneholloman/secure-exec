## Context

The runtime refactor already split responsibilities to a thin runtime facade and driver-owned execution internals. However, the public names still used legacy `NodeProcess` and `SandboxDriver` terminology, which obscured the intended ownership model and conflicted with the architecture docs.

## Goals / Non-Goals

**Goals:**
- Rename the runtime facade type from `NodeProcess` to `NodeRuntime`.
- Rename the driver contract from `SandboxDriver` to `RuntimeDriver`.
- Keep runtime behavior unchanged while updating symbols, imports, and docs.
- Rename the dedicated driver type file to `runtime-driver.ts` and keep `types.ts` as the compatibility export surface.

**Non-Goals:**
- Rework runtime execution semantics, permissions policy, or module-access behavior.
- Restore browser runtime support.
- Change low-level isolate/bridge orchestration.

## Decisions

1. Rename symbols directly instead of introducing aliases.
- Rationale: avoid long-term dual API maintenance and ambiguity.
- Alternative: export deprecated aliases (`NodeProcess`, `SandboxDriver`). Rejected for now to keep API surface explicit.

2. Keep `types.ts` as the import gateway for shared contracts.
- Rationale: existing imports already point to `types.ts`; moving declarations to `runtime-driver.ts` with re-exports gives cleaner ownership with lower migration risk.
- Alternative: force every consumer to import from `runtime-driver.ts`. Rejected as unnecessary churn.

3. Update OpenSpec baseline specs to new names.
- Rationale: capability requirements must reflect the current external contract.
- Alternative: keep old names in specs with translation notes. Rejected to prevent drift.

## Risks / Trade-offs

- [Breaking symbol rename] -> Mitigation: update all local call sites (src/tests/examples/docs/specs) in one pass and verify with typecheck/tests.
- [Residual old references in docs/specs] -> Mitigation: run repository-wide symbol scans after rename and patch remaining hits.
- [Behavior regression masked as rename] -> Mitigation: run targeted Node runtime and module-access suites after rename.

## Migration Plan

1. Rename `driver-types.ts` to `runtime-driver.ts` and rename `SandboxDriver` to `RuntimeDriver`.
2. Rename `NodeProcess`/`NodeProcessOptions` to `NodeRuntime`/`NodeRuntimeOptions` in source and exports.
3. Update tests/examples/docs/spec references.
4. Validate with `tsc` and targeted vitest suites.

## Open Questions

- Do we want temporary compatibility aliases for one release window, or keep this as a hard break only?
