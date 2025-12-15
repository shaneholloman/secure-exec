# WebContainers Reimplementation Specification

A comprehensive technical specification for building a browser-based Node.js runtime environment from scratch.

---

## Table of Contents

1. [Overview](#overview)
2. [Part 1: Node.js Runtime (Service Workers & Polyfills)](#part-1-nodejs-runtime)
3. [Part 2: Linux Environment](#part-2-linux-environment)
4. [Part 3: NPM Compatibility](#part-3-npm-compatibility)

---

## Overview

### What WebContainers Are

WebContainers are a WebAssembly-based micro operating system that runs Node.js entirely within a browser tab. Key technologies involved:

- **WebAssembly (Wasm)**: Binary instruction format for running Node.js at near-native speed
- **Service Workers**: Intercept network requests, virtualize TCP networking
- **Web Workers**: Run code off the main thread for multithreading
- **SharedArrayBuffer**: Enable shared memory across workers (requires cross-origin isolation)
- **In-Memory File System**: Virtual filesystem stored in browser memory

### Required Browser Headers

```
Cross-Origin-Embedder-Policy: require-corp | credentialless
Cross-Origin-Opener-Policy: same-origin
```

These headers enable `crossOriginIsolated` mode, which is required for `SharedArrayBuffer`.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser Tab                               │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  Main Thread │◄──►│ Web Workers │◄──►│  Service Worker     │  │
│  │  (UI/API)    │    │ (Processes) │    │  (Network Stack)    │  │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘  │
│         │                  │                       │             │
│         ▼                  ▼                       ▼             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              SharedArrayBuffer (Shared Memory)              │ │
│  └────────────────────────────────────────────────────────────┘ │
│         │                  │                       │             │
│         ▼                  ▼                       ▼             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  Virtual FS  │    │ Node.js WASM│    │  TCP/HTTP Virtualize│  │
│  │  (memfs)     │    │  Runtime    │    │  (localhost proxy)  │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Node.js Runtime

### 1.1 Core Runtime Architecture

#### 1.1.1 WebAssembly-Based Node.js

The Node.js runtime must be compiled to WebAssembly. This involves:

```typescript
interface RuntimeConfig {
  // WASM binary of Node.js compiled with Emscripten/wasi-sdk
  wasmBinary: ArrayBuffer;
  
  // Shared memory for inter-worker communication
  sharedMemory: SharedArrayBuffer;
  
  // File system implementation
  fs: VirtualFileSystem;
  
  // Process environment
  env: Record<string, string>;
}
```

**Compilation Strategy:**
1. Use Emscripten or wasi-sdk to compile Node.js/V8 to WebAssembly
2. Target WASI (WebAssembly System Interface) for POSIX-like system calls
3. Implement custom syscall handlers that bridge to browser APIs

#### 1.1.2 Service Worker Network Stack

The Service Worker intercepts all network requests and routes them through the virtual TCP stack:

```typescript
// service-worker.ts
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  
  // Check if this is a request to a virtual server
  if (isVirtualServerRequest(url)) {
    event.respondWith(handleVirtualRequest(event.request));
  }
});

async function handleVirtualRequest(request: Request): Promise<Response> {
  // Route to internal TCP stack
  const port = extractPort(request.url);
  const virtualServer = getVirtualServer(port);
  
  if (virtualServer) {
    return virtualServer.handleRequest(request);
  }
  
  return new Response('Not Found', { status: 404 });
}
```

**Key Service Worker Responsibilities:**
- Intercept requests to `localhost:*` and virtual domains
- Route HTTP requests to in-browser Node.js servers
- Handle WebSocket connections
- Manage preview iframe communication
- Enable offline functionality

#### 1.1.3 TCP Virtualization Layer

```typescript
interface VirtualTCPStack {
  // Create a virtual server listening on a port
  listen(port: number, callback: (socket: VirtualSocket) => void): void;
  
  // Connect to a virtual server
  connect(port: number): Promise<VirtualSocket>;
  
  // Close a server
  close(port: number): void;
}

interface VirtualSocket {
  read(): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
  
  on(event: 'data' | 'close' | 'error', handler: Function): void;
}

class VirtualTCPImplementation implements VirtualTCPStack {
  private servers: Map<number, VirtualServer> = new Map();
  private messageChannel: BroadcastChannel;
  
  constructor() {
    // Use BroadcastChannel for cross-context communication
    this.messageChannel = new BroadcastChannel('virtual-tcp');
    this.messageChannel.onmessage = this.handleMessage.bind(this);
  }
  
  listen(port: number, callback: (socket: VirtualSocket) => void): void {
    const server = new VirtualServer(port, callback);
    this.servers.set(port, server);
    
    // Notify Service Worker about new server
    this.messageChannel.postMessage({
      type: 'server-start',
      port
    });
  }
  
  // ... implementation details
}
```

### 1.2 Node.js API Polyfills

#### 1.2.1 Core Module Polyfill Map

```typescript
const NODE_POLYFILLS = {
  // File system - custom implementation
  'fs': './polyfills/fs.ts',
  'fs/promises': './polyfills/fs-promises.ts',
  
  // Path utilities - use path-browserify
  'path': 'path-browserify',
  
  // Buffer - use buffer package
  'buffer': 'buffer/',
  
  // Process - custom implementation
  'process': './polyfills/process.ts',
  
  // Crypto - use crypto-browserify or WebCrypto
  'crypto': './polyfills/crypto.ts',
  
  // Streams - use readable-stream
  'stream': 'stream-browserify',
  '_stream_duplex': 'readable-stream/lib/_stream_duplex.js',
  '_stream_passthrough': 'readable-stream/lib/_stream_passthrough.js',
  '_stream_readable': 'readable-stream/lib/_stream_readable.js',
  '_stream_transform': 'readable-stream/lib/_stream_transform.js',
  '_stream_writable': 'readable-stream/lib/_stream_writable.js',
  
  // Events - use events package
  'events': 'events/',
  
  // HTTP/HTTPS - custom implementation over Service Worker
  'http': './polyfills/http.ts',
  'https': './polyfills/https.ts',
  
  // Net - custom TCP virtualization
  'net': './polyfills/net.ts',
  
  // URL utilities
  'url': 'url/',
  'querystring': 'querystring-es3',
  
  // Utilities
  'util': 'util/',
  'assert': 'assert/',
  'os': 'os-browserify/browser',
  'timers': 'timers-browserify',
  'tty': 'tty-browserify',
  'vm': 'vm-browserify',
  'zlib': 'browserify-zlib',
  'constants': 'constants-browserify',
  'domain': 'domain-browser',
  'punycode': 'punycode/',
  'string_decoder': 'string_decoder/',
  
  // Not supported - return empty/stub
  'child_process': './polyfills/child_process.ts',
  'cluster': './polyfills/stub.ts',
  'dgram': './polyfills/stub.ts',
  'dns': './polyfills/dns.ts',
  'readline': './polyfills/readline.ts',
  'repl': './polyfills/repl.ts',
  'tls': './polyfills/tls.ts',
};
```

#### 1.2.2 Process Polyfill Implementation

```typescript
// polyfills/process.ts
import { EventEmitter } from 'events';

class BrowserProcess extends EventEmitter {
  public argv: string[] = ['node'];
  public argv0: string = 'node';
  public env: Record<string, string> = {};
  public pid: number = 1;
  public ppid: number = 0;
  public platform: string = 'browser';
  public arch: string = 'wasm32';
  public version: string = 'v18.0.0';
  public versions: Record<string, string> = {
    node: '18.0.0',
    v8: '10.0.0',
    wasm: '1.0'
  };
  
  private _cwd: string = '/home/project';
  private _exitCode: number = 0;
  
  cwd(): string {
    return this._cwd;
  }
  
  chdir(directory: string): void {
    // Validate directory exists in virtual FS
    this._cwd = directory;
  }
  
  exit(code?: number): never {
    this._exitCode = code ?? 0;
    this.emit('exit', this._exitCode);
    throw new Error(`Process exited with code ${this._exitCode}`);
  }
  
  nextTick(callback: Function, ...args: any[]): void {
    queueMicrotask(() => callback(...args));
  }
  
  hrtime(time?: [number, number]): [number, number] {
    const now = performance.now();
    const seconds = Math.floor(now / 1000);
    const nanoseconds = Math.floor((now % 1000) * 1e6);
    
    if (time) {
      const diffSeconds = seconds - time[0];
      const diffNanos = nanoseconds - time[1];
      return [diffSeconds, diffNanos];
    }
    
    return [seconds, nanoseconds];
  }
  
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number } {
    const memory = (performance as any).memory;
    return {
      rss: memory?.totalJSHeapSize ?? 0,
      heapTotal: memory?.totalJSHeapSize ?? 0,
      heapUsed: memory?.usedJSHeapSize ?? 0,
      external: 0
    };
  }
  
  // stdin/stdout/stderr
  stdin = new ReadableStreamStub();
  stdout = new WritableStreamStub();
  stderr = new WritableStreamStub();
}

export const process = new BrowserProcess();
```

#### 1.2.3 HTTP Server Polyfill

```typescript
// polyfills/http.ts
import { EventEmitter } from 'events';
import { VirtualTCPStack } from '../tcp-stack';

export class Server extends EventEmitter {
  private port: number = 0;
  private tcpStack: VirtualTCPStack;
  
  constructor(requestListener?: (req: IncomingMessage, res: ServerResponse) => void) {
    super();
    this.tcpStack = getTCPStack();
    
    if (requestListener) {
      this.on('request', requestListener);
    }
  }
  
  listen(port: number, hostname?: string, callback?: () => void): this {
    this.port = port;
    
    // Register with virtual TCP stack
    this.tcpStack.listen(port, (socket) => {
      this.handleConnection(socket);
    });
    
    // Notify about server ready
    notifyServerReady(port, `http://localhost:${port}`);
    
    if (callback) {
      callback();
    }
    
    return this;
  }
  
  private async handleConnection(socket: VirtualSocket): Promise<void> {
    // Parse HTTP request from socket data
    const requestData = await socket.read();
    const { method, url, headers, body } = parseHTTPRequest(requestData);
    
    const req = new IncomingMessage(method, url, headers, body);
    const res = new ServerResponse(socket);
    
    this.emit('request', req, res);
  }
  
  close(callback?: () => void): this {
    this.tcpStack.close(this.port);
    if (callback) callback();
    return this;
  }
}

export function createServer(
  requestListener?: (req: IncomingMessage, res: ServerResponse) => void
): Server {
  return new Server(requestListener);
}
```

### 1.3 Worker-Based Process Model

#### 1.3.1 Process Isolation with Web Workers

```typescript
// worker-process.ts
interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: StdioOptions;
}

class WorkerProcess {
  private worker: Worker;
  private sharedMemory: SharedArrayBuffer;
  private messagePort: MessagePort;
  
  public readonly pid: number;
  public exitCode: number | null = null;
  
  public stdin: WritableStream<string>;
  public stdout: ReadableStream<string>;
  public stderr: ReadableStream<string>;
  
  constructor(options: ProcessOptions) {
    this.pid = generatePID();
    
    // Allocate shared memory for this process
    this.sharedMemory = new SharedArrayBuffer(1024 * 1024); // 1MB
    
    // Create worker with process script
    this.worker = new Worker('./process-worker.js', { type: 'module' });
    
    // Setup communication channel
    const channel = new MessageChannel();
    this.messagePort = channel.port1;
    
    // Initialize process
    this.worker.postMessage({
      type: 'init',
      options,
      sharedMemory: this.sharedMemory,
      port: channel.port2
    }, [channel.port2]);
    
    // Setup stdio streams
    this.setupStdio();
  }
  
  private setupStdio(): void {
    // stdin - writable stream that sends to worker
    this.stdin = new WritableStream({
      write: (chunk) => {
        this.messagePort.postMessage({ type: 'stdin', data: chunk });
      }
    });
    
    // stdout/stderr - readable streams from worker messages
    const stdoutController = { controller: null as ReadableStreamDefaultController<string> | null };
    const stderrController = { controller: null as ReadableStreamDefaultController<string> | null };
    
    this.stdout = new ReadableStream({
      start: (controller) => { stdoutController.controller = controller; }
    });
    
    this.stderr = new ReadableStream({
      start: (controller) => { stderrController.controller = controller; }
    });
    
    this.messagePort.onmessage = (event) => {
      const { type, data } = event.data;
      switch (type) {
        case 'stdout':
          stdoutController.controller?.enqueue(data);
          break;
        case 'stderr':
          stderrController.controller?.enqueue(data);
          break;
        case 'exit':
          this.exitCode = data;
          stdoutController.controller?.close();
          stderrController.controller?.close();
          break;
      }
    };
  }
  
  async waitForExit(): Promise<number> {
    return new Promise((resolve) => {
      if (this.exitCode !== null) {
        resolve(this.exitCode);
        return;
      }
      
      const checkExit = setInterval(() => {
        if (this.exitCode !== null) {
          clearInterval(checkExit);
          resolve(this.exitCode);
        }
      }, 10);
    });
  }
  
  kill(signal?: string): void {
    this.worker.terminate();
    this.exitCode = 1;
  }
}
```

#### 1.3.2 Process Worker Script

```typescript
// process-worker.ts (runs inside Web Worker)
import { VirtualFS } from './virtual-fs';
import { NodeRuntime } from './node-runtime';

let fs: VirtualFS;
let runtime: NodeRuntime;
let messagePort: MessagePort;

self.onmessage = async (event) => {
  const { type, options, sharedMemory, port } = event.data;
  
  if (type === 'init') {
    messagePort = port;
    
    // Initialize virtual FS with shared memory
    fs = new VirtualFS(sharedMemory);
    
    // Initialize Node runtime
    runtime = new NodeRuntime({
      fs,
      cwd: options.cwd,
      env: options.env
    });
    
    // Setup stdio
    runtime.stdout.on('data', (data: string) => {
      messagePort.postMessage({ type: 'stdout', data });
    });
    
    runtime.stderr.on('data', (data: string) => {
      messagePort.postMessage({ type: 'stderr', data });
    });
    
    // Handle stdin
    messagePort.onmessage = (e) => {
      if (e.data.type === 'stdin') {
        runtime.stdin.write(e.data.data);
      }
    };
    
    // Execute command
    try {
      const exitCode = await runtime.execute(options.command, options.args);
      messagePort.postMessage({ type: 'exit', data: exitCode });
    } catch (error) {
      messagePort.postMessage({ type: 'stderr', data: String(error) });
      messagePort.postMessage({ type: 'exit', data: 1 });
    }
  }
};
```

### 1.4 Globals and Module Resolution

#### 1.4.1 Global Injection

```typescript
// globals.ts
import { Buffer } from 'buffer';
import { process } from './polyfills/process';

declare global {
  var Buffer: typeof Buffer;
  var process: typeof process;
  var global: typeof globalThis;
  var __dirname: string;
  var __filename: string;
}

export function injectGlobals(context: any): void {
  context.Buffer = Buffer;
  context.process = process;
  context.global = context;
  context.globalThis = context;
  
  // These are set per-module
  context.__dirname = '/';
  context.__filename = '/index.js';
  
  // Node.js specific globals
  context.setImmediate = (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args);
  context.clearImmediate = clearTimeout;
  
  // Console with proper stream binding
  context.console = createConsole(process.stdout, process.stderr);
}
```

#### 1.4.2 Module System (CommonJS)

```typescript
// module-system.ts
class ModuleSystem {
  private cache: Map<string, Module> = new Map();
  private fs: VirtualFS;
  
  constructor(fs: VirtualFS) {
    this.fs = fs;
  }
  
  require(modulePath: string, parentModule?: Module): any {
    // 1. Resolve the module path
    const resolvedPath = this.resolve(modulePath, parentModule);
    
    // 2. Check cache
    if (this.cache.has(resolvedPath)) {
      return this.cache.get(resolvedPath)!.exports;
    }
    
    // 3. Check for built-in modules
    if (this.isBuiltin(modulePath)) {
      return this.loadBuiltin(modulePath);
    }
    
    // 4. Load and execute module
    const module = this.loadModule(resolvedPath, parentModule);
    this.cache.set(resolvedPath, module);
    
    return module.exports;
  }
  
  private resolve(modulePath: string, parent?: Module): string {
    // Handle relative paths
    if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
      const basePath = parent ? path.dirname(parent.filename) : '/';
      return this.resolveFile(path.resolve(basePath, modulePath));
    }
    
    // Handle absolute paths
    if (modulePath.startsWith('/')) {
      return this.resolveFile(modulePath);
    }
    
    // Handle node_modules
    return this.resolveNodeModules(modulePath, parent);
  }
  
  private resolveFile(filePath: string): string {
    // Try exact path
    if (this.fs.existsSync(filePath) && this.fs.statSync(filePath).isFile()) {
      return filePath;
    }
    
    // Try with extensions
    const extensions = ['.js', '.json', '.node', '.mjs', '.cjs'];
    for (const ext of extensions) {
      const withExt = filePath + ext;
      if (this.fs.existsSync(withExt)) {
        return withExt;
      }
    }
    
    // Try as directory (index.js)
    const indexPath = path.join(filePath, 'index.js');
    if (this.fs.existsSync(indexPath)) {
      return indexPath;
    }
    
    // Try package.json main field
    const pkgPath = path.join(filePath, 'package.json');
    if (this.fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(this.fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.main) {
        return this.resolveFile(path.join(filePath, pkg.main));
      }
    }
    
    throw new Error(`Cannot find module '${filePath}'`);
  }
  
  private loadModule(filePath: string, parent?: Module): Module {
    const code = this.fs.readFileSync(filePath, 'utf-8');
    const module = new Module(filePath, parent);
    
    // Wrap code in function
    const wrapper = `
      (function(exports, require, module, __filename, __dirname) {
        ${code}
      })
    `;
    
    const compiledWrapper = eval(wrapper);
    const require = (path: string) => this.require(path, module);
    require.resolve = (path: string) => this.resolve(path, module);
    require.cache = Object.fromEntries(this.cache);
    
    compiledWrapper(
      module.exports,
      require,
      module,
      filePath,
      path.dirname(filePath)
    );
    
    return module;
  }
}
```

---

## Part 2: Linux Environment

### 2.1 Virtual File System

#### 2.1.1 FileSystemTree Interface

```typescript
// Types matching WebContainer API
interface FileSystemTree {
  [name: string]: FileNode | DirectoryNode | SymlinkNode;
}

