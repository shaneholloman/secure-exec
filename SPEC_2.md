# lightweight sandbox - phase 2

## overview

Phase 2 completes the missing pieces from SPEC.md to enable real npm packages like `ms` and `jsonfile` to work.

## 1. fs polyfill

Implement a `fs` module polyfill that routes through SystemBridge, enabling packages that read/write files.

```ts
// Inside isolated-vm, fs operations should route to SystemBridge
const fs = require("fs");
fs.writeFileSync("/test.json", '{"hello":"world"}');
const content = fs.readFileSync("/test.json", "utf8");
```

**Implementation approach:**

Use isolated-vm References to bridge fs calls to SystemBridge:

```ts
// In NodeProcess.setupRequire():
const fsReadRef = new ivm.Reference(async (path: string) => {
  return this.systemBridge.readFile(path);
});
const fsWriteRef = new ivm.Reference((path: string, content: string) => {
  this.systemBridge.writeFile(path, content);
});

// Pass refs into sandbox, fs polyfill calls them:
// fs.readFileSync = (path) => _fsRead.applySyncPromise(undefined, [path]);
```

**Methods to implement:**
- `readFileSync(path, encoding?)` - sync read via applySyncPromise
- `writeFileSync(path, data)` - sync write
- `existsSync(path)` - check existence
- `mkdirSync(path, options?)` - create directory
- `readdirSync(path)` - list directory
- `statSync(path)` - file stats (return mock stat object)
- `unlinkSync(path)` - delete file

Async versions can wrap the sync versions in Promise.resolve() for basic compatibility.

**Test:**
```ts
const proc = new NodeProcess({ systemBridge: bridge });
const result = await proc.run(`
  const fs = require("fs");
  fs.writeFileSync("/test.txt", "hello");
  module.exports = fs.readFileSync("/test.txt", "utf8");
`);
expect(result).toBe("hello");
```

## 2. dynamic CommonJS module resolution

Replace the simple single-file loader with proper CommonJS resolution that loads files on demand.

**Current limitation:**
```ts
// This fails because jsonfile requires graceful-fs, universalify, etc.
// The current loader only loads the entry file, not internal requires
const jsonfile = require("jsonfile");
```

**Implementation approach:**

Make `require()` resolve and load files dynamically, just like Node.js does:

```ts
// In the isolate's require() function:
globalThis.require = function require(request) {
  // Resolve the request to an absolute path
  const resolved = _resolveModule.applySyncPromise(undefined, [
    request,
    _currentModule.dirname  // context for relative imports
  ]);

  if (!resolved) {
    throw new Error('Cannot find module: ' + request);
  }

  // Check cache
  if (_moduleCache[resolved]) {
    return _moduleCache[resolved].exports;
  }

  // Load the file content
  const source = _loadFile.applySyncPromise(undefined, [resolved]);

  // Create module object
  const module = { exports: {}, filename: resolved, dirname: dirname(resolved) };
  _moduleCache[resolved] = module;

  // Track current module for nested requires
  const prevModule = _currentModule;
  _currentModule = module;

  // Wrap and execute
  const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
  wrapper(module.exports, require, module, resolved, dirname(resolved));

  _currentModule = prevModule;
  return module.exports;
};
```

**Host-side resolution (in NodeProcess):**

```ts
const resolveModuleRef = new ivm.Reference(
  async (request: string, fromDir: string): Promise<string | null> => {
    // 1. If starts with ./ or ../, resolve relative to fromDir
    if (request.startsWith('./') || request.startsWith('../')) {
      return resolveRelative(request, fromDir, bridge);
    }

    // 2. If it's a builtin (path, fs, etc.), return special marker
    if (isBuiltin(request)) {
      return `builtin:${request}`;
    }

    // 3. Otherwise, walk up node_modules
    return resolveNodeModules(request, fromDir, bridge);
  }
);

async function resolveRelative(request: string, fromDir: string, bridge: SystemBridge) {
  const candidates = [
    path.join(fromDir, request),
    path.join(fromDir, request + '.js'),
    path.join(fromDir, request + '.json'),
    path.join(fromDir, request, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (await bridge.exists(candidate)) return candidate;
  }
  return null;
}

async function resolveNodeModules(request: string, fromDir: string, bridge: SystemBridge) {
  // Handle subpath: "lodash/get" -> packageName="lodash", subpath="get"
  const [packageName, ...subpathParts] = request.split('/');
  const subpath = subpathParts.join('/');

  let dir = fromDir;
  while (dir !== '/') {
    const packageDir = path.join(dir, 'node_modules', packageName);
    const pkgJsonPath = path.join(packageDir, 'package.json');

    if (await bridge.exists(pkgJsonPath)) {
      if (subpath) {
        // Direct file reference: require("lodash/get")
        return resolveRelative('./' + subpath, packageDir, bridge);
      }
      // Main entry point
      const pkgJson = JSON.parse(await bridge.readFile(pkgJsonPath));
      const main = pkgJson.main || 'index.js';
      return path.join(packageDir, main);
    }

    dir = path.dirname(dir);
  }
  return null;
}
```

