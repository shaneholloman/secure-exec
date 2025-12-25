# uutils pwd Panics on WASI Due to canonicalize()

## Summary

The `pwd` command from wasmer's coreutils package (which uses uutils, a Rust implementation) fails with "Operation not supported on this platform" when run in WASI/WASIX. This is caused by a panic in the `canonicalize()` function.

## Symptoms

```
$ wasmer run wasmer/coreutils --command-name pwd
pwd: failed to get current directory: Operation not supported on this platform
```

## Root Cause

The uutils `pwd` implementation has this code in `physical_path()`:

```rust
fn physical_path() -> io::Result<PathBuf> {
    let path = env::current_dir()?;

    #[cfg(unix)]
    {
        Ok(path)
    }

    #[cfg(not(unix))]
    {
        path.canonicalize()  // <-- This is the problem
    }
}
```

The issue is:

1. **WASI is NOT considered "unix"** by Rust's `cfg` attribute
2. The `#[cfg(not(unix))]` branch is taken, which calls `path.canonicalize()`
3. The `canonicalize()` implementation in uucore **panics** on WASI

## Evidence

### getcwd syscall works correctly

```
RUST_LOG=wasmer_wasix::syscalls=trace wasmer run wasmer/coreutils --command-name pwd
...
getcwd: return=Errno::success path="/" max_path_len=1024
...
pwd: failed to get current directory: Operation not supported on this platform
```

The WASIX `getcwd` syscall returns successfully with "/", but the error still occurs.

### pwd -L works, pwd -P fails

| Command | Result | Code Path |
|---------|--------|-----------|
| `pwd -L` | Works | `logical_path()` - just uses $PWD |
| `pwd` | Fails | `physical_path()` - uses canonicalize() |
| `pwd -P` | Fails | `physical_path()` - uses canonicalize() |

### realpath . panics

```
$ wasmer run wasmer/coreutils --command-name realpath -- .
thread 'main' panicked at /home/amin/Projects/coreutils/src/uucore/src/lib/features/fs.rs:192
```

This confirms that `canonicalize()` panics on WASI.

## Workaround in nanosandbox

In `wasix-runtime/src/main.rs`, we use bash built-in commands instead of coreutils binaries for certain commands:

```rust
// For commands with bash built-in equivalents (like pwd), use the command name
// instead of the full path. The bash built-in uses $PWD which works after cd,
// while the coreutils binary uses getcwd() which fails in WASIX subprocesses.
let bash_builtins = ["pwd", "cd", "echo", "test", "[", "true", "false", "read", "printf"];
let use_command_name = bash_builtins.contains(&spawn_req.command.as_str());

if use_command_name {
    script.push_str(&shell_escape(&spawn_req.command));
} else {
    script.push_str(&shell_escape(command_path.to_string_lossy().as_ref()));
}
```

This ensures that `pwd` uses bash's built-in which reads `$PWD` instead of calling `canonicalize()`.

## Proper Fix

The proper fix would be in uutils coreutils:

1. Add `target_os = "wasi"` to the `#[cfg(unix)]` condition, or
2. Add a WASI-specific code path that doesn't use `canonicalize()`

Example fix:
```rust
#[cfg(any(unix, target_os = "wasi"))]
{
    Ok(path)
}

#[cfg(not(any(unix, target_os = "wasi")))]
{
    path.canonicalize()
}
```

## Affected Components

- wasmer/coreutils package (version 1.0.19)
- uutils coreutils (version 0.0.7)
- Commands affected: `pwd`, `realpath`, and any command using `canonicalize()`

## Related Issues

- [WASI Issue #303: Supporting a "current directory"](https://github.com/WebAssembly/WASI/issues/303)
- [wasi-libc PR #214: Add basic emulation of getcwd/chdir](https://github.com/WebAssembly/wasi-libc/pull/214)

## Investigation Date

2024-12-24