interface FileNode {
  file: {
    contents: string | Uint8Array;
  };
}

interface DirectoryNode {
  directory: FileSystemTree;
}

interface SymlinkNode {
  file: {
    symlink: string;
  };
}
```

#### 2.1.2 In-Memory File System Implementation

```typescript
// virtual-fs.ts
import { EventEmitter } from 'events';

interface INode {
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  uid: number;
  gid: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
}

interface FileINode extends INode {
  type: 'file';
  data: Uint8Array;
}

interface DirectoryINode extends INode {
  type: 'directory';
  entries: Map<string, number>; // name -> inode number
}

interface SymlinkINode extends INode {
  type: 'symlink';
  target: string;
}

type AnyINode = FileINode | DirectoryINode | SymlinkINode;

class VirtualFileSystem extends EventEmitter {
  private inodes: Map<number, AnyINode> = new Map();
  private nextINode: number = 1;
  private rootINode: number;
  private workdir: string = '/home/project';
  
  // File descriptor table
  private fdTable: Map<number, FileDescriptor> = new Map();
  private nextFd: number = 3; // 0=stdin, 1=stdout, 2=stderr
  
  constructor() {
    super();
    
    // Create root directory
    this.rootINode = this.createINode({
      type: 'directory',
      mode: 0o755,
      uid: 0,
      gid: 0,
      atime: new Date(),
      mtime: new Date(),
      ctime: new Date(),
      entries: new Map()
    });
    
    // Setup standard directories
    this.mkdirSync('/home', { recursive: true });
    this.mkdirSync('/home/project', { recursive: true });
    this.mkdirSync('/tmp', { recursive: true });
    this.mkdirSync('/bin', { recursive: true });
    this.mkdirSync('/usr', { recursive: true });
    this.mkdirSync('/usr/bin', { recursive: true });
  }
  
