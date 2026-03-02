## 1. Rename Driver Contract Surface

- [x] 1.1 Rename `packages/secure-exec/src/driver-types.ts` to `packages/secure-exec/src/runtime-driver.ts`
- [x] 1.2 Rename exported driver contract type from `SandboxDriver` to `RuntimeDriver`
- [x] 1.3 Update `packages/secure-exec/src/types.ts` re-exports to point at `runtime-driver.ts`

## 2. Rename Node Runtime Facade Surface

- [x] 2.1 Rename `NodeProcess` to `NodeRuntime` in `packages/secure-exec/src/index.ts`
- [x] 2.2 Rename `NodeProcessOptions` to `NodeRuntimeOptions` and update constructor/error text
- [x] 2.3 Update node driver comments/types to reference `RuntimeDriver`

## 3. Update Call Sites and Docs

- [x] 3.1 Update tests and test helpers (`createTestNodeRuntime`, `LegacyNodeRuntimeOptions`) to the renamed symbols
- [x] 3.2 Update examples and architecture docs to use `NodeRuntime`/`RuntimeDriver`
- [x] 3.3 Update OpenSpec baseline specs (`node-runtime`, `node-permissions`) to use renamed public terms

## 4. Validate Renamed Surface

- [x] 4.1 Run `pnpm -C packages/secure-exec exec tsc --noEmit --pretty false`
- [x] 4.2 Run targeted vitest coverage for renamed paths (`index`, `payload-limits`, `logging-load`, `hono-fetch-external`, `module-access*`, `project-matrix`) and capture failures
