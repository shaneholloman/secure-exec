## ADDED Requirements

### Requirement: Module-Access Boundary Changes MUST Update Security and Friction Documentation
Any change that introduces or modifies driver-managed host module projection boundaries MUST update compatibility/friction and security-model documentation in the same change.

#### Scenario: Scoped node_modules projection behavior is introduced or changed
- **WHEN** runtime or driver behavior for projected module access changes (including scope boundary, read-only policy, or native-addon rejection)
- **THEN** `docs-internal/friction/secure-exec.md` MUST document the compatibility trade-off and resolution notes in the same change

#### Scenario: Host trust-boundary assumptions for module loading change
- **WHEN** module-loading trust boundaries change due to driver-managed host dependency projection
- **THEN** `docs/security-model.mdx` MUST describe the boundary and the enforced `<cwd>/node_modules` containment contract
