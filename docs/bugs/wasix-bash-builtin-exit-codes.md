# WASIX Bash Builtin Exit Code Bug

## Summary

When using `bash -c "command"` in WASIX, all **builtin commands** return exit code 45 (ENOEXEC) instead of their actual exit code. External commands work correctly.

## Affected

- Package: `sharrattj/bash` (wasmer registry)
- Affects: `bash -c` and `sh -c` with any builtin command
- Does NOT affect: External commands via PATH or absolute path

## Symptoms

```bash
# Builtins - ALL return exit code 45
bash -c "echo hello"      # stdout: hello, exit: 45 ✗
bash -c "true"            # exit: 45 ✗
bash -c "false"           # exit: 45 ✗
bash -c "exit 0"          # exit: 45 ✗
bash -c "exit 42"         # exit: 45 ✗
bash -c "pwd"             # stdout: /, exit: 45 ✗
bash -c "printf 'hi\n'"   # stdout: hi, exit: 45 ✗

# External commands - work correctly
bash -c "/bin/echo hello" # stdout: hello, exit: 0 ✓
bash -c "/bin/true"       # exit: 0 ✓
bash -c "/bin/false"      # exit: 1 ✓
bash -c "ls /"            # stdout: bin..., exit: 0 ✓
```

## Exit Code 45 Meaning

In WASIX errno definitions, 45 = `ENOEXEC` ("Executable file format error").

See: https://wasmerio.github.io/wasmer/crates/doc/wasmer_wasix_types/wasi/bindings/enum.Errno.html

## Root Cause

**Bug is in wasix-libc, not bash.**

WASIX libc's `posix_spawnp()` doesn't correctly search PATH. Per POSIX spec:
- `posix_spawn()` - requires explicit pathname, doesn't search PATH
- `posix_spawnp()` - SHOULD search PATH (like `execvp`)

See: https://man7.org/linux/man-pages/man3/posix_spawn.3.html

We already work around this in `wasix-runtime/src/main.rs` using the `which` crate to resolve commands to absolute paths before spawning.

When bash runs `-c "echo hello"`:
1. Bash tries to look up `echo` as external command via `posix_spawnp()`
2. `posix_spawnp()` fails with ENOEXEC (45) because it doesn't search PATH correctly
3. Bash falls back to the builtin `echo` and executes it (stdout works)
4. Bash incorrectly propagates the ENOEXEC (45) as the final exit code

This explains why:
- External commands with absolute paths work (no PATH search needed)
- `ls /` works (bash may find it differently, or it's in a default search location)
- All builtins fail with 45 (ENOEXEC from the failed `posix_spawnp()` call)

Note: Interactive bash (via stdin) works correctly - likely uses a different code path that doesn't attempt external command lookup first.

## Impact on nanosandbox

- `child_process.exec()` uses `spawn("bash", ["-c", command])` internally
- This means exec() always reports an error (code 45) even on successful commands
- The stdout/stderr are still correct
- Workaround: Use `spawn()` with external commands directly

## Workarounds

1. **Use spawn() with direct commands** (not bash -c):
   ```js
   spawn('echo', ['hello'])  // Works, exit code 0
   spawn('ls', ['/'])        // Works, exit code 0
   ```

2. **Use absolute paths in bash -c**:
   ```js
   spawn('bash', ['-c', '/bin/echo hello'])  // Works, exit code 0
   ```

3. **Accept incorrect exit codes** for exec() and only check stdout/stderr

## Test Files

- `tests/debug-builtins.test.ts` - Demonstrates the issue
- `tests/debug-path2.test.ts` - Shows absolute path workaround

## Status

- **Open** - Bug is in wasix-libc's `posix_spawnp()` PATH handling
- File issue at: https://github.com/wasix-org/wasix-libc/issues
