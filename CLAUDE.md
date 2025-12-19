- commit your work along the way. do not push it. use branches as needed.
- use pnpm, vitest, and tsc for type checks
- do not use timeouts more than 10s
- use tsx to execute typescript code as needed
- wasmer sdk docs at https://wasmerio.github.io/wasmer-js/
- all bridge types that get injected in to ivm (isolated-vm) need to be defined in packages/nanosandbox/src/bridge/. they also need to be fully type checked agianst @tyeps/node with either `impelments` or `satisfies` or the equivalent
- do not implement polyfills yourself if it already exists in node-stdlib-browser (in node-process/polyfills.ts)
- when running tests, always write tests to a file then cat/grep/etc the file. this lets you read from the file multiple times while only running the expensive test once.
- use timeouts 1 minute or less. do not run all tests at once unless you're testing a large set of changes -- assume tests are slow.
- use turbo to do fresh builds instead of pnpm --filter build

## wasmer-js Filesystem Architecture

The wasmer-js SDK has two filesystem layers:

1. **TmpFileSystem** - Each Instance (spawned command) gets its own TmpFileSystem overlay. Files written via the Instance VFS API (vfsWriteFile, etc.) go to this Instance-specific TmpFileSystem. These files are NOT shared between Instances.

2. **Mounted Directory** - The Directory object mounted at /data is SHARED between all Instances. Files written to Directory are visible to all spawned commands at /data/*.

**Implication**: If you write files via VFS and then spawn a separate command (ls, cat, etc.), that command won't see the VFS files because it has its own TmpFileSystem. To test VFS operations with shell commands, use a shell script within a single spawn() call so all operations happen in the same Instance.

## wasmer-js Node.js Scheduler Issues

The wasmer-js SDK has several issues when running in Node.js:

1. **Event Loop**: The SDK's web-worker based threading doesn't properly keep the Node.js event loop alive. The `withEventLoopActive()` helper in `src/wasix/index.ts` works around this by using a `setInterval`.

2. **Scheduler Race Conditions**: Running more than ~2 WASM commands across separate test blocks causes the scheduler to hang. The third command will start but never complete. This appears to be a state management bug in the wasmer-js scheduler when the "idle" message is processed incorrectly.

3. **Directory Writes Between Commands**: Writing to a Directory object between WASM commands (within the same test) can cause hangs. Always write all files BEFORE running any commands.

**Workarounds in tests**:
- Keep each test to a single WASM command when possible
- Tests that run multiple commands in the same session may need to be skipped
- Add a `setInterval(() => {}, 1000)` keepAlive to test files that use wasmer-js

## sandboxed-node V8 Accelerator

When WASM runs `node`, the `host_exec` syscalls delegate to sandboxed-node's `NodeProcess` (V8 isolate) instead of spawning a real process. See [docs/HOST_EXEC_IPC.md](docs/HOST_EXEC_IPC.md) for architecture details.