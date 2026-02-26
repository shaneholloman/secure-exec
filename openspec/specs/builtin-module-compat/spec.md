# builtin-module-compat Specification

## Purpose
TBD - created by archiving change clean-require-hacks. Update Purpose after archive.
## Requirements
### Requirement: Third-Party Packages Must Not Be Shimmed in Require Resolution
The require system MUST NOT contain inline stubs or shims for third-party npm packages. Packages that are not Node.js built-in modules SHALL resolve exclusively through sandboxed `node_modules` filesystem resolution.

#### Scenario: Sandboxed code requires a third-party package with no shim
- **WHEN** sandboxed code calls `require('chalk')` or `require('supports-color')`
- **THEN** the require system MUST attempt filesystem resolution from sandboxed `node_modules` and MUST NOT return a hardcoded stub

#### Scenario: Third-party package is missing from sandboxed dependencies
- **WHEN** sandboxed code requires a third-party package not present in sandboxed `node_modules`
- **THEN** the require system MUST throw a standard "Cannot find module" error

### Requirement: Node Built-in Modules With Polyfills Must Use Standard Polyfills
When `node-stdlib-browser` provides a polyfill for a Node built-in module, the require system MUST load that polyfill through the standard polyfill loader rather than returning a custom inline stub.

#### Scenario: Require resolves tty through polyfill loader
- **WHEN** sandboxed code calls `require('tty')`
- **THEN** the require system MUST load `tty-browserify` via the polyfill loader, not a hand-rolled stub

#### Scenario: Require resolves constants through polyfill loader
- **WHEN** sandboxed code calls `require('constants')`
- **THEN** the require system MUST load `constants-browserify` via the polyfill loader, not a hand-rolled stub

### Requirement: Node Built-in Modules Without Polyfills Use Explicit Stubs
Node built-in modules that have no `node-stdlib-browser` polyfill and no bridge implementation SHALL be handled by pre-registered stub entries in the module cache, not by inline conditionals in the require function body.

#### Scenario: v8 module resolves from pre-registered cache
- **WHEN** sandboxed code calls `require('v8')`
- **THEN** the module MUST resolve from a pre-populated `_moduleCache` entry set during isolate setup

#### Scenario: v8 stub provides expected API surface
- **WHEN** sandboxed code accesses `require('v8').getHeapStatistics()`
- **THEN** the stub MUST return a plausible heap statistics object without throwing

### Requirement: Polyfill Gaps Are Addressed by a Named Patch Layer
Known gaps in `node-stdlib-browser` polyfills (missing methods, incorrect behavior) SHALL be fixed by a dedicated patch function applied after polyfill evaluation, not by inline conditional blocks scattered in the require function.

#### Scenario: util polyfill receives formatWithOptions patch
- **WHEN** the `util` polyfill is loaded and lacks `formatWithOptions`
- **THEN** the patch layer MUST add a `formatWithOptions` implementation that delegates to `util.format`

#### Scenario: url polyfill receives relative file URL patch
- **WHEN** the `url` polyfill is loaded
- **THEN** the patch layer MUST wrap `URL` to handle relative `file:` URLs (e.g., `file:.`) by falling back to `process.cwd()` as base

#### Scenario: path polyfill receives win32/posix and resolve patches
- **WHEN** the `path` polyfill is loaded
- **THEN** the patch layer MUST ensure `path.win32` and `path.posix` exist and MUST wrap `path.resolve` to prepend `process.cwd()` when no absolute path argument is provided

#### Scenario: Unpatched module passes through unchanged
- **WHEN** a polyfill module has no known gaps (e.g., `events`, `buffer`)
- **THEN** the patch layer MUST return the polyfill exports unmodified

