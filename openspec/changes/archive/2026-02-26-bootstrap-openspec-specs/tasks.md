## 1. Publish Baseline Capability Specs

- [x] 1.1 Add `runtime-execution-model` as a new canonical capability under `openspec/specs/runtime-execution-model/spec.md`.
- [x] 1.2 Add `bridge-boundary-policy` as a new canonical capability under `openspec/specs/bridge-boundary-policy/spec.md`.
- [x] 1.3 Add `compatibility-governance` as a new canonical capability under `openspec/specs/compatibility-governance/spec.md`.

## 2. Validate Baseline Against Current Project State

- [x] 2.1 Verify runtime requirements against `README.md` and `packages/sandboxed-node/docs/ACTIVE_HANDLES.md`.
- [x] 2.2 Verify bridge boundary requirements against current bridge policy and module-resolution behavior in `packages/sandboxed-node`.
- [x] 2.3 Verify governance requirements against `docs-internal/node/stdlib-compat.md`, OpenSpec tracking artifacts, and `docs-internal/friction/sandboxed-node.md`.

## 3. Capture Immediate Follow-Up Work

- [x] 3.1 Create follow-up OpenSpec change(s) for unresolved runtime gaps already tracked in the sandboxed-node TODO list.
- [x] 3.2 Document how future runtime/bridge proposals should reference these baseline capabilities when adding deltas.
