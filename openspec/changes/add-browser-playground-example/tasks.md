## 1. OpenSpec

- [x] 1.1 Add a new `browser-examples` capability delta defining the browser playground requirements.

## 2. Example App

- [x] 2.1 Add `packages/playground/` with a browser page, Monaco editor wiring, language switcher, and output panel using the inspector dark theme.
- [x] 2.2 Run TypeScript code through `secure-exec` browser runtime execution and surface streamed stdout/stderr plus exit state.
- [x] 2.3 Run Python code through an in-browser Pyodide runner and surface stdout/stderr plus exit state.
- [x] 2.4 Add local helper scripts to bundle the browser runtime worker and serve the repo root for the example.

## 3. Documentation And Validation

- [x] 3.1 Add example usage instructions and a discoverability note in repository docs.
- [x] 3.2 Run targeted validation for the example worker build and a browser smoke check covering both TypeScript and Python execution.
