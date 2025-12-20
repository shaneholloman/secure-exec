# Active Handles: Keeping the Sandbox Alive for Async Operations

## Problem

The sandboxed Node.js environment uses `isolated-vm` (V8 isolates) to run JavaScript code. Unlike real Node.js, isolated-vm does not have an event loop. Code runs synchronously and the sandbox exits immediately when the script finishes executing.

This causes problems with async APIs that use callbacks:

```javascript
const { spawn } = require('child_process');
const child = spawn('echo', ['hello']);

child.stdout.on('data', (data) => {
    console.log('output:', data.toString());  // Never fires!
});

child.on('close', (code) => {
    console.log('exit code:', code);  // Never fires!
});

// Script finishes here, sandbox exits immediately
// Child process runs but callbacks never fire
```

## Why This Happens

In real Node.js:
1. Script sets up event handlers
2. Script finishes synchronous execution
3. Event loop keeps running while there are "active handles" (child processes, timers, sockets)
4. Callbacks fire as events occur
5. Process exits when no more active handles remain

In isolated-vm:
1. Script sets up event handlers
2. Script finishes synchronous execution
3. `exec()` returns immediately - no event loop
4. V8 context is released
5. Callbacks can never fire

## Solution: Active Handle Tracking

We implement a simple handle tracking mechanism that mimics Node.js's ref counting:

```javascript
// Global state
const _activeHandles = new Map();  // id -> description
let _waitResolvers = [];

// Register a handle (keeps sandbox alive)
globalThis._registerHandle = function(id, description) {
    _activeHandles.set(id, description);
};

// Unregister a handle (allows sandbox to exit if no handles remain)
globalThis._unregisterHandle = function(id) {
    _activeHandles.delete(id);
    if (_activeHandles.size === 0) {
        _waitResolvers.forEach(r => r());
        _waitResolvers = [];
    }
};

// Wait for all handles to complete
globalThis._waitForActiveHandles = function() {
    if (_activeHandles.size === 0) return Promise.resolve();
    return new Promise(resolve => _waitResolvers.push(resolve));
};

// Debug: see what's still active
globalThis._getActiveHandles = function() {
    return Array.from(_activeHandles.entries());
};
```

The `exec()` method in sandboxed-node automatically awaits `_waitForActiveHandles()` after running user code:

```typescript
// Run user's script
await script.run(context);

// Wait for any async handles (child processes, etc.) to complete
await context.eval('_waitForActiveHandles()', { promise: true });
```

## Usage in Bridges

### Child Process

```javascript
// On spawn
const handleId = `child:${sessionId}`;
_registerHandle(handleId, `child_process: ${command} ${args.join(' ')}`);

// On exit
_unregisterHandle(handleId);
```

### Timers (if needed)

```javascript
// setTimeout
const handleId = `timer:${timerId}`;
_registerHandle(handleId, `setTimeout: ${delay}ms`);

// When timer fires or is cleared
_unregisterHandle(handleId);
```

## Debugging

If the sandbox seems to hang, you can check what handles are still active:

```javascript
console.log('Active handles:', _getActiveHandles());
```

This will show something like:
```
Active handles: [
    ['child:1', 'child_process: echo hello world'],
    ['child:2', 'child_process: ls -la']
]
```

## Comparison with Node.js

| Feature | Node.js | sandboxed-node |
|---------|---------|----------------|
| Event loop | Built-in libuv | None (isolated-vm) |
| Handle tracking | Automatic via libuv | Manual via `_registerHandle` |
| `ref()`/`unref()` | Per-handle methods | Not implemented (all handles keep alive) |
| Debugging | `process._getActiveHandles()` | `_getActiveHandles()` |

## Limitations

1. **No `unref()` support**: In Node.js, you can call `handle.unref()` to allow the process to exit even if the handle is active. We don't support this - all registered handles keep the sandbox alive.

2. **Manual registration**: Bridges must explicitly register/unregister handles. Forgetting to unregister will cause the sandbox to hang.

3. **No timeout**: If a handle never completes, the sandbox hangs forever. Consider adding a timeout in `exec()` if this becomes a problem.
