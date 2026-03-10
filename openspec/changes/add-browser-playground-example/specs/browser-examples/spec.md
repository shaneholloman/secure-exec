## ADDED Requirements

### Requirement: Repository Browser Playground Example
The repository SHALL provide a simple browser playground example that lets contributors edit code, execute it in-browser, and inspect output without additional application scaffolding.

#### Scenario: Playground exposes an editor, run controls, and output
- **WHEN** a contributor opens the browser playground example
- **THEN** the page MUST provide a code editor, a language selector, a run action, and a visible output surface

#### Scenario: Playground uses the repository dark theme
- **WHEN** the browser playground example renders
- **THEN** it MUST use the sandbox-agent inspector dark theme tokens and overall visual treatment rather than a default browser theme

### Requirement: Playground Supports TypeScript And Python
The browser playground example SHALL support both TypeScript and Python execution paths in one interface.

#### Scenario: TypeScript executes through secure-exec browser runtime
- **WHEN** a contributor runs TypeScript in the playground
- **THEN** the example MUST execute the code through the repository's browser runtime support and show streamed output plus final execution status

#### Scenario: Python executes in-browser
- **WHEN** a contributor runs Python in the playground
- **THEN** the example MUST execute the code in-browser and show stdout, stderr, and final execution status in the same output surface

### Requirement: Playground Remains Runnable From The Repository
The browser playground example SHALL include repository-local instructions and helper tooling so contributors can run it without creating a separate app.

#### Scenario: Contributor starts the example locally
- **WHEN** a contributor follows the example README
- **THEN** the repository MUST provide a documented local command that builds any required worker asset and serves the example from the repo
