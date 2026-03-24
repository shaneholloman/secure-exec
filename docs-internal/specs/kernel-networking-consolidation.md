# Kernel Networking & Resource Consolidation

## Problem

The virtual kernel (`packages/core/src/kernel/`) provides unified VFS, process table, FD table, pipes, PTY, and permissions — shared across Node.js and WasmVM runtimes. However, **networking and several resource management subsystems bypass the kernel entirely**, implemented directly in the Node.js bridge/driver layer. This means:

1. WasmVM has no TCP/UDP/Unix socket support (WASI extensions #1, #2, #17)
2. WasmVM has no HTTP server support
3. HTTP server loopback goes through real host TCP instead of kernel routing
4. 492 Node.js conformance tests are blocked (FIX-01: createServer)
5. 76 Node.js dgram tests are blocked (UDP)
6. Resource tracking (timers, handles, sockets) is Node-specific, not kernel-managed
7. SSRF/network permissions are enforced in the host adapter, not the kernel

## Goal

Move all networking and resource management into the kernel so that:
- Node.js and WasmVM share the same socket table, port registry, and network stack
- Loopback connections route in-kernel without real TCP
- External connections route through host adapters after kernel permission checks
- Resource budgets (timers, handles, sockets) are kernel-enforced per-process

---

## Part 1: Kernel Network Stack

### 1.1 Virtual Socket Table (K-1)

Add `packages/core/src/kernel/socket-table.ts`:

```
KernelSocket {
  id: number
  domain: AF_INET | AF_INET6 | AF_UNIX
  type: SOCK_STREAM | SOCK_DGRAM
  protocol: number
  state: 'created' | 'bound' | 'listening' | 'connected' | 'closed'
  localAddr?: { host: string, port: number } | { path: string }
  remoteAddr?: { host: string, port: number } | { path: string }
  options: Map<number, number>  // SO_REUSEADDR, TCP_NODELAY, etc.
  pid: number  // owning process
  readBuffer: Uint8Array[]  // incoming data queue
  readWaiters: Array<(data: Uint8Array) => void>
  writeBuffer: Uint8Array[]  // outgoing data queue (for non-blocking)
  backlog: KernelSocket[]  // pending connections (listening sockets only)
  acceptWaiters: Array<(socket: KernelSocket) => void>
}

SocketTable {
  private sockets: Map<number, KernelSocket>
  private nextSocketId: number
  private listeners: Map<string, KernelSocket>  // "host:port" → listening socket

  create(domain, type, protocol, pid): number  // returns socket ID
  bind(socketId, addr): void
  listen(socketId, backlog): void
  accept(socketId): KernelSocket | null  // null = EAGAIN
  connect(socketId, addr): void  // in-kernel for loopback, host adapter for external
  send(socketId, data, flags): number  // bytes sent
  recv(socketId, maxBytes, flags): Uint8Array | null
  close(socketId): void
  setsockopt(socketId, level, optname, optval): void
  getsockopt(socketId, level, optname): number
  getLocalAddr(socketId): SockAddr
  getRemoteAddr(socketId): SockAddr
}
```

**Testing:** Standalone test in `packages/core/test/kernel/socket-table.test.ts`:
- Create socket, bind to port, verify state transitions
- Bind two sockets to same port — verify EADDRINUSE (unless SO_REUSEADDR)
- Close socket, verify port is freed
- Create 256+ sockets — verify EMFILE
- Verify per-process socket isolation (process A can't close process B's socket)

### 1.2 Loopback Routing (K-2)

When `connect(socketId, { host: 'localhost', port: P })` is called and port P has a listening socket in the same kernel:

1. Kernel creates a pair of connected sockets (like `socketpair()`)
2. Client socket is returned to the connector
3. Server socket is placed in the listener's `backlog` queue
4. `accept()` on the listener returns the server-side socket
5. Data written to either side is buffered in the kernel (like pipes) — no real TCP

For external connections (no listener on that port):
1. Kernel calls `hostAdapter.connect(addr)` after permission check
2. Host adapter creates a real TCP connection
3. Data relay between kernel socket buffer and host socket

**Testing:** Standalone test in `packages/core/test/kernel/loopback.test.ts`:
- Create listener on port 8080, connect to localhost:8080 — verify accept() returns socket
- Write data from client → read from server socket — verify data matches
- Write data from server → read from client socket — verify data matches
- Close client — verify server gets EOF
- Close server — verify client gets ECONNRESET or EOF
- Connect to external port (no listener) — verify host adapter is called
- Verify loopback never calls host adapter

### 1.3 Server Sockets (K-3)

`listen()` on a bound socket transitions it to 'listening' state and registers it in the kernel's listener map. `accept()` dequeues from the backlog.

For external-facing servers (sandbox wants to accept real TCP connections):
1. Kernel calls `hostAdapter.listen(addr)` to create a real TCP listener on the host
2. Host adapter forwards incoming connections as new kernel sockets
3. Sandbox code calls `accept()` and gets kernel socket IDs
4. Data relay between host TCP and kernel socket buffers

**Testing:** Standalone test in `packages/core/test/kernel/server-socket.test.ts`:
- Listen on port, accept connection, exchange data, close
- Listen on port already in use — verify EADDRINUSE
- Accept with no pending connections and O_NONBLOCK — verify EAGAIN
- Accept with pending connections — verify FIFO order
- Close listener — verify pending connections get ECONNREFUSED
- Backlog overflow — verify ECONNREFUSED for excess connections

### 1.4 UDP Sockets (K-4)

UDP sockets use the same socket table but with `SOCK_DGRAM` semantics:

- `send(socketId, data, flags, destAddr)` — datagram send (no connection required)
- `recv(socketId, maxBytes, flags)` — returns `{ data, srcAddr }`
- `bind()` registers in listener map for receiving
- No `listen()`/`accept()` — datagrams are connectionless
- `connect()` sets a default destination (optional, for `send()` without dest)

For external UDP:
1. Kernel calls `hostAdapter.sendDatagram(data, destAddr)` after permission check
2. Host adapter sends via real UDP
3. Incoming datagrams from host adapter are queued in kernel socket buffer

**Testing:** Standalone test in `packages/core/test/kernel/udp-socket.test.ts`:
- Create UDP socket, bind, send datagram to self — verify recv gets it (loopback)
- Send to another bound UDP socket in same kernel — verify delivery
- Send without bind — verify ephemeral port assigned
- Send to unbound port — verify datagram is silently dropped (UDP semantics)
- Verify message boundaries preserved (two 100-byte sends → two 100-byte recvs, not one 200-byte recv)

### 1.5 Unix Domain Sockets (K-5)

Unix domain sockets bind to VFS paths instead of host:port:

- `bind(socketId, { path: '/tmp/my.sock' })` — creates socket file in VFS
- `connect(socketId, { path: '/tmp/my.sock' })` — connects to bound socket via kernel
- Always in-kernel (no host adapter involvement)
- Support both `SOCK_STREAM` and `SOCK_DGRAM` modes

**Testing:** Standalone test in `packages/core/test/kernel/unix-socket.test.ts`:
- Bind to VFS path, connect, exchange data
- Verify socket file appears in VFS (stat returns socket type)
- Remove socket file — verify new connections fail with ECONNREFUSED
- Bind to existing path — verify EADDRINUSE

### 1.6 Socket Options (K-6)

Kernel tracks socket options per-socket. For loopback sockets, most are no-ops. For host-connected sockets, options are forwarded to host adapter.

Supported options:
- `SO_REUSEADDR` / `SO_REUSEPORT` — kernel-enforced (allow port reuse)
- `SO_KEEPALIVE` — forwarded to host adapter for real connections
- `TCP_NODELAY` — forwarded to host adapter for real connections
- `SO_RCVBUF` / `SO_SNDBUF` — kernel buffer size limits
- `SO_LINGER` — kernel-enforced close behavior

**Testing:** Inline in socket-table tests:
- Set SO_REUSEADDR, bind two sockets to same port — verify success
- Without SO_REUSEADDR — verify EADDRINUSE
- Set SO_RCVBUF, send more data than buffer — verify behavior

### 1.7 Network Permissions (K-7)

Move SSRF and network permission checks from host adapter into kernel:

```
Kernel.checkNetworkPermission(op: 'connect' | 'listen' | 'send', addr: SockAddr): void
```

- Called by socket table before `connect()`, `listen()`, `send()` to external
- Loopback connections (to kernel-owned ports) always allowed
- External connections checked against permissions policy
- Replaces the scattered SSRF validation in `driver.ts`

**Testing:** Standalone test in `packages/core/test/kernel/network-permissions.test.ts`:
- Deny-by-default: connect to external IP — verify EACCES
- Allow specific host: connect to allowed.com — verify success
- Loopback always allowed: connect to localhost kernel port — verify success regardless of policy
- Listen on denied port — verify EACCES

---

## Part 2: Kernel Resource Management

### 2.1 Kernel Timer Table (N-5, N-8)

Move timer tracking from Node bridge to kernel. Add `packages/core/src/kernel/timer-table.ts`:

```
TimerTable {
  private timers: Map<number, KernelTimer>
  private nextTimerId: number

  createTimer(pid, delayMs, repeat, callback): number  // returns timer ID
  clearTimer(timerId): void
  getActiveTimers(pid): KernelTimer[]
  enforceLimit(pid, maxTimers): void  // throws on budget exceeded
  clearAllForProcess(pid): void  // cleanup on process exit
}
```

Host adapter provides the actual scheduling (setTimeout/setInterval on host). Kernel tracks ownership and enforces budgets.

**Testing:** Standalone test in `packages/core/test/kernel/timer-table.test.ts`:
- Create timer, verify it fires callback
- Create timer, clear it — verify callback never fires
- Create N+1 timers with limit N — verify budget error
- Kill process — verify all its timers are cleared
- Timer in process A can't be cleared by process B

### 2.2 Kernel Handle Table (N-7, N-9)

Move active handle tracking from Node bridge to kernel. Extend process table:

```
ProcessEntry {
  // existing: pid, ppid, pgid, status, driver, ...
  activeHandles: Map<string, string>  // id → description
  handleLimit?: number
}
```

**Testing:** Inline in process table tests:
- Register handle, verify it's tracked
- Register beyond limit — verify error
- Process exit — verify all handles cleaned up

### 2.3 DNS Cache (N-10)

Add kernel-level DNS cache shared across runtimes:

```
DnsCache {
  private cache: Map<string, { result: DnsResult, expiresAt: number }>

  lookup(hostname, rrtype): DnsResult | null  // cache hit
  store(hostname, rrtype, result, ttl): void
  flush(): void
}
```

Runtimes call kernel DNS before falling through to host adapter.

**Testing:** Standalone test in `packages/core/test/kernel/dns-cache.test.ts`:
- Lookup miss → host adapter called → result cached
- Lookup hit → host adapter NOT called
- TTL expiry → host adapter called again
- Flush → all entries cleared

---

## Part 3: Node.js Bridge Migration

### 3.1 FD Table (N-1)

**Current:** `bridge/fs.ts` maintains its own `fdTable` Map with `nextFd` counter.
**Target:** Bridge calls `kernel.fdTable.open()`, `kernel.fdTable.read()`, etc.
**Migration:** Replace all `fdTable.get(fd)` / `fdTable.set(fd, ...)` with kernel FD table calls. The kernel already has `ProcessFDTable` — wire the bridge to use it.

### 3.2 HTTP Server (N-2, N-3, N-9)

**Current:** `driver.ts` creates real host TCP servers, `network.ts` routes requests via `serverRequestListeners` Map.
**Target:** `http.createServer()` calls `kernel.socketTable.create() → bind() → listen()`. Incoming connections are kernel sockets. Request parsing happens in the bridge (polyfill layer), not the kernel.
**Migration:**
1. Bridge calls `kernel.socketTable.listen(port)` instead of `hostAdapter.httpServerListen()`
2. For loopback: kernel connects client→server directly
3. For external: kernel calls `hostAdapter.tcpListen(port)` and relays connections as kernel sockets
4. Remove `servers` Map, `ownedServerPorts` Set, `serverRequestListeners` Map from bridge/driver
5. HTTP protocol parsing stays in the bridge (it's Node.js-specific, not kernel)

### 3.3 Net Sockets (N-4)

**Current:** `bridge/network.ts` maintains `activeNetSockets` Map, `bridge-handlers.ts` maintains separate socket Map.
**Target:** `net.connect()` calls `kernel.socketTable.create() → connect()`. Data flows through kernel socket buffers.
**Migration:** Replace `activeNetSockets` / `netSockets` Maps with kernel socket IDs. Bridge reads/writes via `kernel.socketTable.send()` / `recv()`.

### 3.4 Child Process Registry (N-6)

**Current:** `bridge/child-process.ts` maintains `activeChildren` Map separate from kernel process table.
**Target:** All child processes are in the kernel process table. Bridge queries kernel for process state.
**Migration:** Bridge calls `kernel.processTable.register()` on spawn, queries `kernel.processTable.get()` for events. Remove `activeChildren` Map.

### 3.5 SSRF/Network Permissions (N-11)

**Current:** SSRF validation in `driver.ts` NetworkAdapter with `ownedServerPorts` whitelist.
**Target:** Kernel permission engine checks all `connect()` calls. Loopback to kernel-owned ports is always allowed.
**Migration:** Move SSRF logic into `kernel.checkNetworkPermission()`. Remove SSRF code from driver.

### 3.6 Crypto Sessions (N-12)

**Current:** `bridge-handlers.ts` maintains `cipherSessions` Map with `nextCipherSessionId`.
**Target:** Consider stateless API (single-call encrypt/decrypt) or move session state to kernel resource table.
**Migration:** Low priority — crypto sessions don't affect WasmVM interop since WasmVM uses host crypto directly.

---

## Part 4: WasmVM Integration

WasmVM already communicates with the kernel via synchronous RPC (`kernel-worker.ts` with Atomics.wait + SharedArrayBuffer). New kernel network APIs are exposed the same way:

```
// In kernel-worker.ts, add syscall handlers:
case 'sock_open':    return kernel.socketTable.create(domain, type, protocol, pid);
case 'sock_bind':    return kernel.socketTable.bind(socketId, addr);
case 'sock_listen':  return kernel.socketTable.listen(socketId, backlog);
case 'sock_accept':  return kernel.socketTable.accept(socketId);
case 'sock_connect': return kernel.socketTable.connect(socketId, addr);
case 'sock_send':    return kernel.socketTable.send(socketId, data, flags);
case 'sock_recv':    return kernel.socketTable.recv(socketId, maxBytes, flags);
case 'sock_close':   return kernel.socketTable.close(socketId);
case 'sock_setopt':  return kernel.socketTable.setsockopt(socketId, level, opt, val);
case 'sock_getopt':  return kernel.socketTable.getsockopt(socketId, level, opt);
```

WasmVM WASI extensions (`native/wasmvm/crates/wasi-ext/src/lib.rs`) call these via the existing host import mechanism. The C sysroot patches route `socket()`, `bind()`, `listen()`, `accept()`, `connect()`, `send()`, `recv()`, `close()`, `setsockopt()`, `getsockopt()` through these host imports.

---

## Part 5: Host Adapter Interface

The host adapter interface (`packages/core/src/types.ts` or similar) needs new methods for the kernel to delegate external I/O:

```typescript
interface HostNetworkAdapter {
  // TCP
  tcpConnect(host: string, port: number): Promise<HostSocket>
  tcpListen(host: string, port: number): Promise<HostListener>

  // UDP
  udpBind(host: string, port: number): Promise<HostUdpSocket>
  udpSend(socket: HostUdpSocket, data: Uint8Array, host: string, port: number): Promise<void>

  // DNS
  dnsLookup(hostname: string, rrtype: string): Promise<DnsResult>
}

interface HostSocket {
  write(data: Uint8Array): Promise<void>
  read(): Promise<Uint8Array | null>  // null = EOF
  close(): Promise<void>
}

interface HostListener {
  accept(): Promise<HostSocket>
  close(): Promise<void>
  readonly port: number  // actual bound port (for port 0)
}

interface HostUdpSocket {
  recv(): Promise<{ data: Uint8Array, remoteAddr: { host: string, port: number } }>
  close(): Promise<void>
}
```

Node.js driver implements this using `node:net` / `node:dgram`. Browser driver implements TCP via WebSocket proxy or marks as unavailable.

---

## Testing Strategy

All kernel components are tested standalone — no Node.js runtime, no WasmVM, no browser. Tests import kernel classes directly and exercise them in isolation.

### Test files:

```
packages/core/test/kernel/
  socket-table.test.ts        # K-1: Socket lifecycle, state transitions, EMFILE
  loopback.test.ts            # K-2: In-kernel client↔server routing
  server-socket.test.ts       # K-3: listen/accept, backlog, EADDRINUSE
  udp-socket.test.ts          # K-4: Datagram send/recv, message boundaries
  unix-socket.test.ts         # K-5: VFS-path binding, stream + dgram modes
  network-permissions.test.ts # K-7: Deny-by-default, loopback exemption
  timer-table.test.ts         # Timer lifecycle, budgets, process cleanup
  dns-cache.test.ts           # Cache hit/miss, TTL, flush
```

### Test pattern:

```typescript
import { KernelImpl } from '../../src/kernel/kernel';
import { InMemoryFileSystem } from '../../src/shared/in-memory-fs';

describe('socket table', () => {
  let kernel: KernelImpl;

  beforeEach(() => {
    kernel = new KernelImpl({ vfs: new InMemoryFileSystem() });
  });

  afterEach(async () => {
    await kernel.dispose();
  });

  it('creates a TCP socket', () => {
    const socketId = kernel.socketTable.create(AF_INET, SOCK_STREAM, 0, /*pid=*/1);
    expect(socketId).toBeGreaterThan(0);
    const socket = kernel.socketTable.get(socketId);
    expect(socket.state).toBe('created');
    expect(socket.domain).toBe(AF_INET);
    expect(socket.type).toBe(SOCK_STREAM);
  });

  it('loopback TCP connect routes in-kernel', async () => {
    // Server
    const serverSock = kernel.socketTable.create(AF_INET, SOCK_STREAM, 0, 1);
    kernel.socketTable.bind(serverSock, { host: '127.0.0.1', port: 8080 });
    kernel.socketTable.listen(serverSock, 5);

    // Client
    const clientSock = kernel.socketTable.create(AF_INET, SOCK_STREAM, 0, 2);
    kernel.socketTable.connect(clientSock, { host: '127.0.0.1', port: 8080 });

    // Accept
    const accepted = kernel.socketTable.accept(serverSock);
    expect(accepted).not.toBeNull();

    // Exchange data
    kernel.socketTable.send(clientSock, Buffer.from('hello'));
    const data = kernel.socketTable.recv(accepted!.id, 1024);
    expect(Buffer.from(data!).toString()).toBe('hello');
  });
});
```

### Integration test (cross-runtime):

```typescript
// packages/secure-exec/tests/kernel/cross-runtime-network.test.ts
it('WasmVM server accepts Node.js client connection', async () => {
  const kernel = createKernel();

  // WasmVM process listens on port 9090
  const wasmProc = await kernel.spawn('wasm-server', [], { driver: wasmDriver });
  // (WASM binary calls socket() → bind(9090) → listen() → accept())

  // Node.js process connects to port 9090
  const nodeResult = await kernel.exec('node', ['-e', `
    const net = require('net');
    const client = net.connect(9090, '127.0.0.1', () => {
      client.write('ping');
      client.on('data', (d) => { console.log(d.toString()); client.end(); });
    });
  `]);

  expect(nodeResult.stdout).toContain('pong');
});
```

---

## Migration Order

1. **Socket table + loopback** (K-1, K-2, K-3) — core abstraction, everything depends on it
2. **Network permissions** (K-7) — must exist before exposing sockets to runtimes
3. **Node.js HTTP server migration** (N-2, N-3) — highest ROI, unlocks 492 tests
4. **Node.js net socket migration** (N-4) — needed for HTTP server
5. **UDP sockets** (K-4) — unlocks 76 dgram tests + WasmVM #17
6. **Unix domain sockets** (K-5) — unlocks WasmVM #2
7. **WasmVM syscall wiring** — expose socket table via RPC
8. **Signal handlers** (K-8) — independent, can parallel with above
9. **Timer/handle migration** (N-5, N-7, N-8) — lower priority, mainly cleanup
10. **VFS change notifications** (K-9) — independent, lower priority
11. **DNS cache** (N-10) — nice-to-have
12. **FD table unification** (N-1) — important but risky, do after networking stabilizes
13. **Crypto session cleanup** (N-12) — lowest priority
