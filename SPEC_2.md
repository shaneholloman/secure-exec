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

**Why not use an existing fs polyfill?**

node-stdlib-browser returns `null` for fs and suggests libraries like memfs, BrowserFS, etc. But we already have a filesystem - the wasmer Directory wrapped by SystemBridge. We just need to bridge the `fs` API to it, not introduce another in-memory fs.

**Type safety:**

Use `@types/node` to ensure our implementation matches Node's fs API:

```bash
pnpm add -D @types/node
```

```ts
// src/node-process/fs/index.ts
import type {
  Stats as NodeStats,
  Dirent,
  PathLike,
  WriteFileOptions,
  // ... etc
} from "fs";

// Ensure our exports satisfy Node's types
export const readFileSync: typeof import("fs").readFileSync = ...
export const writeFileSync: typeof import("fs").writeFileSync = ...

// Or export an object that satisfies the fs module type
const fs: typeof import("fs") = { ... };
export = fs;
```

This catches type mismatches at compile time rather than runtime.

**File structure:**

```
src/node-process/fs/
  index.ts        # Main exports, wires bridge refs to fs API
  stats.ts        # Stats class implementing fs.Stats interface
  descriptor.ts   # FileDescriptor for tracking open files
  errors.ts       # ENOENT, EEXIST, etc. error helpers
  constants.ts    # fs.constants (O_RDONLY, S_IFREG, etc.)
```

**Classes to implement:**

```ts
// stats.ts - File/directory statistics
import type { Stats as NodeStats } from "fs";

class Stats implements NodeStats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  // ... all other required properties

  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;   // false
  isCharacterDevice(): boolean; // false
  isFIFO(): boolean;          // false
  isSocket(): boolean;        // false
}

// descriptor.ts - Open file handle
class FileDescriptor {
  private item: string;       // path
  private position: number;   // current read/write position
  private flags: number;      // O_RDONLY, O_WRONLY, etc.

  getPosition(): number;
  setPosition(pos: number): void;
  isRead(): boolean;
  isWrite(): boolean;
  isAppend(): boolean;
}

// errors.ts - Standard fs errors
function createError(code: string, path: string): Error;
// ENOENT - no such file or directory
// EEXIST - file already exists
// EISDIR - is a directory
// ENOTDIR - not a directory
// ENOTEMPTY - directory not empty
```

**Sync methods to implement (priority):**

```ts
// Read/write
readFileSync(path, options?): string | Buffer
writeFileSync(path, data, options?): void
appendFileSync(path, data, options?): void

// Directory
readdirSync(path, options?): string[] | Dirent[]
mkdirSync(path, options?): void
rmdirSync(path): void

// Stats/existence
existsSync(path): boolean
statSync(path): Stats
lstatSync(path): Stats

// Delete/rename
unlinkSync(path): void
renameSync(oldPath, newPath): void

// File descriptors (for packages that use them)
openSync(path, flags, mode?): number
closeSync(fd): void
readSync(fd, buffer, offset, length, position): number
writeSync(fd, buffer, offset, length, position): number
fstatSync(fd): Stats
```

**Async methods:**

Wrap sync methods in Promise.resolve() or use callbacks:

```ts
readFile(path, options?, callback?): void | Promise<Buffer>
writeFile(path, data, options?, callback?): void | Promise<void>
// ... etc
```

**Implementation approach:**

Use isolated-vm References to bridge fs calls to SystemBridge:

```ts
// In NodeProcess.setupRequire():
const fsRefs = {
  readFile: new ivm.Reference(async (path: string) => {
    return this.systemBridge.readFile(path);
  }),
  writeFile: new ivm.Reference((path: string, content: string) => {
    this.systemBridge.writeFile(path, content);
  }),
  stat: new ivm.Reference(async (path: string) => {
    // Return serializable stats object
    return this.systemBridge.stat(path);
  }),
  // ... etc
};

await jail.set('_fs', fsRefs);
```

Inside the isolate, fs/index.ts builds the fs API:

```ts
// Injected into isolate
const fs = {
  readFileSync(path, options) {
    const content = _fs.readFile.applySyncPromise(undefined, [path]);
    if (options?.encoding) return content;
    return Buffer.from(content);
  },
  writeFileSync(path, data) {
    _fs.writeFile.applySync(undefined, [path, data.toString()]);
  },
  // ... etc
};
```

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

**Test with file descriptors:**
```ts
const result = await proc.run(`
  const fs = require("fs");
  const fd = fs.openSync("/test.txt", "w");
  fs.writeSync(fd, "hello");
  fs.closeSync(fd);
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

## 4. wasix-runtime .webc package

Build and include the wasix-runtime as a .webc package containing bash, coreutils, and a node IPC bridge.

**Current state:**
- Falls back to `sharrattj/coreutils` if webc not found (should error instead)
- Code refers to "node-shim" (should be "wasix-runtime")
- IPC polling code exists in WasixInstance but the WASM-side bridge isn't bundled

**Code changes needed:**

Rename all references from "node-shim" to "wasix-runtime":
- `assets/node-shim.webc` → `assets/wasix-runtime.webc`
- `nodeShimPkg` variable → `wasixRuntime`
- Comments and error messages

Remove fallback behavior in WasixInstance.init():
```ts
// Before (falls back silently)
if (!nodeShimPkg) {
  console.warn("Warning: node-shim.webc not found, falling back...");
  nodeShimPkg = await Wasmer.fromRegistry("sharrattj/coreutils");
}

// After (error if missing)
if (!wasixRuntime) {
  throw new Error("wasix-runtime.webc not found at assets/wasix-runtime.webc");
}
```

**Implementation:**

Create the Rust node bridge at `/wasmer-node-shim/`. Build process:

```bash
# Build the node bridge to WASM
cd wasmer-node-shim
cargo build --target wasm32-wasmer-wasi --release

# Package as .webc with bash and coreutils
wasmer create-exe ... # or use wasmer package tooling
```

The node bridge does:
1. Receive args (e.g., `node -e "console.log(1)"`)
2. Write args to `/ipc/request.txt`
3. Poll for `/ipc/response.txt`
4. Read response (exit code + stdout)
5. Print stdout and exit with code

**Package structure (wasmer.toml):**
```toml
[package]
name = "wasix-runtime"
version = "0.1.0"

[dependencies]
"sharrattj/bash" = "1.0"
"sharrattj/coreutils" = "1.0"

[[command]]
name = "node"
module = "node-bridge.wasm"

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
