## Why

libsandbox has substantial implementation and research documentation, but no OpenSpec baseline that defines current project requirements in one authoritative place. Bootstrapping specs now prevents drift between code, internal docs, and future changes as sandboxed-node evolves.

## What Changes

- Create initial OpenSpec capability specs that describe the current runtime contract across Node and browser drivers.
- Codify strict bridge boundary requirements (Node built-ins only, no third-party bridge shims, permission-controlled capability exposure).
- Define compatibility/governance requirements for keeping TODO, friction, and stdlib compatibility documentation synchronized with runtime behavior.

## Capabilities

### New Capabilities
- `runtime-execution-model`: Defines the required execution behavior, driver model, and host/sandbox interaction contract.
- `bridge-boundary-policy`: Defines hard constraints for bridge scope, module resolution boundaries, and capability expansion controls.
- `compatibility-governance`: Defines required maintenance of compatibility, TODO, and friction artifacts as part of normal development.

### Modified Capabilities
- None.

## Impact

- Adds initial spec baselines under `openspec/specs/` for the sandboxed-node-focused requirements that currently live in scattered docs.
- Sets review criteria for future runtime and bridge changes, including documentation update obligations.
- Aligns internal research and compatibility docs with explicit, testable requirement language for follow-on implementation changes.
