## MODIFIED Requirements

### Requirement: Unified Sandbox Execution Interface
The project SHALL provide a stable Node sandbox execution interface, with `NodeRuntime` exposing an `exec` path for running untrusted code and returning structured execution results, and a `run` path that returns module exports. Browser runtime execution support SHALL be disabled for this change phase.

#### Scenario: Execute code in Node runtime
- **WHEN** a caller creates `NodeRuntime` with a valid driver and invokes `exec`
- **THEN** the sandbox MUST run the provided code in an isolated execution context and return structured output for the caller

#### Scenario: Browser runtime is disabled for this phase
- **WHEN** a caller attempts to use browser sandbox runtime entrypoints during this change phase
- **THEN** browser runtime execution MUST be unavailable under the runtime contract until a follow-up change restores support

#### Scenario: Run CJS module and retrieve exports
- **WHEN** a caller invokes `run()` with CommonJS code that assigns to `module.exports`
- **THEN** the result's `exports` field MUST contain the value of `module.exports`

#### Scenario: Run ESM module and retrieve namespace exports
- **WHEN** a caller invokes `run()` with ESM code that uses `export` declarations
- **THEN** the result's `exports` field MUST contain the module namespace object with all named exports and the `default` export (if declared)

#### Scenario: Run ESM module with only a default export
- **WHEN** a caller invokes `run()` with ESM code containing `export default <value>`
- **THEN** the result's `exports` field MUST be an object with a `default` property holding that value

#### Scenario: Run ESM module with named and default exports
- **WHEN** a caller invokes `run()` with ESM code containing both `export default` and named `export` declarations
- **THEN** the result's `exports` field MUST be an object containing both the `default` property and all named export properties

### Requirement: Driver-Based Capability Composition
Runtime capabilities SHALL be composed through host-provided drivers so filesystem, network, and child-process behavior are controlled by configured adapters rather than hardcoded runtime behavior. `NodeRuntime` construction SHALL require a driver.

#### Scenario: Node process uses configured adapters
- **WHEN** `NodeRuntime` is created with a driver that defines filesystem, network, and command-execution adapters
- **THEN** sandboxed operations MUST route through those adapters for capability access

#### Scenario: Missing permissions deny capability access by default
- **WHEN** a driver is configured without explicit permission allowance for a capability domain
- **THEN** operations in that capability domain MUST be denied by default

#### Scenario: Omitted capability remains unavailable
- **WHEN** a capability adapter is omitted from runtime configuration
- **THEN** corresponding sandbox operations MUST be unavailable or denied by the runtime contract
