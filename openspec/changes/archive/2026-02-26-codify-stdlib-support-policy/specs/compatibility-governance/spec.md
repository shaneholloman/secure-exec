## MODIFIED Requirements

### Requirement: Maintain Node Stdlib Compatibility Matrix
Changes affecting bridged or polyfilled Node APIs MUST keep `docs-internal/node/STDLIB_COMPATIBILITY.md` synchronized with the actual runtime surface, including supported, limited, and unsupported modules/APIs. Every module entry in the matrix MUST include an explicit support-tier classification (Bridge, Polyfill, Stub, Deferred, or Unsupported) as defined by the `stdlib-support-tiers` spec.

#### Scenario: Bridge API surface changes
- **WHEN** a change adds, removes, or materially alters bridged Node API behavior
- **THEN** the compatibility matrix MUST be updated in the same change to reflect the new contract

#### Scenario: Module entry missing tier classification
- **WHEN** a module appears in the compatibility matrix without a tier label
- **THEN** the entry MUST be updated to include the tier before the change is considered complete
