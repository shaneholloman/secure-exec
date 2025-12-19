# wasmer-js TTY Mode Stdin Bug

## Summary

When using `spawn()` (which uses wasmer-js TTY mode), stdin characters are echoed to stdout but are **NOT actually delivered** to the program's stdin. This means interactive programs like bash's `read` command receive empty input.

## Reproduction

```typescript
const proc = await runtime.spawn("bash", {
    args: ["-c", "read line; echo GOT:$line"],
});

await proc.writeStdin("hello\n");
await proc.closeStdin();

const result = await proc.wait();
console.log(result.stdout);
// Output: "hello\nGOT:\n"
// - "hello\n" is TTY echo
// - "GOT:\n" shows $line is EMPTY - input was not delivered
```

## Expected vs Actual

| | Expected | Actual |
|---|----------|--------|
| TTY echo | `hello\n` | `hello\n` ✓ |
| bash output | `GOT:hello\n` | `GOT:\n` ✗ |
| `$line` value | `"hello"` | `""` (empty) |

## Root Cause

In wasmer-js TTY mode:
1. Characters written to stdin are echoed to stdout (working)
2. But the characters are NOT passed through to the program's actual stdin (bug)
3. Even newlines don't act as line terminators for `read`
4. Only EOF causes `read` to return (with empty input)

## Workaround

Use `run()` with the `stdin` option instead of `spawn()`. This uses pipe mode instead of TTY mode:

```typescript
// This works correctly:
const vm = await runtime.run("bash", {
    args: ["-c", "read line; echo GOT:$line"],
    stdin: "hello\n",
});
console.log(vm.stdout); // "GOT:hello\n" ✓
```

## Impact

- **Streaming stdin via spawn()**: Only TTY echo works; program doesn't receive input
- **Batch stdin via run()**: Works correctly
- **Interactive terminal**: Input is echoed but not processed by commands

## Fix Required

This needs to be fixed in wasmer-js. The TTY implementation needs to deliver stdin characters to the program, not just echo them.

## Related

- FUTURE_WORK.md: "wasmer-js TTY mode stdin bug"
- Tests in `packages/nanosandbox/tests/vm.test.ts` are commented out pending fix
