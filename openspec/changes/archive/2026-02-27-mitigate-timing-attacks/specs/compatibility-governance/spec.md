## ADDED Requirements

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
