# Host Exec IPC: WASIX to Sandboxed Node Communication

This document explains how WASM processes running in WASIX can spawn and communicate with host Node.js processes through a custom IPC mechanism.

## Overview

The sandbox runs WASM binaries (bash, coreutils, etc.) in Web Workers using the wasmer-js runtime. Sometimes these WASM processes need to execute commands that can't run in WASM (e.g., `node`, `npm`). The `host_exec` syscalls enable bidirectional streaming communication between WASM and host.

For `node` commands specifically, we use sandboxed-node's `NodeProcess` (V8 isolate via isolated-vm) instead of spawning a real process. This provides better security, faster execution, and controlled sandbox environment.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Web Worker (WASM)                                                   │
│                                                                     │
│   ┌─────────────────┐      ┌─────────────────────────────────┐     │
│   │ wasix-runtime   │      │ wasmer-wasix                    │     │
│   │ (Rust WASM)     │─────>│ syscall handlers                │     │
│   │                 │      │ (host_exec_start, poll, etc.)   │     │
│   └─────────────────┘      └─────────────────────────────────┘     │
│                                       │                             │
│                                       │ postMessage                 │
└───────────────────────────────────────│─────────────────────────────┘
                                        │
                    SharedArrayBuffer + Atomics (sync)
                                        │
┌───────────────────────────────────────│─────────────────────────────┐
│ Main Thread (nanosandbox)             ▼                             │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────┐      │
│   │ hostExecHandler                                          │      │
│   │ - Receives HostExecContext from scheduler                │      │
│   │ - Routes "node" to sandboxed-node (V8 isolate)          │      │
│   │ - Streams stdout/stderr back via callbacks               │      │
│   └─────────────────────────────────────────────────────────┘      │
│                              │                                      │
│                              │ new NodeProcess()                    │
│                              ▼                                      │
│   ┌─────────────────────────────────────────────────────────┐      │
│   │ sandboxed-node (V8 Isolate)                              │      │
│   │ - Isolated V8 context via isolated-vm                    │      │
│   │ - Configurable process.pid, env, cwd, argv               │      │
│   │ - Node.js API polyfills (fs, path, etc.)                 │      │
│   └─────────────────────────────────────────────────────────┘      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Syscalls

The following custom syscalls are implemented in `wasmer-wasix`:

| Syscall | Description |
|---------|-------------|
| `host_exec_start` | Start a host process, returns session ID |
| `host_exec_write` | Write data to the process's stdin |
| `host_exec_close_stdin` | Signal EOF on stdin |
| `host_exec_poll` | Non-blocking check if output is available |
| `host_exec_try_read` | Non-blocking read of stdout/stderr/exit |
| `host_exec_signal` | Send a signal (SIGTERM, SIGKILL, etc.) to the process |

### Message Types

The `host_exec_try_read` syscall returns different message types:

```rust
const HOST_EXEC_STDOUT: u32 = 1;  // stdout data
const HOST_EXEC_STDERR: u32 = 2;  // stderr data
const HOST_EXEC_EXIT: u32 = 3;    // process exited (data_len = exit code)
```

## Synchronization

The key challenge is synchronizing between:
1. **WASM worker** - blocks using `Atomics.wait()`
2. **Main thread scheduler** - receives async I/O from host process

### SharedArrayBuffer Layout

Each worker gets a SharedArrayBuffer with an Int32Array view:

```
Offset 0: Notification flag (0 = no data, 1 = data ready)
```

### Flow

1. **WASM calls `host_exec_poll`**
   - Posts message to scheduler
   - Scheduler checks output queue
   - Returns immediately with ready status

2. **WASM calls `host_exec_try_read`**
   - If no data: returns `EAGAIN` (errno 6)
   - If data available: copies to buffer, returns success

3. **Scheduler receives host output**
   - Queues data for the session
   - Calls `Atomics.store()` to set ready flag
   - Calls `Atomics.notify()` to wake any waiting worker

## Files

### wasmer (syscall definitions)

| File | Purpose |
|------|---------|
| `lib/wasix/src/syscalls/wasix/host_exec_start.rs` | Start syscall |
| `lib/wasix/src/syscalls/wasix/host_exec_write.rs` | Write to stdin |
| `lib/wasix/src/syscalls/wasix/host_exec_close_stdin.rs` | Close stdin |
| `lib/wasix/src/syscalls/wasix/host_exec_poll.rs` | Poll for readiness |
| `lib/wasix/src/syscalls/wasix/host_exec_try_read.rs` | Non-blocking read |
| `lib/wasix/src/runtime/host_exec.rs` | Runtime trait |

### wasmer-js (implementation)

| File | Purpose |
|------|---------|
| `src/runtime.rs` | `HostExecImpl` trait implementation |
| `src/tasks/scheduler.rs` | Message handling, process spawning |
| `src/tasks/thread_pool_worker.rs` | Worker-side Atomics setup |
| `src/tasks/scheduler_message.rs` | IPC message types |

