## MODIFIED Requirements

### Requirement: allowAll permission helper
The system SHALL export an `allowAll` constant of type `Permissions` where every domain checker (`fs`, `network`, `childProcess`, `env`) returns `{ allow: true }`.

#### Scenario: Runtime created with allowAll permits all operations
- **WHEN** a `NodeRuntime` is created with `permissions: allowAll` and a filesystem adapter
- **THEN** all filesystem operations SHALL succeed without `EACCES` errors

#### Scenario: allowAll is a valid Permissions object
- **WHEN** `allowAll` is assigned to a variable of type `Permissions`
- **THEN** it SHALL compile without type errors

### Requirement: Per-domain permission helpers
The system SHALL export per-domain allow helpers: `allowAllFs`, `allowAllNetwork`, `allowAllChildProcess`, `allowAllEnv`. Each SHALL be a partial `Permissions` object containing only the corresponding domain checker returning `{ allow: true }`.

#### Scenario: Compose per-domain helpers for selective access
- **WHEN** a `NodeRuntime` is created with `permissions: { ...allowAllFs, ...allowAllNetwork }` and both filesystem and network adapters
- **THEN** filesystem and network operations SHALL succeed, while child-process and env operations SHALL throw `EACCES`
