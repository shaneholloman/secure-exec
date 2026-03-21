# Custom Bindings

## Summary

Allow users to expose host-side functions to sandbox code via `SecureExec.bindings`. The host registers a nested object tree of functions; the sandbox receives them as a frozen namespace on the `SecureExec` global.

## Motivation

Users need to give sandbox code access to host capabilities beyond the built-in fs/network/process bridge — databases, caches, queues, AI models, custom APIs. Today there's no supported way to do this. Custom bindings close that gap with minimal surface area.

## Design principles

- The user owns the wrapper. We provide transport, not abstractions.
- Same serialization as all bridge calls (V8 structured clone). No special cases.
- No Rust changes. Bindings are additional entries in `bridgeHandlers`.
- Frozen and namespaced. User code cannot mutate or shadow bindings.

## Host API

```ts
const runtime = new NodeRuntime({
  systemDriver: createNodeDriver(),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  bindings: {
    db: {
      query: async (sql: string, params: unknown[]) => db.query(sql, params),
      insert: async (sql: string, values: unknown[]) => db.insert(sql, values),
    },
    cache: {
      get: async (key: string) => redis.get(key),
      set: async (key: string, val: unknown) => redis.set(key, val),
    },
    greet: (name: string) => `Hello, ${name}!`,
  },
});
```

### Type

```ts
type BindingFunction = (...args: unknown[]) => unknown | Promise<unknown>;

interface BindingTree {
  [key: string]: BindingFunction | BindingTree;
}

interface NodeRuntimeOptions {
  // ... existing fields ...
  bindings?: BindingTree;
}
```

### Constraints

- Binding keys must be valid JS identifiers (`/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`).
- Max nesting depth: 4 levels.
- Max leaf functions: 64 per runtime.
- Bindings are set at construction and immutable for the runtime's lifetime.
- Collisions with internal bridge names (anything starting with `_`) are rejected at registration time.

## Sandbox API

```js
// Flat calls
const rows = await SecureExec.bindings.db.query("SELECT * FROM users", []);
await SecureExec.bindings.cache.set("key", "value");

// Sync bindings work too
const msg = SecureExec.bindings.greet("world");

// Destructure for convenience
const { db, cache } = SecureExec.bindings;
const rows = await db.query("SELECT * FROM users", []);
```

### The `SecureExec` global

`globalThis.SecureExec` is a frozen object owned by the runtime. It follows the Deno/Bun convention of a PascalCase product-named global.

```js
SecureExec.bindings    // user-provided bindings (this spec)
SecureExec.version     // package version (future)
SecureExec.runtime     // runtime metadata (future)
```

- `SecureExec` is non-writable, non-configurable on `globalThis`.
- `SecureExec.bindings` is a recursively frozen object tree.
- Each leaf is a callable function that routes through the bridge.
- If no bindings are registered, `SecureExec.bindings` is an empty frozen object.
- `SecureExec` is always present, even with no bindings (stable API surface).

## Internal mechanics

### Flattening

At registration time, the nested `BindingTree` is walked and flattened into dot-separated keys:

```
{ db: { query: fn, insert: fn }, cache: { get: fn } }
  -> Map {
       "__bind.db.query"   => fn,
       "__bind.db.insert"  => fn,
       "__bind.cache.get"  => fn,
     }
```

The `__bind.` prefix separates user bindings from internal bridge names. These flattened entries are merged into `bridgeHandlers` before passing to `V8Session.execute()`.

### Rust side

No changes. The Rust side registers whatever function names appear in `bridgeHandlers`. New `__bind.*` names are registered as sync or async bridge functions automatically (async if the handler returns a Promise, sync otherwise).

Note: sync/async detection happens on the host TS side at registration time. The IPC message (`BridgeCall`) already carries the call mode. The Rust side dispatches to `sync_bridge_callback` or `async_bridge_callback` based on how the function was registered.

### Sandbox-side inflation

During bridge code composition, a small JS snippet is appended that:

1. Reads the list of `__bind.*` globals registered on `globalThis`.
2. Splits each key on `.` and builds a nested object tree.
3. Each leaf wraps the raw `__bind.*` global in a function call.
4. Freezes the tree recursively.
5. Sets `globalThis.SecureExec = Object.freeze({ bindings: tree })`.

Pseudocode for the inflation snippet (~15 lines):

```js
(function() {
  const tree = {};
  for (const key of __bindingKeys__) {
    const parts = key.split(".");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = globalThis["__bind." + key];
  }
  function deepFreeze(obj) {
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v !== null) deepFreeze(v);
    }
    return Object.freeze(obj);
  }
  globalThis.SecureExec = Object.freeze({ bindings: deepFreeze(tree) });
})();
```

The `__bindingKeys__` array is injected as a JSON literal during bridge code composition. The raw `__bind.*` globals are deleted from `globalThis` after inflation (the tree holds the only references).

## Serialization

Arguments and return values use the existing V8 ValueSerializer pipeline (structured clone). Supported types:

- Primitives (string, number, boolean, null, undefined)
- Plain objects and arrays
- Uint8Array / ArrayBuffer
- Date, Map, Set, RegExp
- Error objects
- Nested/circular references

Not supported (will throw):
- Functions (cannot cross the bridge)
- Symbols
- WeakMap / WeakSet
- DOM objects (not applicable)

Same payload size limits as all bridge calls (`ERR_SANDBOX_PAYLOAD_TOO_LARGE`).

## Implementation plan

### Phase 1: Core plumbing

1. Add `bindings?: BindingTree` to `NodeRuntimeOptions`.
2. Thread through `RuntimeDriverOptions` to `NodeExecutionDriver`.
3. In `NodeExecutionDriver`, flatten `BindingTree` to `Map<string, BridgeHandler>` with `__bind.` prefix.
4. Merge into `bridgeHandlers` in `executeInternal()`.
5. Validate: no key collisions with internal names, all keys are valid identifiers, depth <= 4, leaf count <= 64.

### Phase 2: Sandbox-side injection

6. In `composeStaticBridgeCode()` or `composePostRestoreScript()`, append the inflation snippet.
7. Pass binding keys list as a JSON literal injected into the snippet.
8. Delete raw `__bind.*` globals after inflation.
9. Ensure `SecureExec` global is present even with zero bindings.

### Phase 3: Tests

10. Test: host registers nested bindings, sandbox calls them, values round-trip correctly.
11. Test: sync and async bindings both work.
12. Test: `SecureExec.bindings` is frozen (cannot be mutated by sandbox code).
13. Test: binding key validation rejects invalid identifiers, depth > 4, > 64 leaves.
14. Test: binding name collision with internal bridge name is rejected.
15. Test: complex types (objects, arrays, Uint8Array, Date) serialize correctly through bindings.
16. Test: `SecureExec` global exists even with no bindings registered.
17. Test: raw `__bind.*` globals are not accessible after inflation.

## Estimated effort

- ~80-100 LOC TypeScript (flattening, validation, inflation snippet, threading)
- ~0 LOC Rust
- ~200 LOC tests
- No IPC protocol changes
- No bridge contract changes (bindings are dynamic, not hardcoded)

## Future extensions

- `SecureExec.version` — package version string
- `SecureExec.runtime` — runtime metadata (memoryLimit, timingMitigation, etc.)
- Per-execution binding overrides (different bindings per `exec()`/`run()` call)
- Binding middleware (logging, rate limiting, timeout per binding call)
- TypeScript type generation for sandbox-side bindings (from host registration)