  private createINode(inode: AnyINode): number {
    const num = this.nextINode++;
    this.inodes.set(num, inode);
    return num;
  }
  
  private resolvePathToINode(path: string, followSymlinks: boolean = true): number {
    const parts = this.normalizePath(path).split('/').filter(Boolean);
    let current = this.rootINode;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const inode = this.inodes.get(current);
      
      if (!inode || inode.type !== 'directory') {
        throw new Error(`ENOTDIR: not a directory, '${path}'`);
      }
      
      const entryINode = inode.entries.get(part);
      if (entryINode === undefined) {
        throw new Error(`ENOENT: no such file or directory, '${path}'`);
      }
      
      const entry = this.inodes.get(entryINode);
      if (!entry) {
        throw new Error(`ENOENT: no such file or directory, '${path}'`);
      }
      
      // Handle symlinks
      if (entry.type === 'symlink' && followSymlinks) {
        const target = this.resolveSymlink(entry.target, parts.slice(0, i).join('/'));
        current = this.resolvePathToINode(target, true);
      } else {
        current = entryINode;
      }
    }
    
    return current;
  }
  
  private normalizePath(p: string): string {
    if (!p.startsWith('/')) {
      p = path.join(this.workdir, p);
    }
    return path.normalize(p);
  }
  
  // --- Public API (Node.js fs compatible) ---
  
  readFileSync(filePath: string, encoding?: BufferEncoding): string | Uint8Array {
    const inodeNum = this.resolvePathToINode(filePath);
    const inode = this.inodes.get(inodeNum);
    
    if (!inode || inode.type !== 'file') {
      throw new Error(`EISDIR: illegal operation on a directory, read`);
    }
    
    if (encoding) {
      return new TextDecoder(encoding).decode(inode.data);
    }
    
    return inode.data;
  }
  
  writeFileSync(filePath: string, data: string | Uint8Array, options?: WriteFileOptions): void {
    const normalizedPath = this.normalizePath(filePath);
    const dirname = path.dirname(normalizedPath);
    const basename = path.basename(normalizedPath);
    
    // Ensure parent directory exists
    let parentINode: number;
    try {
      parentINode = this.resolvePathToINode(dirname);
    } catch {
      throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
    }
    
    const parent = this.inodes.get(parentINode) as DirectoryINode;
    
    // Convert data to Uint8Array
    const bytes = typeof data === 'string' 
      ? new TextEncoder().encode(data)
      : data;
    
    // Check if file exists
    const existingINode = parent.entries.get(basename);
    if (existingINode !== undefined) {
      const existing = this.inodes.get(existingINode);
      if (existing?.type === 'file') {
        existing.data = bytes;
        existing.mtime = new Date();
        this.emit('change', normalizedPath);
        return;
      }
      throw new Error(`EISDIR: illegal operation on a directory`);
    }
    
    // Create new file
    const newINode = this.createINode({
      type: 'file',
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      atime: new Date(),
      mtime: new Date(),
      ctime: new Date(),
      data: bytes
    });
    
    parent.entries.set(basename, newINode);
    this.emit('rename', normalizedPath);
  }
  
  mkdirSync(dirPath: string, options?: { recursive?: boolean; mode?: number }): void {
    const normalizedPath = this.normalizePath(dirPath);
    const parts = normalizedPath.split('/').filter(Boolean);
    
    let current = this.rootINode;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const currentINode = this.inodes.get(current) as DirectoryINode;
      
      const existingEntry = currentINode.entries.get(part);
      
      if (existingEntry !== undefined) {
        const existing = this.inodes.get(existingEntry);
        if (existing?.type === 'directory') {
          current = existingEntry;
          continue;
        }
        throw new Error(`EEXIST: file already exists, '${dirPath}'`);
      }
      
      if (!options?.recursive && i < parts.length - 1) {
        throw new Error(`ENOENT: no such file or directory, '${dirPath}'`);
      }
      
      // Create directory
      const newINode = this.createINode({
        type: 'directory',
        mode: options?.mode ?? 0o755,
        uid: 1000,
        gid: 1000,
        atime: new Date(),
        mtime: new Date(),
        ctime: new Date(),
        entries: new Map()
      });
      
      currentINode.entries.set(part, newINode);
      current = newINode;
    }
  }
  
  readdirSync(dirPath: string, options?: { withFileTypes?: boolean }): string[] | DirEnt[] {
    const inodeNum = this.resolvePathToINode(dirPath);
    const inode = this.inodes.get(inodeNum);
    
    if (!inode || inode.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory, '${dirPath}'`);
    }
    
    const entries = Array.from(inode.entries.keys());
    
    if (options?.withFileTypes) {
      return entries.map(name => {
        const entryINode = inode.entries.get(name)!;
        const entry = this.inodes.get(entryINode)!;
        return {
          name,
          isFile: () => entry.type === 'file',
          isDirectory: () => entry.type === 'directory',
          isSymbolicLink: () => entry.type === 'symlink'
        };
      });
    }
    
    return entries;
  }
  
  statSync(filePath: string): Stats {
    const inodeNum = this.resolvePathToINode(filePath);
    const inode = this.inodes.get(inodeNum)!;
    
    return new Stats(inode);
  }
  
  existsSync(filePath: string): boolean {
    try {
      this.resolvePathToINode(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  unlinkSync(filePath: string): void {
    const normalizedPath = this.normalizePath(filePath);
    const dirname = path.dirname(normalizedPath);
    const basename = path.basename(normalizedPath);
    
    const parentINode = this.resolvePathToINode(dirname);
    const parent = this.inodes.get(parentINode) as DirectoryINode;
    
    const entryINode = parent.entries.get(basename);
    if (entryINode === undefined) {
      throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
    }
    
    const entry = this.inodes.get(entryINode);
    if (entry?.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory`);
    }
    
    parent.entries.delete(basename);
    this.inodes.delete(entryINode);
    this.emit('rename', normalizedPath);
  }
  
  rmdirSync(dirPath: string, options?: { recursive?: boolean }): void {
    const inodeNum = this.resolvePathToINode(dirPath);
    const inode = this.inodes.get(inodeNum);
    
    if (!inode || inode.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory, '${dirPath}'`);
    }
    
    if (inode.entries.size > 0 && !options?.recursive) {
      throw new Error(`ENOTEMPTY: directory not empty, '${dirPath}'`);
    }
    
    if (options?.recursive) {
      // Recursively delete contents
      for (const [name, entryINode] of inode.entries) {
        const entry = this.inodes.get(entryINode);
        if (entry?.type === 'directory') {
          this.rmdirSync(path.join(dirPath, name), { recursive: true });
        } else {
          this.unlinkSync(path.join(dirPath, name));
        }
      }
    }
    
    // Remove directory
    const normalizedPath = this.normalizePath(dirPath);
    const dirname = path.dirname(normalizedPath);
    const basename = path.basename(normalizedPath);
    
    const parentINode = this.resolvePathToINode(dirname);
    const parent = this.inodes.get(parentINode) as DirectoryINode;
    
    parent.entries.delete(basename);
    this.inodes.delete(inodeNum);
  }
  
  symlinkSync(target: string, linkPath: string): void {
    const normalizedPath = this.normalizePath(linkPath);
    const dirname = path.dirname(normalizedPath);
    const basename = path.basename(normalizedPath);
    
    const parentINode = this.resolvePathToINode(dirname);
    const parent = this.inodes.get(parentINode) as DirectoryINode;
    
    if (parent.entries.has(basename)) {
      throw new Error(`EEXIST: file already exists, '${linkPath}'`);
    }
    
    const newINode = this.createINode({
      type: 'symlink',
      mode: 0o777,
      uid: 1000,
      gid: 1000,
      atime: new Date(),
      mtime: new Date(),
      ctime: new Date(),
      target
    });
    
    parent.entries.set(basename, newINode);
  }
  
  // Watch API
  watch(
    filename: string,
    options: { recursive?: boolean } | undefined,
    listener: (event: 'rename' | 'change', filename: string) => void
  ): FSWatcher {
    const normalizedPath = this.normalizePath(filename);
    
    const handleEvent = (event: 'rename' | 'change', changedPath: string) => {
      if (changedPath === normalizedPath || 
          (options?.recursive && changedPath.startsWith(normalizedPath + '/'))) {
        listener(event, changedPath);
      }
    };
    
    this.on('rename', (p) => handleEvent('rename', p));
    this.on('change', (p) => handleEvent('change', p));
    
    return {
      close: () => {
        this.off('rename', handleEvent);
        this.off('change', handleEvent);
      }
    };
  }
  
  // Mount FileSystemTree
  mount(tree: FileSystemTree, mountPoint: string = '/'): void {
    const mount = (subtree: FileSystemTree, basePath: string) => {
      for (const [name, node] of Object.entries(subtree)) {
        const fullPath = path.join(basePath, name);
        
        if ('file' in node) {
          if ('contents' in node.file) {
            // Regular file
            this.writeFileSync(fullPath, node.file.contents);
          } else if ('symlink' in node.file) {
            // Symlink
            this.symlinkSync(node.file.symlink, fullPath);
          }
        } else if ('directory' in node) {
          this.mkdirSync(fullPath, { recursive: true });
          mount(node.directory, fullPath);
        }
      }
    };
    
    mount(tree, mountPoint);
  }
  
  // Export FileSystemTree
  export(exportPath: string = '/'): FileSystemTree {
    const exportDir = (dirPath: string): FileSystemTree => {
      const result: FileSystemTree = {};
      const entries = this.readdirSync(dirPath, { withFileTypes: true }) as DirEnt[];
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          result[entry.name] = {
            directory: exportDir(fullPath)
          };
        } else if (entry.isSymbolicLink()) {
          const target = this.readlinkSync(fullPath);
          result[entry.name] = {
            file: { symlink: target }
          };
        } else {
          const contents = this.readFileSync(fullPath);
          result[entry.name] = {
            file: { contents }
          };
        }
      }
      
      return result;
    };
    
    return exportDir(exportPath);
  }
}
```

### 2.2 Process Management

#### 2.2.1 Process Table

```typescript
// process-table.ts
interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  status: 'running' | 'stopped' | 'zombie';
  exitCode: number | null;
  worker: Worker | null;
  startTime: Date;
}

class ProcessTable {
  private processes: Map<number, ProcessEntry> = new Map();
  private nextPid: number = 1;
  
  // PID 1 is init
  constructor() {
    this.processes.set(1, {
      pid: 1,
      ppid: 0,
      command: 'init',
      args: [],
      cwd: '/',
      env: {},
      status: 'running',
      exitCode: null,
      worker: null,
      startTime: new Date()
    });
  }
  
  allocatePid(): number {
    return this.nextPid++;
  }
  
  createProcess(options: Omit<ProcessEntry, 'pid' | 'status' | 'exitCode' | 'startTime'>): ProcessEntry {
    const pid = this.allocatePid();
    const entry: ProcessEntry = {
      ...options,
      pid,
      status: 'running',
      exitCode: null,
      startTime: new Date()
    };
    
    this.processes.set(pid, entry);
    return entry;
  }
  
  getProcess(pid: number): ProcessEntry | undefined {
    return this.processes.get(pid);
  }
  
  terminateProcess(pid: number, exitCode: number): void {
    const process = this.processes.get(pid);
    if (process) {
      process.status = 'zombie';
      process.exitCode = exitCode;
      process.worker?.terminate();
    }
  }
  
  reapProcess(pid: number): void {
    this.processes.delete(pid);
  }
  
  listProcesses(): ProcessEntry[] {
    return Array.from(this.processes.values());
  }
}
```

#### 2.2.2 Spawn Implementation

```typescript
// spawn.ts
interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  output?: boolean;
  terminal?: { cols: number; rows: number };
}

interface WebContainerProcess {
  exit: Promise<number>;
  input: WritableStream<string>;
  output: ReadableStream<string>;
  kill(): void;
  resize(dimensions: { cols: number; rows: number }): void;
}

class ProcessSpawner {
  private fs: VirtualFileSystem;
  private processTable: ProcessTable;
  private defaultEnv: Record<string, string>;
  
  constructor(fs: VirtualFileSystem, processTable: ProcessTable) {
    this.fs = fs;
    this.processTable = processTable;
    this.defaultEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/project',
      USER: 'user',
      SHELL: '/bin/sh',
      TERM: 'xterm-256color'
    };
  }
  
  async spawn(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<WebContainerProcess> {
    const cwd = options.cwd ?? this.fs.workdir;
    const env = { ...this.defaultEnv, ...options.env };
    
    // Resolve command path
    const commandPath = this.resolveCommand(command);
    
    // Create process entry
    const processEntry = this.processTable.createProcess({
      ppid: 1,
      command,
      args,
      cwd,
      env,
      worker: null
    });
    
    // Create worker for process
    const worker = new Worker('./process-runtime.js', { type: 'module' });
    processEntry.worker = worker;
    
    // Setup communication
    const { port1, port2 } = new MessageChannel();
    
    // Streams
    let inputController: WritableStreamDefaultController<string>;
    let outputController: ReadableStreamDefaultController<string>;
    
    const input = new WritableStream<string>({
      start(controller) {
        inputController = controller;
      },
      write(chunk) {
        port1.postMessage({ type: 'stdin', data: chunk });
      }
    });
    
    const output = new ReadableStream<string>({
      start(controller) {
        outputController = controller;
      }
    });
    
    // Exit promise
    const exit = new Promise<number>((resolve) => {
      port1.onmessage = (event) => {
        const { type, data } = event.data;
        
        switch (type) {
          case 'stdout':
          case 'stderr':
            if (options.output !== false) {
              outputController.enqueue(data);
            }
            break;
          case 'exit':
            this.processTable.terminateProcess(processEntry.pid, data);
            outputController.close();
            resolve(data);
            break;
        }
      };
    });
    
    // Initialize worker
    worker.postMessage({
      type: 'spawn',
      command: commandPath,
      args,
      cwd,
      env,
      terminal: options.terminal,
      port: port2
    }, [port2]);
    
    return {
      exit,
      input,
      output,
      kill: () => {
        worker.terminate();
        this.processTable.terminateProcess(processEntry.pid, 1);
      },
      resize: (dimensions) => {
        port1.postMessage({ type: 'resize', ...dimensions });
      }
    };
  }
  
  private resolveCommand(command: string): string {
    // Check if it's an absolute path
    if (command.startsWith('/')) {
      if (this.fs.existsSync(command)) {
        return command;
      }
      throw new Error(`Command not found: ${command}`);
    }
    
    // Search in PATH
    const pathDirs = this.defaultEnv.PATH.split(':');
    for (const dir of pathDirs) {
      const fullPath = path.join(dir, command);
      if (this.fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    
    // Built-in commands
    const builtins = ['node', 'npm', 'npx', 'yarn', 'pnpm', 'ls', 'cat', 'mkdir', 'rm', 'cp', 'mv', 'echo', 'pwd', 'cd'];
    if (builtins.includes(command)) {
      return `builtin:${command}`;
    }
    
    throw new Error(`Command not found: ${command}`);
  }
}
```

### 2.3 Shell Environment

#### 2.3.1 Basic Shell Implementation

```typescript
// shell.ts
class Shell {
  private fs: VirtualFileSystem;
  private spawner: ProcessSpawner;
  private env: Record<string, string>;
  private cwd: string;
  private history: string[] = [];
  
  constructor(fs: VirtualFileSystem, spawner: ProcessSpawner) {
    this.fs = fs;
    this.spawner = spawner;
    this.cwd = '/home/project';
    this.env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/project',
      PWD: this.cwd,
      OLDPWD: this.cwd
    };
  }
  
  async execute(input: string): Promise<{ output: string; exitCode: number }> {
    const trimmed = input.trim();
    if (!trimmed) return { output: '', exitCode: 0 };
    
    this.history.push(trimmed);
    
    // Parse command
    const parsed = this.parse(trimmed);
    
    // Handle built-in shell commands
    const builtin = this.handleBuiltin(parsed);
    if (builtin !== null) {
      return builtin;
    }
    
    // Spawn external command
    try {
      const process = await this.spawner.spawn(
        parsed.command,
        parsed.args,
        {
          cwd: this.cwd,
          env: { ...this.env, ...parsed.env }
        }
      );
      
      let output = '';
      const reader = process.output.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += value;
      }
      
      const exitCode = await process.exit;
      return { output, exitCode };
    } catch (error) {
      return { output: `${error}\n`, exitCode: 127 };
    }
  }
  
  private parse(input: string): ParsedCommand {
    // Simple parser - handles basic cases
    const tokens = this.tokenize(input);
    const env: Record<string, string> = {};
    let i = 0;
    
    // Parse environment variables (VAR=value command)
    while (i < tokens.length && tokens[i].includes('=')) {
      const [key, value] = tokens[i].split('=');
      env[key] = value;
      i++;
    }
    
    const command = tokens[i] || '';
    const args = tokens.slice(i + 1);
    
    return { command, args, env };
  }
  
  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      
      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (char === ' ' || char === '\t') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    
    if (current) {
      tokens.push(current);
    }
    
    return tokens;
  }
  
  private handleBuiltin(parsed: ParsedCommand): { output: string; exitCode: number } | null {
    switch (parsed.command) {
      case 'cd':
        return this.builtinCd(parsed.args);
      case 'pwd':
        return { output: this.cwd + '\n', exitCode: 0 };
      case 'export':
        return this.builtinExport(parsed.args);
      case 'echo':
        return { output: parsed.args.join(' ') + '\n', exitCode: 0 };
      case 'exit':
        return { output: '', exitCode: parseInt(parsed.args[0] || '0') };
      default:
        return null;
    }
  }
  
  private builtinCd(args: string[]): { output: string; exitCode: number } {
    const target = args[0] || this.env.HOME;
    const newPath = path.resolve(this.cwd, target);
    
    try {
      const stat = this.fs.statSync(newPath);
      if (!stat.isDirectory()) {
        return { output: `cd: not a directory: ${target}\n`, exitCode: 1 };
      }
      
      this.env.OLDPWD = this.cwd;
      this.cwd = newPath;
      this.env.PWD = newPath;
      
      return { output: '', exitCode: 0 };
    } catch {
      return { output: `cd: no such file or directory: ${target}\n`, exitCode: 1 };
    }
  }
  
  private builtinExport(args: string[]): { output: string; exitCode: number } {
    for (const arg of args) {
      const [key, ...valueParts] = arg.split('=');
      if (valueParts.length > 0) {
        this.env[key] = valueParts.join('=');
      }
    }
    return { output: '', exitCode: 0 };
  }
}
```

### 2.4 Terminal Emulation

#### 2.4.1 PTY (Pseudo-Terminal) Interface

```typescript
// pty.ts
interface PTYOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
}

class PTY extends EventEmitter {
  public readonly pid: number;
  private master: ReadableWritablePair<string, string>;
  private slave: ReadableWritablePair<string, string>;
  private process: WebContainerProcess | null = null;
  
  private cols: number;
  private rows: number;
  
  constructor(options: PTYOptions) {
    super();
    this.cols = options.cols;
    this.rows = options.rows;
    this.pid = 0;
    
    // Create bidirectional streams
    this.master = this.createStreamPair();
    this.slave = this.createStreamPair();
    
    // Cross-connect master and slave
    this.pipeStreams();
  }
  
  private createStreamPair(): ReadableWritablePair<string, string> {
    let readController: ReadableStreamDefaultController<string>;
    
    const readable = new ReadableStream<string>({
      start(controller) {
        readController = controller;
      }
    });
    
    const writable = new WritableStream<string>({
      write(chunk) {
        readController.enqueue(chunk);
      }
    });
    
    return { readable, writable };
  }
  
  // Write to master (from terminal UI)
  write(data: string): void {
    const writer = this.master.writable.getWriter();
    writer.write(data);
    writer.releaseLock();
  }
  
  // Read from master (to terminal UI)
  onData(callback: (data: string) => void): void {
    const reader = this.slave.readable.getReader();
    
    const read = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        callback(value);
      }
    };
    
    read();
  }
  
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    
    if (this.process) {
      this.process.resize({ cols, rows });
    }
    
    this.emit('resize', { cols, rows });
  }
  
  // Attach a process to this PTY
  attachProcess(process: WebContainerProcess): void {
    this.process = process;
    (this.pid as number) = 1; // Would be actual PID
    
    // Pipe process output to slave
    const outputReader = process.output.getReader();
    const read = async () => {
      while (true) {
        const { done, value } = await outputReader.read();
        if (done) break;
        
        const writer = this.slave.writable.getWriter();
        writer.write(value);
        writer.releaseLock();
      }
    };
    read();
    
    // Pipe master input to process
    const masterReader = this.master.readable.getReader();
    const inputWriter = process.input.getWriter();
    
    const pipeInput = async () => {
      while (true) {
        const { done, value } = await masterReader.read();
        if (done) break;
        inputWriter.write(value);
      }
    };
    pipeInput();
  }
  
  kill(signal?: number): void {
    this.process?.kill();
    this.emit('exit', signal || 0);
  }
}
```

---

## Part 3: NPM Compatibility

### 3.1 Package Manager Architecture

#### 3.1.1 NPM Client Implementation

```typescript
// npm-client.ts
interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  main?: string;
  module?: string;
  exports?: Record<string, any>;
  bin?: string | Record<string, string>;
}

interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  dependencies: Record<string, string>;
  integrity?: string;
}

class NPMClient {
  private fs: VirtualFileSystem;
  private registry: string = 'https://registry.npmjs.org';
  private cache: Map<string, ResolvedPackage> = new Map();
  
  constructor(fs: VirtualFileSystem) {
    this.fs = fs;
  }
  
  async install(cwd: string, options: InstallOptions = {}): Promise<void> {
    const pkgJsonPath = path.join(cwd, 'package.json');
    const pkgJson = JSON.parse(this.fs.readFileSync(pkgJsonPath, 'utf-8') as string);
    
    const allDeps = {
      ...pkgJson.dependencies,
      ...(options.dev ? pkgJson.devDependencies : {})
    };
    
    // Resolve dependency tree
    const resolved = await this.resolveDependencyTree(allDeps);
    
    // Generate lockfile
    const lockfile = this.generateLockfile(resolved);
    this.fs.writeFileSync(
      path.join(cwd, 'package-lock.json'),
      JSON.stringify(lockfile, null, 2)
    );
    
    // Install packages
    const nodeModulesPath = path.join(cwd, 'node_modules');
    this.fs.mkdirSync(nodeModulesPath, { recursive: true });
    
    for (const pkg of resolved) {
      await this.installPackage(pkg, nodeModulesPath);
    }
  }
  
  private async resolveDependencyTree(
    dependencies: Record<string, string>,
    seen: Set<string> = new Set()
  ): Promise<ResolvedPackage[]> {
    const result: ResolvedPackage[] = [];
    
    for (const [name, versionRange] of Object.entries(dependencies)) {
      const key = `${name}@${versionRange}`;
      if (seen.has(key)) continue;
      seen.add(key);
      
      const resolved = await this.resolvePackage(name, versionRange);
      result.push(resolved);
      
      // Recursively resolve dependencies
      if (resolved.dependencies && Object.keys(resolved.dependencies).length > 0) {
        const subDeps = await this.resolveDependencyTree(resolved.dependencies, seen);
        result.push(...subDeps);
      }
    }
    
    return result;
  }
  
  private async resolvePackage(name: string, versionRange: string): Promise<ResolvedPackage> {
    const cacheKey = `${name}@${versionRange}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }
    
    // Fetch package metadata from registry
    const metadataUrl = `${this.registry}/${encodeURIComponent(name)}`;
    const response = await fetch(metadataUrl);
    const metadata = await response.json();
    
    // Find matching version
    const version = this.resolveVersion(versionRange, Object.keys(metadata.versions));
    const versionData = metadata.versions[version];
    
    const resolved: ResolvedPackage = {
      name,
      version,
      tarballUrl: versionData.dist.tarball,
      dependencies: versionData.dependencies || {},
      integrity: versionData.dist.integrity
    };
    
    this.cache.set(cacheKey, resolved);
    return resolved;
  }
  
  private resolveVersion(range: string, available: string[]): string {
    // Implement semver resolution
    // For simplicity, using a basic implementation
    if (range === 'latest' || range === '*') {
      return available[available.length - 1];
    }
    
    // Handle exact version
    if (available.includes(range)) {
      return range;
    }
    
    // Handle ranges (^, ~, >=, etc.)
    const satisfying = available.filter(v => this.satisfies(v, range));
    if (satisfying.length === 0) {
      throw new Error(`No version of ${range} found`);
    }
    
    return satisfying[satisfying.length - 1];
  }
  
  private satisfies(version: string, range: string): boolean {
    // Basic semver satisfaction check
    // In production, use a proper semver library
    if (range.startsWith('^')) {
      const base = range.slice(1).split('.');
      const ver = version.split('.');
      return ver[0] === base[0] && 
             (parseInt(ver[1]) > parseInt(base[1]) || 
              (ver[1] === base[1] && parseInt(ver[2]) >= parseInt(base[2])));
    }
    
    if (range.startsWith('~')) {
      const base = range.slice(1).split('.');
      const ver = version.split('.');
      return ver[0] === base[0] && ver[1] === base[1] && parseInt(ver[2]) >= parseInt(base[2]);
    }
    
    return version === range;
  }
  
  private async installPackage(pkg: ResolvedPackage, nodeModulesPath: string): Promise<void> {
    // Fetch tarball
    const response = await fetch(pkg.tarballUrl);
    const tarballBuffer = await response.arrayBuffer();
    
    // Extract tarball (simplified - in reality use a proper tar library)
    const files = await this.extractTarball(new Uint8Array(tarballBuffer));
    
    // Write files to node_modules
    const pkgPath = path.join(nodeModulesPath, pkg.name);
    this.fs.mkdirSync(pkgPath, { recursive: true });
    
    for (const [filePath, contents] of files) {
      // Tarball contents are usually in a 'package/' directory
      const relativePath = filePath.replace(/^package\//, '');
      const fullPath = path.join(pkgPath, relativePath);
      
      // Ensure directory exists
      this.fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.fs.writeFileSync(fullPath, contents);
    }
  }
  
  private async extractTarball(data: Uint8Array): Promise<Map<string, Uint8Array>> {
    // Decompress gzip
    const decompressed = await this.gunzip(data);
    
    // Parse tar
    return this.parseTar(decompressed);
  }
  
  private async gunzip(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    // Concatenate chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    return result;
  }
  
  private parseTar(data: Uint8Array): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    let offset = 0;
    
    while (offset < data.length) {
      // Read header (512 bytes)
      const header = data.slice(offset, offset + 512);
      offset += 512;
      
      // Check for end of archive (all zeros)
      if (header.every(b => b === 0)) break;
      
      // Parse filename (0-100)
      const filename = this.parseString(header, 0, 100);
      if (!filename) break;
      
      // Parse size (124-136, octal)
      const sizeStr = this.parseString(header, 124, 12);
      const size = parseInt(sizeStr, 8);
      
      // Parse file type (156)
      const type = header[156];
      
      if (type === 0 || type === 48) { // Regular file
        const content = data.slice(offset, offset + size);
        files.set(filename, content);
      }
      
      // Move to next header (size rounded up to 512)
      offset += Math.ceil(size / 512) * 512;
    }
    
    return files;
  }
  
  private parseString(buffer: Uint8Array, start: number, length: number): string {
    const bytes = buffer.slice(start, start + length);
    const nullIndex = bytes.indexOf(0);
    const relevantBytes = nullIndex >= 0 ? bytes.slice(0, nullIndex) : bytes;
    return new TextDecoder().decode(relevantBytes);
  }
  
  private generateLockfile(packages: ResolvedPackage[]): any {
    const lockfile: any = {
      name: '',
      lockfileVersion: 2,
      requires: true,
      packages: {}
    };
    
    for (const pkg of packages) {
      lockfile.packages[`node_modules/${pkg.name}`] = {
        version: pkg.version,
        resolved: pkg.tarballUrl,
        integrity: pkg.integrity,
        dependencies: pkg.dependencies
      };
    }
    
    return lockfile;
  }
  
  // Run npm scripts
  async runScript(cwd: string, scriptName: string, spawner: ProcessSpawner): Promise<number> {
    const pkgJsonPath = path.join(cwd, 'package.json');
    const pkgJson = JSON.parse(this.fs.readFileSync(pkgJsonPath, 'utf-8') as string);
    
    const script = pkgJson.scripts?.[scriptName];
    if (!script) {
      throw new Error(`Script "${scriptName}" not found in package.json`);
    }
    
    // Parse and execute script
    const process = await spawner.spawn('sh', ['-c', script], {
      cwd,
      env: {
        PATH: `${path.join(cwd, 'node_modules', '.bin')}:/usr/local/bin:/usr/bin:/bin`,
        npm_lifecycle_event: scriptName
      }
    });
    
    return process.exit;
  }
}
```

### 3.2 Native Addon Polyfills

#### 3.2.1 Polyfill Registry

```typescript
// polyfill-registry.ts
interface PolyfillMapping {
  original: string;
  polyfill: string;
  versions?: Record<string, string>;
}

