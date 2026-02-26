## Context

The sandboxed-node require system (`packages/sandboxed-node/src/shared/require-setup.ts`) handles three kinds of modules:

1. **Bridge modules** — host-provided implementations (fs, http, child_process, os, dns, module, process). Registered as globals (`_httpModule`, `_osModule`, etc.) by the bridge bundle and returned directly by the require function.
2. **Polyfilled modules** — Node built-ins with `node-stdlib-browser` equivalents (path, events, buffer, stream, util, url, etc.). Loaded via `_loadPolyfill`, which bundles them on-demand with esbuild.
3. **Filesystem modules** — third-party packages resolved from sandboxed `node_modules` via `_resolveModule`/`_loadFile`.

The current require function mixes all three concerns plus two others that don't belong:
- **Third-party shims** (`chalk`, `supports-color`) — inline stubs that bypass sandboxed resolution, violating bridge-boundary-policy.
- **Post-load monkeypatches** (`util.formatWithOptions`, `url.URL`, `path.win32/posix/resolve`) — fixes for polyfill gaps, applied as ad-hoc `if (name === 'x')` blocks after `eval(polyfillCode)`.
- **Inline built-in stubs** (`tty`, `constants`, `v8`) — hand-rolled objects that duplicate or ignore existing polyfills.

## Goals / Non-Goals

**Goals:**
- Remove all third-party package shims from the require function
- Use `node-stdlib-browser` polyfills for `tty` and `constants` instead of custom stubs
- Extract `v8` stub into a named registry alongside bridge modules
- Extract polyfill patches into a dedicated, testable function
- Keep the require function body focused on the three-tier resolution flow (bridge → polyfill → filesystem)

**Non-Goals:**
- Changing how bridge modules are registered or loaded
- Fixing polyfill gaps upstream in `node-stdlib-browser` packages
- Adding new module support or expanding the bridge surface
- Modifying the filesystem module resolution logic

## Decisions

### 1. Remove `chalk` and `supports-color` shims entirely

**Choice:** Delete the inline stubs. Let these packages resolve through normal sandboxed `node_modules` resolution (tier 3).

**Alternative considered:** Move shims to a "third-party fallback" registry. Rejected because this still violates bridge-boundary-policy and masks missing dependencies.

**Rationale:** Bridge-boundary-policy requires third-party packages to resolve from sandboxed dependencies. If a sandboxed package needs chalk, it must declare it as a dependency. The sandbox environment correctly has no TTY, so color libraries should either (a) be present and detect no-color naturally, or (b) not be required at all.

### 2. Let `tty` and `constants` fall through to polyfill loader

**Choice:** Remove the inline `if (name === 'tty')` and `if (name === 'constants')` blocks. The existing `_loadPolyfill` path already handles these — `node-stdlib-browser` maps `tty` to `tty-browserify` and `constants` to `constants-browserify`.

**Alternative considered:** Keep custom stubs but move them to a registry. Rejected because the polyfills already exist and are more complete than the hand-rolled stubs (e.g., `constants-browserify` provides the full POSIX constants set, not just three signals).

**Rationale:** Bridge-boundary-policy's "Prefer Standard Polyfills" requirement. The polyfill loader (`_loadPolyfill`) already checks `hasPolyfill(name)` against the `node-stdlib-browser` mapping. Removing the early-return stubs lets tty/constants flow through naturally.

### 3. Register `v8` stub alongside bridge modules

**Choice:** Move the `v8` stub object out of the require function body. Register it as a pre-populated entry in `_moduleCache` during isolate setup (in `index.ts`), alongside where bridge module globals are set up.

**Alternative considered:** Create a `v8` bridge file under `src/bridge/`. Rejected as overkill — v8 doesn't need host-side callbacks; it's a static stub.

**Rationale:** `v8` has no `node-stdlib-browser` polyfill and doesn't need host communication. Pre-populating the cache is the lightest-weight approach and keeps the require function clean. The stub provides the same API surface but lives in a discoverable location.

### 4. Extract polyfill patches into a `patchPolyfill(name, exports)` function

**Choice:** Create a `getPolyfillPatchCode()` function (exported from a new file or from `require-setup.ts`) that returns the JavaScript source for a `_patchPolyfill(name, result)` function. This function is called after `eval(polyfillCode)` in the require path. It contains the `util`, `url`, and `path` patches with comments explaining what each fixes.

**Alternative considered:** Apply patches at bundle time in `polyfills.ts`. Rejected because the patches depend on runtime state (`process.cwd()`) that isn't available during esbuild bundling.

**Rationale:** Extracting patches makes them:
- Enumerable (easy to see what's patched and why)
- Testable (can verify each patch independently)
- Removable (when upstream polyfills fix the gaps)

The function signature `_patchPolyfill(name, result)` takes the module name and the evaluated polyfill exports, applies any known patches, and returns the (possibly modified) exports.

### 5. Require function structure after cleanup

The cleaned-up `_requireFrom` will have this flow:

```
1. Strip node: prefix
2. Check _moduleCache (catches bridge modules, v8 stub, and previously-loaded polyfills)
3. Check bridge module globals (fs via _fsModuleCode, child_process, http, https, http2, dns, os, module)
4. Check process special case
5. Try _loadPolyfill → if hit, eval + _patchPolyfill + cache
6. Resolve from filesystem via _resolveModule/_loadFile
```

Steps 1-4 are unchanged. Step 5 loses the inline patches. Step 6 is unchanged. The `chalk`, `supports-color`, `tty`, `constants`, and `v8` blocks are all removed from the function body.

## Risks / Trade-offs

**[Packages depending on `chalk`/`supports-color` shims will break]** → Expected and correct. Surfaces real missing dependencies. Mitigation: document in stdlib-compat.md that third-party packages must be in sandboxed `node_modules`.

**[`tty-browserify` or `constants-browserify` polyfill may behave differently than current stubs]** → Low risk. `tty-browserify` returns `isatty: false` (same as current stub). `constants-browserify` provides a superset of the current three-signal stub. Mitigation: verify behavior in existing tests after change.

**[`path.resolve` patch depends on runtime `process.cwd()`]** → Kept as-is in the patch layer, not removed. The patch is correct behavior; it just moves to a named function.

**[`url.URL` patch is npm-specific]** → Documented in the patch function. May become unnecessary if npm's `npm-package-arg` fixes its `file:.` handling. Patch can be removed independently later.
