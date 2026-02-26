## ADDED Requirements

### Requirement: Maintain Node Stdlib Compatibility Matrix
Changes affecting bridged or polyfilled Node APIs MUST keep `docs-internal/node/stdlib-compat.md` synchronized with the actual runtime surface, including supported, limited, and unsupported modules/APIs.

#### Scenario: Bridge API surface changes
- **WHEN** a change adds, removes, or materially alters bridged Node API behavior
- **THEN** the compatibility matrix MUST be updated in the same change to reflect the new contract

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
