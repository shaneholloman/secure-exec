# Secure Exec SDK

Run sandboxed Node.js code using a driver-based runtime.

## Features

- **Minimal overhead**: TODO
- **Just a library**: TODO
- **Low memory overhead**: TODO

TODO:

- **Node runtime**: isolated-vm backed sandbox execution with driver-owned capability wiring.
- **Browser runtime**: Worker-backed execution through `NodeRuntime` + browser driver factories.
- **Driver-based**: Provide a driver to map filesystem, network, and child_process.
- **Permissions**: Gate syscalls with custom allow/deny functions.
- **Opt-in system features**: Disable network/child_process/FS by omission.

## Examples

- Browser playground: `pnpm -C packages/playground dev`
