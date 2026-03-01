## ADDED Requirements

### Requirement: Projected Node-Modules Paths MUST Be Read-Only
When driver-managed module projection is enabled, projected sandbox module paths (including `/app/node_modules` and descendants) MUST be treated as read-only runtime state.

#### Scenario: Sandboxed write targets projected module file
- **WHEN** sandboxed code attempts `writeFile`, `unlink`, or `rename` for a path under projected `/app/node_modules`
- **THEN** the operation MUST be denied with `EACCES` regardless of broader filesystem allow rules

#### Scenario: Sandboxed directory mutation targets projected module tree
- **WHEN** sandboxed code attempts `mkdir` or `rmdir` under projected `/app/node_modules`
- **THEN** the operation MUST be denied with `EACCES`

### Requirement: Module Projection MUST Preserve Deny-By-Default Outside Allowed Closure
Projected module access SHALL NOT grant implicit read access to non-projected host filesystem paths.

#### Scenario: Sandbox attempts to read host path outside projected closure
- **WHEN** module projection is configured and sandboxed code accesses a filesystem path outside the projected closure without explicit fs permission allowance
- **THEN** access MUST remain denied by existing deny-by-default permission behavior