const NATIVE_ADDON_POLYFILLS: PolyfillMapping[] = [
  {
    original: 'esbuild',
    polyfill: 'esbuild-wasm'
  },
  {
    original: 'sharp',
    polyfill: '@aspect-dev/sharp-wasm'
  },
  {
    original: 'bcrypt',
    polyfill: 'bcryptjs'
  },
  {
    original: 'canvas',
    polyfill: '@aspect-dev/canvas-wasm'
  },
  {
    original: 'node-sass',
    polyfill: 'sass'
  },
  {
    original: 'sqlite3',
    polyfill: 'sql.js'
  },
  {
    original: 'fsevents',
    polyfill: null // Not needed in browser
  },
  {
    original: 'node-gyp',
    polyfill: null // Build tool, not needed
  }
];

class PolyfillRegistry {
  private mappings: Map<string, string | null> = new Map();
  
  constructor() {
    for (const mapping of NATIVE_ADDON_POLYFILLS) {
      this.mappings.set(mapping.original, mapping.polyfill);
    }
  }
  
  getPolyfill(packageName: string, version?: string): string | null | undefined {
    return this.mappings.get(packageName);
  }
  
  hasPolyfill(packageName: string): boolean {
    return this.mappings.has(packageName);
  }
  
  applyPolyfills(dependencies: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    
    for (const [name, version] of Object.entries(dependencies)) {
      const polyfill = this.getPolyfill(name, version);
      
      if (polyfill === null) {
        // Skip this dependency
        continue;
      } else if (polyfill !== undefined) {
        result[polyfill] = version;
      } else {
        result[name] = version;
      }
    }
    
    return result;
  }
}
```

### 3.3 Binary/CLI Tool Support

#### 3.3.1 NPX Implementation

```typescript
// npx.ts
class NPX {
  private fs: VirtualFileSystem;
  private npmClient: NPMClient;
  private spawner: ProcessSpawner;
  
