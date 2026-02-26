## 1. Extract Polyfill Patch Layer

- [x] 1.1 Create `_patchPolyfill(name, result)` function in `require-setup.ts` that applies known polyfill fixes: `util.formatWithOptions`, `url.URL` relative file: handling, `path.win32`/`posix`/`resolve` cwd injection. Move all three patch blocks from the current inline location into this function.
- [x] 1.2 Replace the inline `if (name === 'util')`, `if (name === 'url')`, and `if (name === 'path')` blocks in the polyfill evaluation section with a single `result = _patchPolyfill(name, result)` call.

## 2. Remove Third-Party Shims

- [x] 2.1 Delete the `chalk` inline stub block (lines ~100-122) from `require-setup.ts`.
- [x] 2.2 Delete the `supports-color` inline stub block (lines ~124-137) from `require-setup.ts`.

## 3. Remove Redundant Built-in Stubs

- [x] 3.1 Delete the `tty` inline stub block from `require-setup.ts`. Verify `tty-browserify` loads correctly through the polyfill path by running existing tests.
- [x] 3.2 Delete the `constants` inline stub block from `require-setup.ts`. Verify `constants-browserify` loads correctly through the polyfill path by running existing tests.

## 4. Relocate v8 Stub

- [x] 4.1 Move the `v8` stub object out of `require-setup.ts` and into `index.ts` isolate setup — pre-populate `_moduleCache['v8']` after the `globalThis._moduleCache = {}` initialization, alongside bridge module setup.
- [x] 4.2 Delete the `v8` inline stub block from `require-setup.ts`.

## 5. Verify and Update Docs

- [x] 5.1 Run tests in `packages/sandboxed-node` to verify no regressions from the cleanup (`pnpm vitest run` scoped to require/polyfill tests).
- [x] 5.2 Update `docs-internal/node/stdlib-compat.md` entries for `tty`, `constants`, and `v8` to reflect their new resolution paths (polyfill vs pre-registered stub).
- [x] 5.3 Mark the "Remove brittle require-path hacks" item in `docs-internal/todo/sandboxed-node.md` as complete.