**Key features:**
- Relative imports (`./utils`, `../lib/foo`) resolve from current file
- Bare imports (`lodash`) walk up node_modules directories
- Subpath imports (`lodash/get`) work
- JSON files loaded and parsed automatically
- Module cache prevents re-execution
- Circular dependencies handled (partial exports visible)

**Test:**
```ts
// Load real ms package from host node_modules
const vm = new VirtualMachine();
await vm.loadFromHost("/path/to/project"); // has ms installed

const result = await vm.spawn("node", ["-e", `
  const ms = require("ms");
  console.log(ms("1h"));
`]);
expect(result.stdout).toContain("3600000");
```

## 3. use node-stdlib-browser for all polyfills

Replace the manual polyfill mapping with node-stdlib-browser's complete mapping.

**Current limitation:**
```ts
// polyfills.ts manually lists only 3 modules
const POLYFILL_SOURCES: Record<string, string> = {
  path: "path-browserify",
  events: "events",
  util: "util",
};
```

**Implementation:**

Just import the mapping from node-stdlib-browser:

```ts
import stdLibBrowser from "node-stdlib-browser";

// stdLibBrowser is already a complete mapping:
// {
//   assert: "/path/to/assert/index.js",
//   buffer: "/path/to/buffer/index.js",
//   crypto: "/path/to/crypto-browserify/index.js",
//   events: "/path/to/events/events.js",
//   fs: null,  // no polyfill available
//   path: "/path/to/path-browserify/index.js",
//   stream: "/path/to/stream-browserify/index.js",
//   ...etc
// }

export function hasPolyfill(name: string): boolean {
  return name in stdLibBrowser && stdLibBrowser[name] !== null;
}

export async function bundlePolyfill(name: string): Promise<string> {
  const entryPoint = stdLibBrowser[name];
  if (!entryPoint) throw new Error(`No polyfill for ${name}`);

  // Bundle with esbuild (already doing this)
  return esbuild.build({ entryPoints: [entryPoint], ... });
}
```

This gives us all Node.js builtins that have browser polyfills: assert, buffer, console, constants, crypto, domain, events, http, https, os, path, punycode, process, querystring, stream, string_decoder, sys, timers, tty, url, util, vm, zlib.

**Test:**
```ts
const result = await proc.run(`
  const { Buffer } = require("buffer");
  module.exports = Buffer.from("hello").toString("base64");
`);
expect(result).toBe("aGVsbG8=");
```

## 4. node shim .webc package

Build and include the node shim as a .webc package so bash can call `node` via IPC.

**Current state:**
- Falls back to `sharrattj/coreutils` which doesn't have node shim
- IPC polling code exists in WasixInstance but the WASM-side shim isn't bundled

**Implementation:**

The Rust shim source is in `scratch/wasmer-node-shim/`. Build process:

```bash
# Build the Rust shim to WASM
cd scratch/wasmer-node-shim
cargo build --target wasm32-wasmer-wasi --release

# Package as .webc with bash and coreutils
wasmer create-exe ... # or use wasmer package tooling
```

The shim does:
1. Receive args (e.g., `node -e "console.log(1)"`)
2. Write args to `/ipc/request.txt`
3. Poll for `/ipc/response.txt`
4. Read response (exit code + stdout)
5. Print stdout and exit with code

**Package structure (wasmer.toml):**
```toml
[package]
name = "node-shim"
version = "0.1.0"

[dependencies]
"sharrattj/bash" = "1.0"
"sharrattj/coreutils" = "1.0"

[[command]]
name = "node"
module = "node-shim.wasm"

[[command]]
name = "bash"
module = "sharrattj/bash:bash"
```

**Test:**
```ts
const vm = new VirtualMachine();
vm.writeFile("/script.js", 'console.log("from node")');

// This should work end-to-end via IPC
const result = await vm.spawn("bash", ["-c", "node /script.js"]);
expect(result.stdout).toContain("from node");
```

## steps

1. Implement fs polyfill with basic sync methods
2. Add buffer, stream, assert polyfills
3. Upgrade package bundler to use esbuild
4. Build and include node-shim.webc
5. Integration test with real packages (ms, jsonfile)

## success criteria

This should work:

```ts
const vm = new VirtualMachine();
await vm.loadFromHost("/path/to/project"); // has ms, jsonfile installed

vm.writeFile("/script.js", `
  const ms = require("ms");
  const jsonfile = require("jsonfile");

  console.log("1 hour in ms:", ms("1h"));
  jsonfile.writeFileSync("/test.json", { hello: "world" });
`);

const result = await vm.spawn("node", ["/script.js"]);
console.log(result.stdout); // "1 hour in ms: 3600000"

const json = await vm.readFile("/test.json");
console.log(JSON.parse(json)); // { hello: "world" }
```
