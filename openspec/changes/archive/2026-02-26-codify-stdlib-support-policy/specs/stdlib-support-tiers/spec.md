## ADDED Requirements

### Requirement: Every Core Module Has an Explicit Support Tier
Every Node.js core module referenced in the stdlib compatibility matrix SHALL be classified into exactly one of five tiers: Bridge, Polyfill, Stub, Deferred, or Unsupported.

#### Scenario: New module referenced in compatibility matrix
- **WHEN** a Node.js core module is added to or already exists in the compatibility matrix
- **THEN** it MUST carry an explicit tier classification with defined runtime behavior

#### Scenario: Module tier is queried by a contributor
- **WHEN** a contributor checks the compatibility matrix for a module's support level
- **THEN** the tier, supported API surface, and runtime behavior for unsupported APIs MUST be clearly documented

### Requirement: Deterministic Errors for Unsupported APIs
APIs classified as unsupported within any tier MUST throw a descriptive error following the format `"<module>.<api> is not supported in sandbox"` rather than returning `undefined` or silently failing.

#### Scenario: Calling an unsupported API within a bridged module
- **WHEN** sandboxed code calls `fs.watch()` (a known-unsupported API in the fs bridge)
- **THEN** the call MUST throw an error with message matching `"fs.watch is not supported in sandbox"`

#### Scenario: Calling any method on an unsupported module
- **WHEN** sandboxed code requires an unsupported (Tier 5) module and calls a method on it
- **THEN** the method call MUST throw an error indicating the module is not supported in sandbox

### Requirement: Deferred Modules Provide Stub Objects
Modules classified as Deferred (Tier 4) SHALL be requireable without error, returning a stub object whose methods throw descriptive errors on invocation.

#### Scenario: Requiring a deferred module
- **WHEN** sandboxed code calls `require("net")`
- **THEN** the call MUST succeed and return a stub object

#### Scenario: Calling a method on a deferred module stub
- **WHEN** sandboxed code calls `require("net").createConnection()`
- **THEN** the call MUST throw an error indicating the API is not yet supported

### Requirement: Unsupported Modules Throw on Require
Modules classified as Unsupported (Tier 5) SHALL throw immediately when required, indicating they will not be implemented.

#### Scenario: Requiring an unsupported module
- **WHEN** sandboxed code calls `require("cluster")`
- **THEN** the call MUST throw an error indicating the module is not supported in sandbox

### Requirement: fs Missing API Classification
The following `fs` APIs SHALL be classified as Deferred with deterministic error behavior: `watch`, `watchFile`, `chmod`, `chown`, `link`, `symlink`, `readlink`, `truncate`, `utimes`. The APIs `access` and `realpath` SHALL be documented as implemented (Bridge tier).

#### Scenario: Calling a deferred fs API
- **WHEN** sandboxed code calls `fs.symlink()`
- **THEN** the call MUST throw `"fs.symlink is not supported in sandbox"`

#### Scenario: Calling an implemented fs API previously listed as missing
- **WHEN** sandboxed code calls `fs.access("/some/path", callback)`
- **THEN** the call MUST execute normally via the fs bridge without error

### Requirement: child_process.fork Is Permanently Unsupported
`child_process.fork()` SHALL be classified as Unsupported and MUST throw a deterministic error explaining that IPC across the isolate boundary is not supported.

#### Scenario: Calling fork
- **WHEN** sandboxed code calls `require("child_process").fork("script.js")`
- **THEN** the call MUST throw an error matching `"child_process.fork is not supported in sandbox"`

### Requirement: Crypto Is Stub Tier with Insecurity Warning
The `crypto` module SHALL be classified as Stub (Tier 3). The compatibility matrix MUST document that `getRandomValues()` is backed by `Math.random()` and is not cryptographically secure. `subtle.*` methods MUST throw unsupported errors.

#### Scenario: Documentation of crypto insecurity
- **WHEN** a user or contributor reads the crypto section of the compatibility matrix
- **THEN** the entry MUST contain a warning that `getRandomValues()` is not cryptographically secure

#### Scenario: Calling crypto.subtle.digest
- **WHEN** sandboxed code calls `crypto.subtle.digest("SHA-256", data)`
- **THEN** the call MUST throw an error indicating subtle crypto is not supported in sandbox

### Requirement: Unimplemented Module Tier Assignments
The following modules SHALL be classified as Deferred (Tier 4): `net`, `tls`, `readline`, `perf_hooks`, `async_hooks`, `worker_threads`. The following modules SHALL be classified as Unsupported (Tier 5): `dgram`, `http2` (full), `cluster`, `wasi`, `diagnostics_channel`, `inspector`, `repl`, `trace_events`, `domain`.

#### Scenario: Requiring a deferred unimplemented module
- **WHEN** sandboxed code calls `require("net")`
- **THEN** the call MUST return a stub object (Tier 4 behavior)

#### Scenario: Requiring an unsupported unimplemented module
- **WHEN** sandboxed code calls `require("cluster")`
- **THEN** the call MUST throw immediately (Tier 5 behavior)

### Requirement: Stale Documentation Entries Removed
The compatibility matrix MUST NOT contain entries for third-party modules that are no longer bridged or stubbed in code. Specifically, the `@hono/node-server` entry SHALL be removed.

#### Scenario: Third-party bridge is removed from code
- **WHEN** a third-party module bridge has been deleted from the codebase
- **THEN** its entry MUST be removed from the compatibility matrix in the same or next change
