# deny-by-default-permissions Specification

## Purpose
TBD - created by archiving change deny-by-default-permissions. Update Purpose after archive.
## Requirements
### Requirement: Deny operations when no permission checker is provided
The system SHALL deny (throw `EACCES`) any filesystem, network, child-process, or environment-variable operation when the corresponding `PermissionCheck` callback is `undefined` in the `Permissions` object.

#### Scenario: Filesystem read without fs permission checker
- **WHEN** a sandboxed module calls `fs.readFile("/some/path")` and no `permissions.fs` callback is provided
- **THEN** the operation SHALL throw an `EACCES` error with syscall `open` and the requested path

#### Scenario: Network fetch without network permission checker
- **WHEN** a sandboxed module calls `fetch("https://example.com")` and no `permissions.network` callback is provided
- **THEN** the operation SHALL throw an `EACCES` error with syscall `connect` and the requested URL

#### Scenario: Child process spawn without childProcess permission checker
- **WHEN** a sandboxed module calls `child_process.spawn("ls", ["-la"])` and no `permissions.childProcess` callback is provided
- **THEN** the operation SHALL throw an `EACCES` error with syscall `spawn` and the command name

#### Scenario: Environment variable read without env permission checker
- **WHEN** a sandboxed module accesses `process.env.SECRET_KEY` and no `permissions.env` callback is provided
- **THEN** the access SHALL throw an `EACCES` error with syscall `access` and the key name

### Requirement: filterEnv returns empty object when no checker is provided
The `filterEnv` function SHALL return an empty object `{}` when no `permissions.env` callback is provided, preventing any host environment variables from leaking into the sandbox.

#### Scenario: filterEnv with no env permission checker
- **WHEN** `filterEnv` is called with a populated `env` record and `permissions.env` is `undefined`
- **THEN** the result SHALL be an empty object `{}`

#### Scenario: filterEnv with explicit allow-all env permission checker
- **WHEN** `filterEnv` is called with a populated `env` record and `permissions.env` returns `{ allow: true }` for all keys
- **THEN** the result SHALL contain all entries from the input `env` record

### Requirement: allowAll permission helper
The system SHALL export an `allowAll` constant of type `Permissions` where every domain checker (`fs`, `network`, `childProcess`, `env`) returns `{ allow: true }`.

#### Scenario: Sandbox created with allowAll permits all operations
- **WHEN** a `NodeProcess` is created with `permissions: allowAll` and a filesystem adapter
- **THEN** all filesystem operations SHALL succeed without `EACCES` errors

#### Scenario: allowAll is a valid Permissions object
- **WHEN** `allowAll` is assigned to a variable of type `Permissions`
- **THEN** it SHALL compile without type errors

### Requirement: Per-domain permission helpers
The system SHALL export per-domain allow helpers: `allowAllFs`, `allowAllNetwork`, `allowAllChildProcess`, `allowAllEnv`. Each SHALL be a partial `Permissions` object containing only the corresponding domain checker returning `{ allow: true }`.

#### Scenario: Compose per-domain helpers for selective access
- **WHEN** a `NodeProcess` is created with `permissions: { ...allowAllFs, ...allowAllNetwork }` and both filesystem and network adapters
- **THEN** filesystem and network operations SHALL succeed, while child-process and env operations SHALL throw `EACCES`

### Requirement: Explicit deny overrides adapter presence
When a `PermissionCheck` callback returns `{ allow: false }`, the operation SHALL be denied regardless of whether the underlying adapter is capable of performing it.

#### Scenario: Permission checker denies a specific path
- **WHEN** `permissions.fs` returns `{ allow: false }` for path `/secret` and the filesystem adapter has the file
- **THEN** `fs.readFile("/secret")` SHALL throw an `EACCES` error (unchanged from current behavior)

