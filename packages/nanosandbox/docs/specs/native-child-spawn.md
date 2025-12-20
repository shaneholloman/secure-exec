# Native Child Process Spawning in wasix-runtime

## Problem

`handle_spawn_via_host_exec` incorrectly calls `host_exec_start` again, creating nested host_exec sessions. This is wrong because:

1. It adds unnecessary round-trips through the host_exec IPC
2. The host already has callbacks stored via `requestSpawn`
3. Child processes should spawn **natively in WASIX** using `std::process::Command`

## Current (Incorrect) Flow

```
sandboxed-node calls spawnSync('echo', ['hello'])
  → spawnChildStreaming calls requestSpawn (stores callbacks)
  → SPAWN_REQUEST sent to wasix-runtime
  → wasix-runtime calls host_exec_start AGAIN  ← WRONG
  → Creates nested session for child
  → Host spawns child via handleShellCommand
  → Output flows back through nested session
```

## Correct Flow

```
sandboxed-node calls spawnSync('echo', ['hello'])
  → spawnChildStreaming calls requestSpawn (stores callbacks in CHILD_OUTPUT_HANDLERS)
  → SPAWN_REQUEST sent to wasix-runtime
  → wasix-runtime spawns child NATIVELY via Command::new()  ← CORRECT
  → wasix-runtime reads child stdout/stderr
  → wasix-runtime sends output via host_exec_child_output
  → Scheduler receives HostExecChildOutput message
  → Scheduler invokes stored callbacks (onStdout, onStderr, onExit)
  → sandboxed-node receives output
```

## Implementation

### File: `wasix-runtime/src/main.rs`

#### 1. Update `ChildProcess` struct

```rust
struct ChildProcess {
    child: Child,
    parent_session: u64,  // Session to send output back to
}
```

#### 2. Replace `handle_spawn_request` implementation

```rust
fn handle_spawn_request(
    parent_session: u64,
    data: &[u8],
    children: &mut HashMap<u64, ChildProcess>,
) {
    let spawn_req: SpawnRequest = match serde_json::from_slice(data) {
        Ok(req) => req,
        Err(e) => {
            eprintln!("[wasix-shim] Failed to parse SPAWN_REQUEST: {}", e);
            return;
        }
    };

    eprintln!(
        "[wasix-shim] Spawning child {}: {} {:?}",
        spawn_req.child_id, spawn_req.command, spawn_req.args
    );

    // Log PATH to verify /bin is included
    eprintln!("[wasix-shim] PATH={:?}", spawn_req.env.get("PATH"));

    // Spawn child natively using std::process::Command
    let result = Command::new(&spawn_req.command)
        .args(&spawn_req.args)
        .envs(&spawn_req.env)
        .current_dir(if spawn_req.cwd.is_empty() { "/" } else { &spawn_req.cwd })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match result {
        Ok(child) => {
            eprintln!("[wasix-shim] Child {} spawned successfully", spawn_req.child_id);
            children.insert(spawn_req.child_id, ChildProcess {
                child,
                parent_session,
            });
        }
        Err(e) => {
            eprintln!("[wasix-shim] Failed to spawn child {}: {}", spawn_req.child_id, e);
            // Send exit code 127 (command not found)
            let exit_code: i32 = 127;
            let exit_data = exit_code.to_le_bytes();
            unsafe {
                host_exec_child_output(
                    parent_session,
                    spawn_req.child_id,
                    MSG_TYPE_CHILD_EXIT,
                    exit_data.as_ptr(),
                    exit_data.len(),
                );
            }
        }
    }
}
```

#### 3. Update `check_child_processes` to use `parent_session`

```rust
fn check_child_processes(
    children: &mut HashMap<u64, ChildProcess>,
    buf: &mut [u8],
) {
    let mut exited: Vec<(u64, i32)> = Vec::new();

    for (child_id, child_proc) in children.iter_mut() {
        // Read stdout
        if let Some(ref mut stdout) = child_proc.child.stdout {
            match stdout.read(buf) {
                Ok(0) => {}
                Ok(n) => {
                    unsafe {
                        host_exec_child_output(
                            child_proc.parent_session,  // Use stored parent_session
                            *child_id,
                            MSG_TYPE_CHILD_STDOUT,
                            buf.as_ptr(),
                            n,
                        );
                    }
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => {
                    eprintln!("[wasix-shim] Error reading child {} stdout: {}", child_id, e);
                }
            }
        }

        // Read stderr (similar)
        // ...

        // Check exit status
        match child_proc.child.try_wait() {
            Ok(Some(status)) => {
                let exit_code = status.code().unwrap_or(-1);
                exited.push((*child_id, exit_code));
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("[wasix-shim] Error checking child {} status: {}", child_id, e);
            }
        }
    }

    // Send exit notifications
    for (child_id, exit_code) in exited {
        let parent_session = children.get(&child_id).map(|c| c.parent_session).unwrap_or(0);
        children.remove(&child_id);
        let exit_data = exit_code.to_le_bytes();
        unsafe {
            host_exec_child_output(
                parent_session,
                child_id,
                MSG_TYPE_CHILD_EXIT,
                exit_data.as_ptr(),
                exit_data.len(),
            );
        }
    }
}
```

#### 4. Remove unnecessary code

- Remove `HostExecChild` struct
- Remove `host_exec_children` HashMap from `run_event_loop`
- Remove `handle_spawn_via_host_exec` function
- Remove `check_host_exec_children` function
- Remove `host_exec_children` parameter from `handle_spawn_request`

#### 5. Update function signatures

- `handle_spawn_request` no longer needs `host_exec_children` parameter
- `check_child_processes` no longer needs `session` parameter (uses stored parent_session)

### File: `src/vm/index.ts`

- Remove `handleShellCommand` function (no longer needed - children spawn in WASM)
- Simplify `hostExecHandler` to only handle "node" commands

## Testing

Run tests with:
```bash
pnpm exec vitest run tests/node-child-process.test.ts
```

### Notes on WASIX Command Availability

Commands are spawned natively in WASIX, which means they come from `sharrattj/coreutils`
(declared in `wasmer.toml`), NOT the host system.

**If tests fail due to missing commands:**
1. Check the logged PATH - may need to add `/bin` to spawn_req.env
2. Update tests to use only commands available in WASIX coreutils
3. Some commands like `true`, `false`, `printenv` may not exist - replace with alternatives

**Available commands to verify:**
- `echo` - likely available
- `ls` - likely available
- `true`, `false` - may not exist (use `bash -c "exit 0"` / `bash -c "exit 1"` instead)
- `printenv` - may not exist (use `bash -c "echo $VAR"` instead)

## Verification

After implementation, verify:
1. PATH is logged - check what's available
2. Add `/bin` to PATH if needed
3. Update tests for commands that don't exist in WASIX coreutils
4. No nested host_exec sessions are created (no `host_exec_start` calls for children)
