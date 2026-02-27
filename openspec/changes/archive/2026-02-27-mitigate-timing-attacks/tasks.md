## 1. Runtime Security Options

- [x] 1.1 Extend `NodeProcessOptions` and shared API types with `executionTimeoutMs` and `timingMitigation` (`"off" | "freeze"`), defaulting `timingMitigation` to `"freeze"`.
- [x] 1.2 Plumb `executionTimeoutMs` through user-code execution boundaries (`script.run`, `module.evaluate`, awaited eval paths) in `NodeProcess.executeInternal`.
- [x] 1.3 Normalize timeout failures into deterministic runtime error handling and non-zero exit behavior for `run()` and `exec()`.

## 2. Timing Mitigation Wiring

- [x] 2.1 Add an execution-scoped hardened clock installer in `NodeProcess` that activates by default and can be disabled with `timingMitigation === "off"`.
- [x] 2.2 Route process timing helpers (`process.hrtime`, `process.hrtime.bigint`, `process.uptime`) through hardened clock state when active.
- [x] 2.3 Remove `SharedArrayBuffer` from sandbox globals in freeze mode and verify default mode behavior is unchanged.

## 3. Verification And Documentation

- [x] 3.1 Add targeted vitest coverage for secure-default vs compatibility timing behavior (`Date.now`, `performance.now`, `process.hrtime`, `SharedArrayBuffer` visibility).
- [x] 3.2 Add targeted vitest coverage for timeout budget enforcement (`executionTimeoutMs`) including infinite-loop termination.
- [x] 3.3 Update `docs-internal/research/comparison/cloudflare-workers-isolates.md` and `docs-internal/friction/sandboxed-node.md` with the approved mitigation and compatibility notes.
- [x] 3.4 Run targeted checks: `pnpm --filter sandboxed-node test -- tests/index.test.ts` and `pnpm --filter sandboxed-node check-types`.
  - `2026-02-27`: `pnpm --filter sandboxed-node test -- tests/index.test.ts` passed (`34` tests).
  - `2026-02-27`: `pnpm --filter sandboxed-node check-types` still fails with broad pre-existing bridge/browser typing issues unrelated to this change.
  - `2026-02-27`: `pnpm --filter sandboxed-node run check-types:test` executed (required by compatibility governance for bridge edits) and reports the same pre-existing type errors.
