## Why

The sandboxed-node require system (`packages/sandboxed-node/src/shared/require-setup.ts`) has accumulated inline hacks that mix concerns: third-party package shims (`chalk`, `supports-color`) sit alongside Node built-in stubs (`tty`, `constants`, `v8`) and post-load monkeypatches (`util`, `url`, `path`). These are brittle, violate the bridge-boundary-policy (third-party shims bypass sandboxed resolution; custom stubs replace available `node-stdlib-browser` polyfills), and make the require path hard to reason about. Cleaning this up now prevents the hacks from spreading as more packages run in the sandbox.

## What Changes

- **Remove `chalk` and `supports-color` inline shims.** These are third-party packages and must resolve from sandboxed `node_modules` like any other dependency, per bridge-boundary-policy. If a sandboxed package needs them, it must carry them in its own dependency tree.
- **Remove `tty` and `constants` custom stubs.** Both have polyfills in `node-stdlib-browser` (`tty-browserify`, `constants-browserify`). Let them fall through to the existing polyfill loader instead of short-circuiting with hand-rolled objects.
- **Move `v8` stub to an explicit built-in stub registry.** No `node-stdlib-browser` polyfill exists for `v8`. Keep a minimal stub, but register it alongside the bridge modules rather than inlining it in the require function body.
- **Replace `util`/`url`/`path` post-load monkeypatches with a dedicated polyfill patch layer.** The current patches fix real gaps (`util.formatWithOptions`, `url.URL` relative file: handling, `path.win32`/`posix`/`resolve` cwd injection). Extract these into a named, testable patch function applied after polyfill evaluation rather than scattered inline in the require body.

## Capabilities

### New Capabilities
- `builtin-module-compat`: Defines the contract for how gaps in `node-stdlib-browser` polyfills are handled — which modules get explicit stubs, how post-load patches are applied, and the boundary between polyfill responsibility and sandbox-specific fixes.

### Modified Capabilities
_(none — this change aligns with existing bridge-boundary-policy and compatibility-governance specs; it does not change their requirements)_

## Impact

- **Code**: `packages/sandboxed-node/src/shared/require-setup.ts` (primary), `packages/sandboxed-node/src/index.ts` (v8 stub registration)
- **Dependencies**: No new dependencies. Relies on existing `node-stdlib-browser` polyfills (`tty-browserify`, `constants-browserify`) already installed.
- **Risk**: Packages that implicitly depend on the `chalk`/`supports-color` shims will fail to resolve if those packages aren't in their sandboxed `node_modules`. This is the correct behavior per bridge-boundary-policy but may surface missing dependencies in existing sandbox setups.
- **Docs**: `docs-internal/node/stdlib-compat.md` entries for `tty`, `constants`, `v8` need updating to reflect new resolution paths.
