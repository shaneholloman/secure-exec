## Why

The repository exposes a browser runtime, but there is no straightforward browser-facing example that lets contributors interactively try it. We also now have Python runtime support, and the fastest way to make both surfaces legible is a small in-browser playground that shows code entry, execution, and streamed output in one place.

## What Changes

- Add a simple browser playground example under `examples/` with a Monaco editor, a language switcher, and an output panel.
- Run TypeScript through the browser `NodeRuntime` path so the example demonstrates the existing browser runtime directly.
- Run Python through Pyodide in the browser so the example can expose both languages in one page while keeping the implementation lightweight.
- Reuse the sandbox-agent inspector dark theme tokens and interaction styling so the example matches the existing visual language.
- Add lightweight local tooling to build the browser runtime worker bundle used by the example and serve the repo root for local testing.

## Capabilities

### New Capabilities

- `browser-examples`: Interactive browser example requirements for repository-supported playgrounds.

## Impact

- Affected code: new example files under `packages/playground/`.
- Affected docs: example-specific README and a short root README reference.
- Affected validation: targeted worker bundle build and a browser smoke test for TypeScript and Python execution.