  constructor(fs: VirtualFileSystem, npmClient: NPMClient, spawner: ProcessSpawner) {
    this.fs = fs;
    this.npmClient = npmClient;
    this.spawner = spawner;
  }
  
  async execute(command: string, args: string[], cwd: string): Promise<number> {
    // Check if command exists in local node_modules/.bin
    const localBinPath = path.join(cwd, 'node_modules', '.bin', command);
    
    if (this.fs.existsSync(localBinPath)) {
      return this.runBinary(localBinPath, args, cwd);
    }
    
    // Install package temporarily and run
    const tempDir = `/tmp/npx-${Date.now()}`;
    this.fs.mkdirSync(tempDir, { recursive: true });
    
    // Create temporary package.json
    this.fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'npx-temp',
        version: '1.0.0',
        dependencies: { [command]: 'latest' }
      })
    );
    
    // Install
    await this.npmClient.install(tempDir);
    
    // Run
    const binPath = path.join(tempDir, 'node_modules', '.bin', command);
    const exitCode = await this.runBinary(binPath, args, cwd);
    
    // Cleanup
    this.fs.rmdirSync(tempDir, { recursive: true });
    
    return exitCode;
  }
  
  private async runBinary(binPath: string, args: string[], cwd: string): Promise<number> {
    // Read shebang to determine how to run
    const binContent = this.fs.readFileSync(binPath, 'utf-8') as string;
    const firstLine = binContent.split('\n')[0];
    
    if (firstLine.startsWith('#!')) {
      const interpreter = firstLine.slice(2).trim();
      
      if (interpreter.includes('node')) {
        const process = await this.spawner.spawn('node', [binPath, ...args], { cwd });
        return process.exit;
      }
      
      if (interpreter.includes('sh') || interpreter.includes('bash')) {
        const process = await this.spawner.spawn('sh', [binPath, ...args], { cwd });
        return process.exit;
      }
    }
    
    // Default: run with node
    const process = await this.spawner.spawn('node', [binPath, ...args], { cwd });
    return process.exit;
  }
}
```

### 3.4 Package.json Scripts

#### 3.4.1 Script Runner

```typescript
// script-runner.ts
class ScriptRunner {
  private fs: VirtualFileSystem;
  private spawner: ProcessSpawner;
  private npmClient: NPMClient;
  
