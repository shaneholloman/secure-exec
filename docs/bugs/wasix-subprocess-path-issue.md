# WASIX Subprocess Spawning: PATH Resolution Issue

**Likely affected repo:** https://github.com/wasix-org/wasix-libc

## Problem

When spawning subprocesses in WASIX, PATH-based command resolution does not work. Commands like `posix_spawn("ls", ...)` fail even when:
- The binary exists in `/bin`
- `PATH=/bin` is explicitly set

## Proof

```
$ wasmer run --env PATH=/bin .
PATH = /bin
Using relative path: ls (will fail - PATH resolution doesn't work)
Calling posix_spawn directly for /bin/ls...

posix_spawn failed with error code: 45
Error: ENOEXEC (Exec format error / command not found) [WASIX]
```

With absolute path:
```
$ wasmer run --env PATH=/bin . -- --absolute
PATH = /bin
Using absolute path: /bin/ls
Calling posix_spawn directly for /bin/ls...

Spawned child process with PID: 2
[directory listing output...]
Exit code: 0
```

## Root Cause

**PATH resolution is a libc responsibility, not the kernel/runtime's.**

On native Linux:
1. **Kernel (`execve`)** - Requires an exact path. `execve("ls", ...)` fails because there's no `./ls`.
2. **libc (`execvp`, `posix_spawn`)** - The "p" variants search `$PATH`. They iterate through PATH directories trying `execve("/usr/bin/ls")`, `execve("/bin/ls")`, etc.
3. **Rust's `Command`** - Calls libc's `posix_spawn()` which handles PATH searching.

In WASIX:
1. **Wasmer runtime** - Provides the low-level `proc_spawn` syscall (equivalent to `execve`)
2. **wasix-libc** - Should implement `posix_spawn()` with PATH searching, but apparently doesn't

The bug is likely in **wasix-libc**, not the wasmer runtime. The `posix_spawn()` implementation in wasix-libc should search PATH before calling the `proc_spawn` syscall, just like glibc/musl do on native Linux.

## Workaround

**Use absolute paths for all subprocess commands.**

## Example: Direct libc Usage

```rust
use std::ffi::{c_void, CString};
use std::ptr;

// WASIX libc declarations - provided by wasix-libc
extern "C" {
    fn posix_spawn(
        pid: *mut i32,
        path: *const i8,
        file_actions: *const c_void,
        attrp: *const c_void,
        argv: *const *const i8,
        envp: *const *const i8,
    ) -> i32;

    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

fn main() {
    // Check PATH
    match std::env::var("PATH") {
        Ok(path) => println!("PATH = {}", path),
        Err(_) => println!("PATH is not set!"),
    }

    // MUST use absolute path - relative paths don't work
    let path = CString::new("/bin/ls").unwrap();

    let arg0 = CString::new("ls").unwrap();
    let arg1 = CString::new("-la").unwrap();
    let argv: [*const i8; 3] = [arg0.as_ptr(), arg1.as_ptr(), ptr::null()];
    let envp: [*const i8; 1] = [ptr::null()];

    let mut pid: i32 = 0;

    let result = unsafe {
        posix_spawn(&mut pid, path.as_ptr(), ptr::null(), ptr::null(),
                    argv.as_ptr(), envp.as_ptr())
    };

    if result != 0 {
        // WASIX error codes
        let err = match result {
            44 => "ENOENT",
            45 => "ENOEXEC (command not found)",
            _ => "Unknown",
        };
        eprintln!("posix_spawn failed: {} ({})", result, err);
        return;
    }

    println!("Spawned PID: {}", pid);

    let mut status: i32 = 0;
    unsafe { waitpid(pid, &mut status, 0) };

    let exit_code = (status >> 8) & 0xff;
    println!("Exit code: {}", exit_code);
}
```

## Example: Using std::process::Command

```rust
use std::process::Command;

fn main() {
    // This does NOT work - even with PATH set
    // let child = Command::new("ls").spawn();

    // This works - use absolute path
    let child = Command::new("/bin/ls")
        .arg("-l")
        .spawn()
        .expect("Failed to spawn");

    let result = child.wait_with_output().expect("Failed to wait");
    println!("stdout:\n{}", String::from_utf8_lossy(&result.stdout));
}
```

## Project Setup

### wasmer.toml

```toml
[package]
name = 'wasmer/wasix-spawn-example'
version = '0.1.0'
description = 'An example of using spawn in wasix'

[[module]]
name = 'wasix-spawn'
source = 'target/wasm32-wasmer-wasi/release/wasix-spawn.wasm'
abi = 'wasi'

[dependencies]
"sharrattj/coreutils" = "1"

[[command]]
name = 'wasix-spawn'
module = 'wasix-spawn'
```

### Build and Run

```bash
cargo wasix build --release
wasmer package build -o wasix-spawn.webc .
wasmer run .                              # fails (relative path)
wasmer run . -- --absolute                # works (absolute path)
wasmer run --env PATH=/bin .              # still fails!
wasmer run --env PATH=/bin . -- --absolute # works
```

## WASIX Error Codes

| Code | Name | Meaning |
|------|------|---------|
| 44 | ENOENT | No such file or directory |
| 45 | ENOEXEC | Exec format error / command not found |

## Environment

Tested with:
- wasmer 6.1.0
- cargo-wasix 0.1.26
- wasix toolchain 2025-11-07.1+rust-1.90

## References

- https://github.com/wasix-org/wasix-libc (likely where the bug is)
- https://wasix.org/docs/language-guide/rust/tutorials/wasix-spawn
- https://wasix.org/docs/api-reference/wasix/proc_spawn
- https://github.com/wasmerio/wasmer/issues
