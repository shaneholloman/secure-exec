## ADDED Requirements

### Requirement: Allowed Host Node-Modules Projection MUST Be Explicit and Scoped
The Node runtime SHALL support driver-configured module access that projects only explicitly allowlisted package roots from host installs, and every projected module artifact MUST resolve from paths contained within `<moduleAccess.cwd>/node_modules`.

#### Scenario: Allowlisted package resolves from projected sandbox node_modules
- **WHEN** a driver is configured with `moduleAccess.cwd` and `moduleAccess.allowPackages` including `"zod"`
- **THEN** sandboxed code importing or requiring `"zod"` MUST resolve via projected `/app/node_modules` content and execute without host-global fallback

#### Scenario: Resolved package path escapes configured node_modules boundary
- **WHEN** host-side module discovery resolves a package artifact whose canonical path is outside `<moduleAccess.cwd>/node_modules`
- **THEN** projection MUST fail with a deterministic out-of-scope module-access error and MUST NOT expose that artifact to the sandbox

### Requirement: Projected Module Closure MUST Include Runtime Dependencies
For each allowlisted package root, projection SHALL include transitive runtime dependency closure required for Node-compatible module resolution in sandbox execution.

#### Scenario: Allowlisted package requires transitive dependency
- **WHEN** allowlisted package `A` requires package `B` at runtime and `B` is installed under the scoped host node_modules tree
- **THEN** projection MUST include package `B` so sandbox execution of `A` does not fail due to missing transitive dependency

#### Scenario: Non-allowlisted package remains unavailable
- **WHEN** sandboxed code requires package `X` that is not in any allowlisted package closure
- **THEN** runtime module resolution MUST fail with module-not-found behavior

### Requirement: Projected Modules MUST Exclude Native Addons
Module projection SHALL reject native addon artifacts (`.node`) so projected dependency execution remains within supported sandbox module formats.

#### Scenario: Allowlisted dependency includes native addon file
- **WHEN** projection encounters a `.node` artifact in an allowlisted package closure
- **THEN** projection MUST fail deterministically and MUST NOT make that native addon loadable in sandbox runtime