### nanosandbox (host handler + WASM shim)

| File | Purpose |
|------|---------|
| `packages/nanosandbox/src/vm/index.ts` | hostExecHandler routes to NodeProcess |
| `wasix-runtime/src/main.rs` | WASM binary that uses syscalls |

### sandboxed-node (V8 isolate)

| File | Purpose |
|------|---------|
| `packages/sandboxed-node/src/index.ts` | NodeProcess class |
| `packages/sandboxed-node/bridge/process.ts` | process polyfill with pid/env/argv |

## WASM Shim Event Loop

The wasix-runtime shim uses WASI's `poll_oneoff` to multiplex between stdin and a timeout:

```rust
loop {
    // Check for host output (non-blocking)
    loop {
        if host_exec_poll(session) == 0 { break; }
        host_exec_try_read(session, ...);
        // Handle stdout/stderr/exit
    }

    // Wait for stdin OR 10ms timeout
    poll_oneoff([stdin_subscription, timeout_10ms]);

    // Handle stdin if ready
    if stdin_ready {
        read(stdin);
        host_exec_write(session, data);
    }
}
```

The 10ms timeout is necessary because `poll_oneoff` can't directly wait on host_exec output. See [research/host-exec-notify-fd.md](research/host-exec-notify-fd.md) for a future optimization to eliminate this polling overhead.

## Request Format

The `host_exec_start` syscall takes a JSON-encoded request:

```rust
struct HostExecRequest {
    command: String,           // e.g., "node"
    args: Vec<String>,         // e.g., ["-e", "console.log('hi')"]
    env: HashMap<String, String>,
    cwd: String,
    terminal: Option<TerminalOptions>,  // Optional terminal settings
}

struct TerminalOptions {
    term: String,   // e.g., "xterm-256color"
    cols: u16,      // Terminal width
    rows: u16,      // Terminal height
}
```

When `terminal` is set, the host process receives:
- `TERM` environment variable (e.g., "xterm-256color")
- `COLUMNS` environment variable (terminal width)
- `LINES` environment variable (terminal height)

## Signals

The `host_exec_signal` syscall sends signals to the host process:

```rust
fn host_exec_signal(session: u64, signal: Signal) -> Errno;
```

Supported signals include:
- `SIGTERM` (15) - Graceful termination
- `SIGKILL` (9) - Forced termination
- `SIGINT` (2) - Interrupt (Ctrl+C)
- `SIGHUP` (1) - Hangup

The JS handler receives signals via the `setKillFunction` callback and forwards them to `child.kill(signal)`.

When a process is killed by a signal, the exit code follows the Unix convention: `128 + signal_number`.

## Example: Running Node from WASM

1. WASM bash runs `node -e "console.log('hello')"`
2. Bash is configured to use wasix-runtime shim for `node`
3. Shim calls `host_exec_start` with the command
4. Scheduler calls hostExecHandler with HostExecContext
5. hostExecHandler creates NodeProcess (V8 isolate)
6. NodeProcess.exec() runs the code
7. stdout/stderr streamed back via onStdout/onStderr callbacks
8. Exit code returned to WASM

## HostExecContext to ProcessConfig

When hostExecHandler creates a NodeProcess, it maps context to config:

| HostExecContext | ProcessConfig | Notes |
|-----------------|---------------|-------|
| `ctx.cwd` | `processConfig.cwd` | Working directory |
| `ctx.env` | `processConfig.env` | Environment variables |
| `ctx.args` | `processConfig.argv` | Command line arguments |
| (generated) | `processConfig.pid` | Unique PID from counter |
| (hardcoded) | `processConfig.ppid` | Always 1 (WASM shell parent) |

## Security Considerations

- Host process execution is controlled by the sandbox configuration
- The scheduler validates allowed commands before spawning
- Environment variables are filtered/sanitized
- Working directory is constrained to the virtual filesystem mount

## Intentionally Not Implemented

The following POSIX process capabilities are intentionally not implemented for host_exec:

### Process Groups / Job Control
- `setpgid`, `getpgid` - process group management
- `setsid`, `getsid` - session management
- `tcsetpgrp`, `tcgetpgrp` - foreground process group control
- `SIGTSTP`, `SIGCONT` - job control signals (suspend/resume)

These are not needed for the sandbox use case where processes run to completion.

### Wait Variants
- `WNOHANG` - non-blocking wait (use `host_exec_poll` instead)
- `WUNTRACED`, `WCONTINUED` - report stopped/continued children
- `wait3`, `wait4` - resource usage reporting

The polling-based I/O model provides the needed functionality.

### Process Info
- Get host process PID
- Check if process is running without consuming output

Signals can be sent without needing the PID since sessions are identified by session ID.