  constructor(fs: VirtualFileSystem, spawner: ProcessSpawner, npmClient: NPMClient) {
    this.fs = fs;
    this.spawner = spawner;
    this.npmClient = npmClient;
  }
  
  async run(scriptName: string, cwd: string, extraArgs: string[] = []): Promise<number> {
    const pkgJsonPath = path.join(cwd, 'package.json');
    const pkgJson = JSON.parse(this.fs.readFileSync(pkgJsonPath, 'utf-8') as string);
    
    // Check for lifecycle scripts
    const preScript = pkgJson.scripts?.[`pre${scriptName}`];
    const script = pkgJson.scripts?.[scriptName];
    const postScript = pkgJson.scripts?.[`post${scriptName}`];
    
    if (!script) {
      // Check for npm built-in behavior
      if (scriptName === 'start') {
        return this.runDefaultStart(cwd, pkgJson);
      }
      if (scriptName === 'test') {
        console.error('Error: no test specified');
        return 1;
      }
      
      throw new Error(`Missing script: "${scriptName}"`);
    }
    
    // Build environment
    const env = this.buildScriptEnv(cwd, scriptName, pkgJson);
    
    // Run pre-script
    if (preScript) {
      const exitCode = await this.executeScript(preScript, cwd, env);
      if (exitCode !== 0) return exitCode;
    }
    
    // Run main script
    const fullScript = extraArgs.length > 0 
      ? `${script} ${extraArgs.join(' ')}`
      : script;
    
    const exitCode = await this.executeScript(fullScript, cwd, env);
    if (exitCode !== 0) return exitCode;
    
    // Run post-script
    if (postScript) {
      return this.executeScript(postScript, cwd, env);
    }
    
    return 0;
  }
  
