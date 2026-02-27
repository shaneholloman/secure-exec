# compatibility-governance Specification

## Purpose
Define compatibility and tracking obligations for sandboxed-node changes.
## Requirements
### Requirement: Maintain Node Stdlib Compatibility Matrix
Changes affecting bridged or polyfilled Node APIs MUST keep `docs-internal/node/STDLIB_COMPATIBILITY.md` synchronized with the actual runtime surface, including supported, limited, and unsupported modules/APIs. Every module entry in the matrix MUST include an explicit support-tier classification (Bridge, Polyfill, Stub, Deferred, or Unsupported) as defined by the `node-stdlib` spec.

#### Scenario: Bridge API surface changes
- **WHEN** a change adds, removes, or materially alters bridged Node API behavior
- **THEN** the compatibility matrix MUST be updated in the same change to reflect the new contract

#### Scenario: Module entry missing tier classification
- **WHEN** a module appears in the compatibility matrix without a tier label
- **THEN** the entry MUST be updated to include the tier before the change is considered complete

### Requirement: Maintain Sandboxed Node Follow-Up Backlog
Work touching sandboxed-node behavior SHALL keep follow-up work tracked in OpenSpec change artifacts, including checking off completed tasks and adding newly discovered actionable items as new tasks or follow-up changes.

#### Scenario: Implementation resolves tracked backlog work
- **WHEN** a change completes an item already tracked in OpenSpec tasks
- **THEN** the item MUST be marked complete with scope-consistent notes

#### Scenario: Implementation uncovers new follow-up work
- **WHEN** development reveals a new actionable gap not currently tracked
- **THEN** a new OpenSpec task or follow-up change MUST be added immediately with enough detail to guide follow-up work

### Requirement: Maintain Friction Log for Development Issues
Unexpected issues, workarounds, and integration friction encountered during sandboxed-node development MUST be recorded in `docs-internal/friction/sandboxed-node.md`, and resolved items MUST be marked as resolved with fix notes.

#### Scenario: Workaround is introduced during implementation
- **WHEN** a change requires a workaround to unblock progress
- **THEN** the workaround and its impact MUST be logged in the friction file

#### Scenario: Previously logged issue is fixed
- **WHEN** a known friction item is resolved
- **THEN** its log entry MUST be updated to indicate resolution and summarize the fix

### Requirement: Run Bridge Type Conformance Tests After Bridge Changes
Any change to files under `packages/sandboxed-node/src/bridge` MUST run bridge type conformance checks via `pnpm run check-types:test` in `packages/sandboxed-node` before completion.

#### Scenario: Bridge source file is modified
- **WHEN** a commit modifies one or more files in `packages/sandboxed-node/src/bridge`
- **THEN** `pnpm run check-types:test` MUST be executed and failures MUST be addressed before the change is considered complete

### Requirement: Compatibility Project Matrix Uses Black-Box Node Fixtures
Compatibility validation for sandboxed-node SHALL execute fixture projects that behave as ordinary Node projects, with no sandbox-aware code paths.

#### Scenario: Fixture uses only Node-project interfaces
- **WHEN** a fixture is added under the compatibility project matrix
- **THEN** it MUST define a standard Node project structure (`package.json` + source entrypoint) and MUST NOT import sandbox runtime internals directly

#### Scenario: Runtime remains opaque to fixture identity
- **WHEN** sandboxed-node executes a compatibility fixture
- **THEN** runtime behavior MUST NOT branch on fixture name, fixture path, or test-specific markers

### Requirement: Compatibility Matrix Enforces Differential Parity Checks
The compatibility project matrix SHALL execute each fixture in host Node and in sandboxed-node, then compare normalized externally visible outcomes.

#### Scenario: Pass fixture requires parity
- **WHEN** a fixture is classified as pass-expected
- **THEN** the matrix MUST fail unless host Node and sandboxed-node produce matching normalized `code`, `stdout`, and `stderr`

#### Scenario: Fail fixture requires deterministic failure contract
- **WHEN** a fixture is classified as fail-expected for unsupported behavior
- **THEN** the matrix MUST fail unless sandboxed-node produces the documented deterministic error contract

### Requirement: Compatibility Matrix Uses Persistent Fixture Install Cache
Fixture dependency installation SHALL be cached across repeated test invocations using a persistent content hash.

#### Scenario: Unchanged fixture reuses cached install
- **WHEN** fixture inputs and cache key factors are unchanged
- **THEN** matrix preparation MUST reuse the existing prepared fixture directory and skip reinstall

#### Scenario: Changed fixture invalidates cache
- **WHEN** fixture files or cache key factors change
- **THEN** the matrix MUST prepare a new cache entry and reinstall dependencies before execution

### Requirement: Parity Mismatches Remain Failing Until Resolved
Compatibility project-matrix policy SHALL NOT include a "known mismatch" or equivalent pass-through state for parity failures.

#### Scenario: Detected parity mismatch
- **WHEN** a fixture marked pass-expected fails parity comparison
- **THEN** the test result MUST remain failing and MUST be addressed by runtime or bridge fixes rather than fixture reclassification

### Requirement: Timing Hardening Deviations Are Explicitly Documented
Any runtime timing-hardening behavior that intentionally diverges from default Node.js timing semantics MUST be documented in compatibility/friction artifacts in the same change.

#### Scenario: Hardened timing mode is introduced or changed
- **WHEN** a change adds or modifies timing hardening behavior (for example frozen clocks or disabled timing primitives)
- **THEN** the change MUST update `docs-internal/friction/sandboxed-node.md` with the deviation and fix/intent notes

#### Scenario: Security-first default intentionally diverges from Node timing
- **WHEN** timing hardening is enabled by default for sandbox execution
- **THEN** the change MUST explicitly document the default-on compatibility trade-off and the supported compatibility opt-out path

#### Scenario: Research and implementation guidance stays aligned
- **WHEN** timing-side-channel mitigations are proposed or revised
- **THEN** `docs-internal/research/comparison/cloudflare-workers-isolates.md` MUST be updated so its recommendations match the current OpenSpec change scope

### Requirement: CPU Limit Compatibility and Friction Documentation Stays Aligned
Any change that introduces or modifies the sandboxed-node CPU time limit contract MUST update compatibility/friction documentation in the same change.

#### Scenario: CPU timeout contract is introduced or changed
- **WHEN** runtime behavior for configured CPU limits changes (including option names, failure codes, or timeout stderr contract)
- **THEN** `docs-internal/friction/sandboxed-node.md` MUST be updated with the behavior change and resolution notes

#### Scenario: Research guidance reflects current CPU limit design
- **WHEN** CPU limit implementation guidance is revised
- **THEN** `docs-internal/research/comparison/cloudflare-workers-isolates.md` MUST be updated so recommendations match the active runtime contract and OpenSpec deltas