  private buildScriptEnv(cwd: string, scriptName: string, pkgJson: PackageJson): Record<string, string> {
    return {
      PATH: `${path.join(cwd, 'node_modules', '.bin')}:/usr/local/bin:/usr/bin:/bin`,
      npm_lifecycle_event: scriptName,
      npm_package_name: pkgJson.name,
      npm_package_version: pkgJson.version,
      npm_node_execpath: '/usr/bin/node',
      npm_execpath: '/usr/bin/npm',
      NODE_ENV: process.env.NODE_ENV || 'development'
    };
  }
  
  private async executeScript(script: string, cwd: string, env: Record<string, string>): Promise<number> {
    // Parse script for operators
    const commands = this.parseScript(script);
    
    for (const cmd of commands) {
      const process = await this.spawner.spawn('sh', ['-c', cmd.command], { cwd, env });
      
      // Handle output
      const reader = process.output.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        console.log(value);
      }
      
      const exitCode = await process.exit;
      
      if (cmd.operator === '&&' && exitCode !== 0) {
        return exitCode;
      }
      
      if (cmd.operator === '||' && exitCode === 0) {
        break;
      }
    }
    
    return 0;
  }
  
  private parseScript(script: string): Array<{ command: string; operator: string }> {
    // Parse && and || operators
    const parts: Array<{ command: string; operator: string }> = [];
    let current = '';
    
    for (let i = 0; i < script.length; i++) {
      if (script[i] === '&' && script[i + 1] === '&') {
        parts.push({ command: current.trim(), operator: '&&' });
        current = '';
        i++;
      } else if (script[i] === '|' && script[i + 1] === '|') {
        parts.push({ command: current.trim(), operator: '||' });
        current = '';
        i++;
      } else {
        current += script[i];
      }
    }
    
    if (current.trim()) {
      parts.push({ command: current.trim(), operator: '' });
    }
    
    return parts;
  }
  
  private async runDefaultStart(cwd: string, pkgJson: PackageJson): Promise<number> {
    // npm default start behavior: node server.js
    const serverPath = path.join(cwd, 'server.js');
    if (this.fs.existsSync(serverPath)) {
      const process = await this.spawner.spawn('node', ['server.js'], { cwd });
      return process.exit;
    }
    
    // Try main field
    if (pkgJson.main) {
      const process = await this.spawner.spawn('node', [pkgJson.main], { cwd });
      return process.exit;
    }
    
    console.error('Error: missing script: "start"');
    return 1;
  }
}
```

---

## Public API Surface

### Main WebContainer Class

```typescript
// webcontainer.ts
import type { FileSystemTree, FileSystemAPI, SpawnOptions, WebContainerProcess, BootOptions } from './types';

export class WebContainer {
  private static instance: WebContainer | null = null;
  
  public readonly fs: FileSystemAPI;
  public readonly path: string;
  public readonly workdir: string;
  
  private virtualFS: VirtualFileSystem;
  private processTable: ProcessTable;
  private spawner: ProcessSpawner;
  private npmClient: NPMClient;
  private eventEmitter: EventEmitter;
  
  private constructor(options: BootOptions) {
    this.virtualFS = new VirtualFileSystem();
    this.processTable = new ProcessTable();
    this.spawner = new ProcessSpawner(this.virtualFS, this.processTable);
    this.npmClient = new NPMClient(this.virtualFS);
    this.eventEmitter = new EventEmitter();
    
    this.workdir = `/home/${options.workdirName || 'project'}`;
    this.path = '/usr/local/bin:/usr/bin:/bin';
    
    // Setup file system API
    this.fs = this.createFileSystemAPI();
    
    // Initialize directories
    this.virtualFS.mkdirSync(this.workdir, { recursive: true });
  }
  
  static async boot(options: BootOptions = {}): Promise<WebContainer> {
    if (WebContainer.instance) {
      throw new Error('WebContainer already booted');
    }
    
    // Verify environment
    if (!crossOriginIsolated) {
      throw new Error('WebContainer requires cross-origin isolation');
    }
    
    WebContainer.instance = new WebContainer(options);
    
    // Initialize Service Worker
    await WebContainer.instance.initServiceWorker();
    
    return WebContainer.instance;
  }
  
  private async initServiceWorker(): Promise<void> {
    const registration = await navigator.serviceWorker.register('/webcontainer-sw.js');
    await navigator.serviceWorker.ready;
    
    // Setup message channel with Service Worker
    navigator.serviceWorker.addEventListener('message', (event) => {
      this.handleServiceWorkerMessage(event.data);
    });
  }
  
  async mount(tree: FileSystemTree | Uint8Array, options?: { mountPoint?: string }): Promise<void> {
    const mountPoint = options?.mountPoint || this.workdir;
    
    if (tree instanceof Uint8Array) {
      // Handle binary snapshot
      const decoded = this.decodeSnapshot(tree);
      this.virtualFS.mount(decoded, mountPoint);
    } else {
      this.virtualFS.mount(tree, mountPoint);
    }
  }
  
  async spawn(command: string, args?: string[], options?: SpawnOptions): Promise<WebContainerProcess>;
  async spawn(command: string, options?: SpawnOptions): Promise<WebContainerProcess>;
  async spawn(
    command: string,
    argsOrOptions?: string[] | SpawnOptions,
    maybeOptions?: SpawnOptions
  ): Promise<WebContainerProcess> {
    let args: string[] = [];
    let options: SpawnOptions = {};
    
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions;
      options = maybeOptions || {};
    } else if (argsOrOptions) {
      options = argsOrOptions;
    }
    
    return this.spawner.spawn(command, args, {
      cwd: options.cwd ? path.join(this.workdir, options.cwd) : this.workdir,
      env: options.env,
      output: options.output,
      terminal: options.terminal
    });
  }
  
  async export(exportPath: string, options?: ExportOptions): Promise<Uint8Array | FileSystemTree> {
    const fullPath = path.join(this.workdir, exportPath);
    const tree = this.virtualFS.export(fullPath);
    
    if (options?.format === 'zip') {
      return this.createZip(tree);
    }
    
    if (options?.format === 'binary') {
      return this.encodeSnapshot(tree);
    }
    
    return tree;
  }
  
  on(event: 'port', listener: (port: number, type: 'open' | 'close', url: string) => void): () => void;
  on(event: 'error', listener: (error: { message: string }) => void): () => void;
  on(event: 'server-ready', listener: (port: number, url: string) => void): () => void;
  on(event: string, listener: (...args: any[]) => void): () => void {
    this.eventEmitter.on(event, listener);
    return () => this.eventEmitter.off(event, listener);
  }
  
  teardown(): void {
    // Terminate all processes
    for (const process of this.processTable.listProcesses()) {
      if (process.worker) {
        process.worker.terminate();
      }
    }
    
    // Clear instance
    WebContainer.instance = null;
  }
  
  private createFileSystemAPI(): FileSystemAPI {
    return {
      readFile: (path, encoding) => this.virtualFS.readFileSync(path, encoding),
      writeFile: (path, data, options) => this.virtualFS.writeFileSync(path, data, options),
      mkdir: (path, options) => this.virtualFS.mkdirSync(path, options),
      readdir: (path, options) => this.virtualFS.readdirSync(path, options),
      rm: (path, options) => {
        const stat = this.virtualFS.statSync(path);
        if (stat.isDirectory()) {
          this.virtualFS.rmdirSync(path, options);
        } else {
          this.virtualFS.unlinkSync(path);
        }
      },
      rename: (oldPath, newPath) => this.virtualFS.renameSync(oldPath, newPath),
      watch: (path, options, listener) => this.virtualFS.watch(path, options, listener)
    };
  }
  
  private handleServiceWorkerMessage(data: any): void {
    switch (data.type) {
      case 'server-ready':
        this.eventEmitter.emit('server-ready', data.port, data.url);
        break;
      case 'port':
        this.eventEmitter.emit('port', data.port, data.action, data.url);
        break;
      case 'error':
        this.eventEmitter.emit('error', { message: data.message });
        break;
    }
  }
}

// Re-export types
export type { FileSystemTree, FileSystemAPI, SpawnOptions, WebContainerProcess, BootOptions };
```

---

## Implementation Checklist

### Phase 1: Core Infrastructure
- [ ] SharedArrayBuffer setup with proper headers
- [ ] Service Worker registration and message passing
- [ ] Basic virtual filesystem (read/write/directory)
- [ ] Process spawning with Web Workers

### Phase 2: Node.js Runtime
- [ ] Process polyfill (env, cwd, exit, nextTick)
- [ ] Buffer polyfill
- [ ] CommonJS module system
- [ ] Event emitter implementation
- [ ] Stream polyfills

### Phase 3: Network Stack
- [ ] TCP virtualization layer
- [ ] HTTP server polyfill
- [ ] Service Worker request interception
- [ ] Preview iframe integration

### Phase 4: NPM Support
- [ ] Package resolution algorithm
- [ ] Tarball extraction
- [ ] Dependency tree resolution
- [ ] Lockfile generation/parsing
- [ ] Script execution

### Phase 5: Shell & Terminal
- [ ] Basic shell implementation
- [ ] PTY emulation
- [ ] Built-in commands (ls, cat, mkdir, etc.)
- [ ] Environment variable handling

### Phase 6: Polish
- [ ] Native addon polyfill registry
- [ ] Error handling and recovery
- [ ] Performance optimization
- [ ] Memory management
