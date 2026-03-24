# Kernel Consolidation

Networking, resource management, and runtime-specific subsystems that need to move into the shared kernel.

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
  state: 'created' | 'bound' | 'listening' | 'connected' | 'read-closed' | 'write-closed' | 'closed'
  nonBlocking: boolean  // O_NONBLOCK
  localAddr?: { host: string, port: number } | { path: string }
  remoteAddr?: { host: string, port: number } | { path: string }
  options: Map<number, number>  // SO_REUSEADDR, TCP_NODELAY, etc.
  pid: number  // owning process
  readBuffer: Uint8Array[]  // incoming data queue (SOCK_DGRAM: each element = one datagram)
  readWaiters: WaitHandle[]  // unified wait/wake (see K-10)
  writeBuffer: Uint8Array[]  // outgoing data queue (for non-blocking)
  backlog: KernelSocket[]  // pending connections (listening sockets only)
  acceptWaiters: WaitHandle[]
}

SocketTable {
  private sockets: Map<number, KernelSocket>
  private nextSocketId: number
  private listeners: Map<string, KernelSocket>  // "host:port" OR "/vfs/path" → listening socket

  create(domain, type, protocol, pid): number  // returns socket ID
  socketpair(domain, type, protocol, pid): [number, number]  // returns two connected socket IDs
  bind(socketId, addr): void
  listen(socketId, backlog): void
  accept(socketId): KernelSocket | null  // null = EAGAIN
  connect(socketId, addr): void  // in-kernel for loopback, host adapter for external
  shutdown(socketId, how: 'read' | 'write' | 'both'): void  // half-close
  send(socketId, data, flags): number  // bytes sent (SOCK_STREAM)
  sendTo(socketId, data, flags, destAddr): number  // bytes sent (SOCK_DGRAM)
  recv(socketId, maxBytes, flags): Uint8Array | null  // SOCK_STREAM
  recvFrom(socketId, maxBytes, flags): { data: Uint8Array, srcAddr: SockAddr } | null  // SOCK_DGRAM
  close(socketId): void
  poll(socketId): { readable: boolean, writable: boolean, hangup: boolean }
  setsockopt(socketId, level, optname, optval): void
  getsockopt(socketId, level, optname): number
  getLocalAddr(socketId): SockAddr  // getsockname()
  getRemoteAddr(socketId): SockAddr  // getpeername()
}

// Flags for send/recv:
// MSG_PEEK     — read without consuming from buffer
// MSG_DONTWAIT — non-blocking for this single call (regardless of O_NONBLOCK)
// MSG_NOSIGNAL — don't raise SIGPIPE on broken connection

// For SOCK_DGRAM readBuffer: each Uint8Array element is one complete datagram.
// Message boundaries are preserved — two 100-byte sends produce two 100-byte recvs.
// For SOCK_STREAM readBuffer: elements may be coalesced or split at arbitrary boundaries.
// Max UDP datagram size: 65535 bytes. Max receive queue depth: 128 datagrams.

// Wildcard address matching: connect('127.0.0.1', 8080) matches a listener
// bound to '0.0.0.0:8080'. The listeners map must check both exact and wildcard.

// Error semantics for send() on closed connection: EPIPE (+ SIGPIPE unless MSG_NOSIGNAL).
// Error semantics for send() on reset connection: ECONNRESET.
// Error semantics for send() on unconnected SOCK_STREAM: ENOTCONN.
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

### 2.4 Unified Blocking I/O Wait System (K-10)

Currently each blocking operation (pipe read, socket recv, flock, poll) implements its own wait/wake logic. Add a unified `WaitHandle` primitive in `packages/core/src/kernel/wait.ts`:

```
WaitHandle {
  wait(timeoutMs?: number): Promise<void>  // suspends caller until woken or timeout
  wake(): void  // wakes one waiter
  wakeAll(): void  // wakes all waiters
}

WaitQueue {
  private waiters: WaitHandle[]
  enqueue(): WaitHandle  // creates and enqueues a new WaitHandle
  wakeOne(): void
  wakeAll(): void
}
```

All kernel subsystems use `WaitQueue` for blocking:
- **Pipe read** (buffer empty) → `pipeState.readWaiters.enqueue().wait()`
- **Pipe write** (buffer full) → `pipeState.writeWaiters.enqueue().wait()`
- **Socket accept** (no pending connection) → `socket.acceptWaiters.enqueue().wait()`
- **Socket recv** (no data) → `socket.readWaiters.enqueue().wait()`
- **flock** (lock held by another process) → `fileLock.waiters.enqueue().wait()`
- **poll() with timeout -1** → `waitQueue.enqueue().wait()` on each polled FD, race with timeout

**WasmVM integration:** The WasmVM worker thread blocks on `Atomics.wait()` during any syscall. The main thread handler calls `waitQueue.enqueue().wait()` (which is a JS Promise). When the condition is met, `wake()` resolves the Promise, the main thread writes the response to the signal buffer, and `Atomics.notify()` wakes the worker. The existing 30s `RPC_WAIT_TIMEOUT_MS` applies — for indefinite waits (poll timeout -1), the main thread handler loops: wait → timeout → check condition → re-wait.

**Node.js integration:** The Node.js bridge is async. Blocking semantics are implemented via `applySyncPromise` (V8's synchronous Promise resolution). `recv()` returns a Promise that resolves when the WaitHandle is woken. The isolate event loop pumps until the Promise settles.

**Testing:** Standalone test in `packages/core/test/kernel/wait-queue.test.ts`:
- Create WaitHandle, wake it — verify wait() resolves
- Create WaitHandle with timeout — verify it times out
- Multiple waiters, wakeOne — verify only one wakes
- wakeAll — verify all wake
- Wait on pipe read with empty buffer — write data — verify read unblocks
- Wait on flock held by process A — process A unlocks — verify process B unblocks

### 2.5 Inode Layer (K-11)

Add `packages/core/src/kernel/inode-table.ts`:

```
Inode {
  ino: number          // unique inode number
  nlink: number        // hard link count
  openRefCount: number // number of open FDs referencing this inode
  mode: number         // file type + permissions (S_IFREG, S_IFDIR, etc.)
  uid: number
  gid: number
  size: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
}

InodeTable {
  private inodes: Map<number, Inode>
  private nextIno: number

  allocate(mode, uid, gid): Inode
  get(ino: number): Inode | null
  incrementLinks(ino): void     // hard link created
  decrementLinks(ino): void     // hard link or directory entry removed
  incrementOpenRefs(ino): void  // FD opened
  decrementOpenRefs(ino): void  // FD closed — if nlink=0 and openRefCount=0, delete data
  shouldDelete(ino): boolean    // nlink=0 && openRefCount=0
}
```

VFS nodes reference inodes by `ino` number. Multiple directory entries (hard links) share the same inode. `stat()` returns inode metadata.

**Deferred deletion:** When `unlink()` removes the last directory entry (`nlink → 0`) but FDs are still open (`openRefCount > 0`), the inode and its data persist. The file disappears from directory listings but remains accessible via open FDs. When the last FD is closed (`openRefCount → 0`), the inode and data are deleted. `stat()` on an open FD to an unlinked file returns `nlink: 0`.

**Hard links:** `link(existingPath, newPath)` creates a new directory entry pointing to the same inode. `incrementLinks()` bumps `nlink`. Both paths return the same `ino` from `stat()`.

**Integration with FD table:** `ProcessFDTable.open()` calls `inodeTable.incrementOpenRefs(ino)`. `ProcessFDTable.close()` calls `inodeTable.decrementOpenRefs(ino)` and checks `shouldDelete()`.

**Testing:** Standalone test in `packages/core/test/kernel/inode-table.test.ts`:
- Allocate inode, verify ino is unique
- Create hard link — verify nlink increments, both paths return same ino
- Unlink file with open FD — verify data persists, stat returns nlink=0
- Close last FD on unlinked file — verify inode and data are deleted
- stat() on unlinked-but-open file — verify correct metadata

### 2.6 Signal Handler Registry (K-8, expanded)

Expand beyond section 4.8's basic signal delivery to full POSIX sigaction semantics:

```
SignalHandler {
  handler: 'default' | 'ignore' | FunctionPointer  // SIG_DFL, SIG_IGN, or user function
  mask: Set<number>    // signals blocked during handler execution (sa_mask)
  flags: number        // SA_RESTART, SA_NOCLDSTOP, etc.
}

ProcessSignalState {
  handlers: Map<number, SignalHandler>       // signal number → handler
  blockedSignals: Set<number>               // sigprocmask: currently blocked signals
  pendingSignals: Map<number, number>       // signal → count (queued while blocked)
}
```

**sigaction(signal, handler, mask, flags):** Registers a handler for `signal`. When the signal is delivered:
1. If handler is `'ignore'` → signal is discarded
2. If handler is `'default'` → kernel applies default action (SIGTERM→exit, SIGINT→exit, SIGCHLD→ignore, etc.)
3. If handler is a function pointer → kernel invokes it with `sa_mask` signals temporarily blocked

**SA_RESTART:** If a signal interrupts a blocking syscall (recv, accept, read, wait, poll) and SA_RESTART is set, the syscall is restarted automatically after the handler returns. Without SA_RESTART, the syscall returns EINTR.

**sigprocmask(how, set):** `SIG_BLOCK` adds signals to `blockedSignals`, `SIG_UNBLOCK` removes them, `SIG_SETMASK` replaces. Signals delivered while blocked are queued in `pendingSignals`. When unblocked, pending signals are delivered in order (lowest signal number first, per POSIX).

**Signal coalescing:** Standard signals (1-31) are coalesced — if SIGINT is delivered twice while blocked, only one instance is queued. The `pendingSignals` count is capped at 1 for standard signals.

**Testing:** Standalone test in `packages/core/test/kernel/signal-handlers.test.ts`:
- Register SIGINT handler, deliver SIGINT — verify handler called instead of default exit
- SA_RESTART: handler interrupts blocking recv, verify recv restarts
- No SA_RESTART: handler interrupts blocking recv, verify EINTR returned
- sigprocmask SIG_BLOCK SIGINT, deliver SIGINT, verify not delivered until SIG_UNBLOCK
- Two SIGINTs while blocked — verify only one delivered (coalescing)
- SIG_IGN for SIGCHLD — verify child exit doesn't invoke handler

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

### 4.1 Current State

WasmVM ALREADY has TCP/TLS/DNS/poll support, but it **bypasses the kernel entirely** and goes direct to host:

- **Rust WASI extensions** (`native/wasmvm/crates/wasi-ext/src/lib.rs`): `host_net` module with `net_socket`, `net_connect`, `net_send`, `net_recv`, `net_close`, `net_tls_connect`, `net_getaddrinfo`, `net_setsockopt`, `net_poll`
- **C sysroot patches** (`native/wasmvm/patches/wasi-libc/0008-sockets.patch`): `host_socket.c` with libc implementations of `socket()`, `connect()`, `send()`, `recv()`, `poll()`, `select()`, `getaddrinfo()`, `setsockopt()`
- **Kernel worker** (`packages/wasmvm/src/kernel-worker.ts`): `createHostNetImports()` routes network calls through permission check then RPC
- **Driver** (`packages/wasmvm/src/driver.ts`): `_sockets` Map holds real Node.js `net.Socket` objects, `_nextSocketId` counter, handlers for `netSocket`/`netConnect`/`netSend`/`netRecv`/`netClose`/`netTlsConnect`/`netGetaddrinfo`/`netPoll`

**What's missing in WasmVM:**
- `bind()` — no WASI extension (WasmVM #1: no server sockets)
- `listen()` — no WASI extension (WasmVM #1)
- `accept()` — no WASI extension (WasmVM #1)
- `sendto()`/`recvfrom()` — no UDP datagram support (WasmVM #17)
- Unix domain sockets — no AF_UNIX support (WasmVM #2)
- `setsockopt()` — returns ENOSYS (WasmVM #19)
- Signal handlers — no `sigaction()` (WasmVM #9)
- Socket FDs are NOT kernel FDs — stored in driver's `_sockets` Map, separate from kernel FD table

### 4.2 Migration: Route Existing Sockets Through Kernel

The existing WasmVM network path (`kernel-worker.ts` → RPC → `driver.ts` → real host TCP) must be rerouted through the kernel socket table:

**Step 1: Driver stops managing sockets directly**

Current `driver.ts` handlers (`netSocket`, `netConnect`, etc.) manage `_sockets` Map with real Node.js `Socket` objects. After migration:
- `netSocket` → calls `kernel.socketTable.create()` instead of allocating local ID
- `netConnect` → calls `kernel.socketTable.connect()` which handles loopback vs external routing
- `netSend` → calls `kernel.socketTable.send()`
- `netRecv` → calls `kernel.socketTable.recv()`
- `netClose` → calls `kernel.socketTable.close()`
- `netPoll` → calls `kernel.socketTable.poll()` (unified with pipe poll via `kernel.fdPoll()`)

**Step 2: Unify socket FDs with kernel FD table**

Currently WasmVM socket FDs (`_nextSocketId` in driver.ts) and kernel FDs (`localToKernelFd` map in kernel-worker.ts) are separate number spaces. After migration:
- `kernel.socketTable.create()` returns a kernel FD
- Kernel worker maps local WASM FD → kernel socket FD (same `localToKernelFd` map used for files/pipes)
- `poll()` works across file FDs, pipe FDs, and socket FDs in one call

**Step 3: TLS stays in host adapter**

TLS handshake requires OpenSSL — it can't run in-kernel. The kernel socket table delegates TLS to the host adapter:
- `kernel.socketTable.upgradeTls(socketId, hostname)` → host adapter wraps the host-side socket in TLS
- From the kernel's perspective, the socket is still a kernel socket — TLS is transparent

### 4.3 New WASI Extensions for Server Sockets

Add to `native/wasmvm/crates/wasi-ext/src/lib.rs` under `host_net`:

```rust
// New host imports
fn net_bind(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32;
fn net_listen(fd: i32, backlog: i32) -> i32;
fn net_accept(fd: i32, ret_fd: *mut i32, ret_addr: *mut u8, ret_addr_len: *mut u32) -> i32;
fn net_sendto(fd: i32, buf: *const u8, len: u32, flags: i32,
              addr_ptr: *const u8, addr_len: u32, ret_sent: *mut u32) -> i32;
fn net_recvfrom(fd: i32, buf: *mut u8, len: u32, flags: i32,
                ret_addr: *mut u8, ret_addr_len: *mut u32, ret_received: *mut u32) -> i32;
```

Add safe Rust wrappers following the existing pattern (`pub fn bind()`, `pub fn listen()`, etc.).

### 4.4 C Sysroot Patches for Server/UDP/Unix

Extend `native/wasmvm/patches/wasi-libc/0008-sockets.patch` (or create `0009-server-sockets.patch`) to add to `host_socket.c`:

```c
// Server sockets
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    char addr_str[256];
    sockaddr_to_string(addr, addrlen, addr_str, sizeof(addr_str));
    return __host_net_bind(sockfd, addr_str, strlen(addr_str));
}

int listen(int sockfd, int backlog) {
    return __host_net_listen(sockfd, backlog);
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    int new_fd = -1;
    char remote_addr[256];
    uint32_t remote_addr_len = sizeof(remote_addr);
    int err = __host_net_accept(sockfd, &new_fd, remote_addr, &remote_addr_len);
    if (err != 0) { errno = err; return -1; }
    if (addr && addrlen) {
        string_to_sockaddr(remote_addr, remote_addr_len, addr, addrlen);
    }
    return new_fd;
}

// UDP
ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,
               const struct sockaddr *dest_addr, socklen_t addrlen) {
    char addr_str[256];
    sockaddr_to_string(dest_addr, addrlen, addr_str, sizeof(addr_str));
    uint32_t sent = 0;
    int err = __host_net_sendto(sockfd, buf, len, flags, addr_str, strlen(addr_str), &sent);
    if (err != 0) { errno = err; return -1; }
    return (ssize_t)sent;
}

ssize_t recvfrom(int sockfd, void *buf, size_t len, int flags,
                 struct sockaddr *src_addr, socklen_t *addrlen) {
    char addr_str[256];
    uint32_t addr_len = sizeof(addr_str), received = 0;
    int err = __host_net_recvfrom(sockfd, buf, len, flags, addr_str, &addr_len, &received);
    if (err != 0) { errno = err; return -1; }
    if (src_addr && addrlen) {
        string_to_sockaddr(addr_str, addr_len, src_addr, addrlen);
    }
    return (ssize_t)received;
}
```

Also add AF_UNIX support in `sockaddr_to_string()` / `string_to_sockaddr()` — serialize `struct sockaddr_un` path to/from string.

### 4.5 Kernel Worker Updates

In `packages/wasmvm/src/kernel-worker.ts`, update `createHostNetImports()`:

```typescript
// Existing imports route through kernel instead of direct RPC:
net_socket: (domain, type, protocol, ret_fd) => {
    if (isNetworkBlocked()) return ERRNO_EACCES;
    const res = rpcCall('kernelSocketCreate', { domain, type, protocol, pid });
    // ...
},
net_connect: (fd, addr_ptr, addr_len) => {
    const kernelFd = localToKernelFd.get(fd) ?? fd;
    const res = rpcCall('kernelSocketConnect', { socketId: kernelFd, addr });
    // ...
},

// New imports:
net_bind: (fd, addr_ptr, addr_len) => {
    if (isNetworkBlocked()) return ERRNO_EACCES;
    const kernelFd = localToKernelFd.get(fd) ?? fd;
    const addr = decodeString(addr_ptr, addr_len);
    const res = rpcCall('kernelSocketBind', { socketId: kernelFd, addr });
    return res.errno;
},
net_listen: (fd, backlog) => {
    if (isNetworkBlocked()) return ERRNO_EACCES;
    const kernelFd = localToKernelFd.get(fd) ?? fd;
    const res = rpcCall('kernelSocketListen', { socketId: kernelFd, backlog });
    return res.errno;
},
net_accept: (fd, ret_fd, ret_addr, ret_addr_len) => {
    if (isNetworkBlocked()) return ERRNO_EACCES;
    const kernelFd = localToKernelFd.get(fd) ?? fd;
    const res = rpcCall('kernelSocketAccept', { socketId: kernelFd });
    if (res.errno !== 0) return res.errno;
    // Map new kernel socket FD to local FD
    const localFd = nextLocalFd++;
    localToKernelFd.set(localFd, res.intResult);
    writeI32(ret_fd, localFd);
    // Write remote address to ret_addr buffer
    return 0;
},
net_sendto: (fd, buf, len, flags, addr_ptr, addr_len, ret_sent) => {
    // ... permission check, decode, rpcCall('kernelSocketSendTo', ...)
},
net_recvfrom: (fd, buf, len, flags, ret_addr, ret_addr_len, ret_received) => {
    // ... rpcCall('kernelSocketRecvFrom', ...), blocks via Atomics.wait
},
```

### 4.6 Driver Updates

In `packages/wasmvm/src/driver.ts`, replace socket handlers with kernel delegation:

```typescript
// Remove: _sockets Map, _nextSocketId counter
// Replace handlers with kernel calls:

case 'kernelSocketCreate':
    return kernel.socketTable.create(args.domain, args.type, args.protocol, args.pid);
case 'kernelSocketBind':
    return kernel.socketTable.bind(args.socketId, parseAddr(args.addr));
case 'kernelSocketListen':
    return kernel.socketTable.listen(args.socketId, args.backlog);
case 'kernelSocketAccept':
    return kernel.socketTable.accept(args.socketId);  // blocks until connection or EAGAIN
case 'kernelSocketConnect':
    return kernel.socketTable.connect(args.socketId, parseAddr(args.addr));
case 'kernelSocketSendTo':
    return kernel.socketTable.sendTo(args.socketId, args.data, args.flags, parseAddr(args.addr));
case 'kernelSocketRecvFrom':
    return kernel.socketTable.recvFrom(args.socketId, args.maxBytes, args.flags);
```

### 4.7 Blocking Semantics

WasmVM uses `Atomics.wait()` to block the worker thread during syscalls. For blocking socket operations:

- **`accept()`**: If no pending connection, the main thread handler waits for a kernel socket event (connection arrival) before responding. The worker thread stays blocked on `Atomics.wait()`. Timeout: 30s (existing `RPC_WAIT_TIMEOUT_MS`).
- **`recv()`**: If no data in kernel buffer, main thread waits for data or EOF. Same blocking pattern.
- **`connect()` to external**: Main thread creates host TCP connection, waits for connect event, then responds.
- **`connect()` to loopback**: Kernel instantly connects via in-kernel routing — no host wait.
- **Non-blocking mode**: If `O_NONBLOCK` is set on the socket, kernel returns `EAGAIN` immediately instead of blocking. The WASM program uses `poll()` to wait for readiness.

### 4.8 Signal Handler Delivery

WASM cannot be interrupted mid-execution. Signals must be delivered cooperatively:

1. **Registration**: Add `net_sigaction` WASI extension. WASM program calls `sigaction(SIGINT, handler, NULL)`. Kernel worker stores handler function pointer + signal mask in kernel process table entry.

2. **Delivery**: When kernel delivers a signal to a WasmVM process:
   - Kernel sets a `pendingSignals` bitmask on the process entry
   - At next syscall boundary (any `rpcCall` from worker), kernel worker checks `pendingSignals`
   - If signal pending and handler registered: worker invokes the WASM handler function via `instance.exports.__wasi_signal_trampoline(signum)` before returning from the syscall
   - If no handler: default behavior (SIGTERM → exit, SIGINT → exit, etc.)

3. **Trampoline**: The C sysroot patch adds a `__wasi_signal_trampoline` export that dispatches to the registered `sigaction` handler. This is called from the JS worker side when a signal is pending.

4. **Limitations**:
   - Signals only delivered at syscall boundaries — long-running compute without syscalls won't see signals (WasmVM #10, fundamental WASM limitation)
   - `SIGKILL` always terminates immediately (kernel-enforced, no handler invocation)
   - `SIGSTOP`/`SIGCONT` handled by kernel process table, not user handlers

### 4.9 WasmVM-Specific Tests

Add to existing test files:

```
packages/wasmvm/test/
  net-socket.test.ts          # UPDATE: migrate existing tests to use kernel sockets
  net-server.test.ts          # NEW: bind/listen/accept, loopback server
  net-udp.test.ts             # NEW: UDP send/recv, message boundaries
  net-unix.test.ts            # NEW: Unix domain sockets via VFS paths
  net-cross-runtime.test.ts   # NEW: WasmVM server ↔ Node.js client and vice versa
  signal-handler.test.ts      # NEW: sigaction registration, cooperative delivery
```

**C test programs** (compiled to WASM):

```
native/wasmvm/c/programs/
  tcp_server.c        # bind → listen → accept → recv → send → close
  tcp_client.c        # socket → connect → send → recv → close
  udp_echo.c          # socket(SOCK_DGRAM) → bind → recvfrom → sendto
  unix_socket.c       # socket(AF_UNIX) → bind → listen → accept
  signal_handler.c    # sigaction(SIGINT, handler) → busy loop → verify handler called
```

These programs are built via `native/wasmvm/c/Makefile` (add to `PATCHED_PROGRAMS` since they use `host_net` imports) and tested via the WasmVM driver in vitest.

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
  setOption(level: number, optname: number, optval: number): void  // forward kernel socket options
  shutdown(how: 'read' | 'write' | 'both'): void  // TCP FIN
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
  socket-table.test.ts        # K-1: Socket lifecycle, state transitions, EMFILE, socketpair
  loopback.test.ts            # K-2: In-kernel client↔server routing, wildcard address matching
  server-socket.test.ts       # K-3: listen/accept, backlog, EADDRINUSE
  udp-socket.test.ts          # K-4: Datagram send/recv, message boundaries, max dgram size
  unix-socket.test.ts         # K-5: VFS-path binding, stream + dgram modes, socketpair
  network-permissions.test.ts # K-7: Deny-by-default, loopback exemption
  wait-queue.test.ts          # K-10: Unified wait/wake, pipe blocking, flock blocking
  inode-table.test.ts         # K-11: Inode alloc, hard links, deferred unlink, refcount
  signal-handlers.test.ts     # K-8: sigaction, SA_RESTART, sigprocmask, coalescing
  timer-table.test.ts         # Timer lifecycle, budgets, process cleanup
  dns-cache.test.ts           # Cache hit/miss, TTL, flush
  socket-shutdown.test.ts     # shutdown() half-close, read-closed/write-closed states
  socket-flags.test.ts        # MSG_PEEK, MSG_DONTWAIT, MSG_NOSIGNAL, O_NONBLOCK
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

1. **Unified wait/wake system** (K-10) — foundation for all blocking I/O
2. **Inode layer** (K-11) — foundation for correct VFS semantics (deferred unlink, hard links)
3. **Socket table + loopback + shutdown** (K-1, K-2, K-3) — core networking, depends on K-10 for blocking
4. **Network permissions** (K-7) — must exist before exposing sockets to runtimes
5. **FD table unification** (N-1) — sockets need to share the FD number space with files/pipes
6. **Node.js net socket migration** (N-4) — migrate existing Node.js sockets to kernel
7. **Node.js HTTP server migration** (N-2, N-3) — highest ROI, unlocks 492 tests
8. **WasmVM socket migration** — route existing WasmVM sockets through kernel
9. **WasmVM server sockets** — add bind/listen/accept WASI extensions
10. **UDP sockets** (K-4) — unlocks 76 dgram tests + WasmVM #17
11. **Unix domain sockets + socketpair** (K-5) — unlocks WasmVM #2
12. **Signal handler registry** (K-8) — sigaction, SA_RESTART, sigprocmask, cooperative WASM delivery
13. **Socket flags** — MSG_PEEK, MSG_DONTWAIT, MSG_NOSIGNAL, expanded setsockopt
14. **Timer/handle migration** (N-5, N-7, N-8) — cleanup, kernel-enforced budgets
15. **VFS change notifications** (K-9) — fs.watch support
16. **DNS cache** (N-10) — shared across runtimes
17. **Crypto session cleanup** (N-12) — lowest priority

---

## Part 7: Proofing

After the kernel networking consolidation is implemented, a full audit must be performed before the work is considered complete.

### 7.1 Implementation Review

An adversarial review agent must verify:

1. **Kernel completeness**: Every socket operation (create, bind, listen, accept, connect, send, recv, sendto, recvfrom, close, poll, setsockopt, getsockopt) works in the kernel standalone tests without any runtime attached.

2. **Node.js migration completeness**: No networking code remains in the Node.js bridge that bypasses the kernel. Specifically verify:
   - `packages/nodejs/src/driver.ts` has no `servers` Map, no `ownedServerPorts` Set, no `netSockets` Map, no `upgradeSockets` Map
   - `packages/nodejs/src/bridge/network.ts` has no `serverRequestListeners` Map, no `activeNetSockets` Map
   - `packages/nodejs/src/bridge-handlers.ts` has no socket Maps
   - All `http.createServer()` calls route through `kernel.socketTable.listen()`
   - All `net.connect()` calls route through `kernel.socketTable.connect()`
   - SSRF validation is in the kernel, not the host adapter

3. **WasmVM migration completeness**: No networking code remains in the WasmVM driver that bypasses the kernel. Specifically verify:
   - `packages/wasmvm/src/driver.ts` has no `_sockets` Map, no `_nextSocketId` counter
   - All `netSocket`/`netConnect`/`netSend`/`netRecv`/`netClose` handlers delegate to kernel
   - New handlers exist for `kernelSocketBind`, `kernelSocketListen`, `kernelSocketAccept`, `kernelSocketSendTo`, `kernelSocketRecvFrom`
   - Socket FDs are unified with kernel FD table (no separate number space)
   - `net_bind`, `net_listen`, `net_accept`, `net_sendto`, `net_recvfrom` WASI extensions exist in `lib.rs`
   - C sysroot patches exist for `bind()`, `listen()`, `accept()`, `sendto()`, `recvfrom()`
   - `setsockopt()` no longer returns ENOSYS for supported options

4. **Loopback routing**: Verify that a server in one runtime can accept connections from another runtime without any real TCP:
   - Node.js `http.createServer()` on port 8080 → WasmVM `curl http://localhost:8080` works
   - WasmVM `tcp_server` on port 9090 → Node.js `net.connect(9090)` works
   - Neither connection touches the host network stack

5. **Permission enforcement**: Verify deny-by-default for all socket operations through the kernel, for both runtimes.

6. **Signal delivery**: Verify WasmVM signal handlers fire at syscall boundaries for SIGINT, SIGTERM, SIGUSR1.

7. **Resource cleanup**: Verify all sockets, timers, and handles are cleaned up when a process exits, for both runtimes.

### 7.2 Conformance Re-test

After kernel migration:

1. Run the full Node.js conformance suite (`packages/secure-exec/tests/node-conformance/runner.test.ts`)
2. Run the full WasmVM test suite (`packages/wasmvm/test/`)
3. Run the full POSIX conformance suite if socket-related os-tests exist
4. Run the project-matrix suite (`packages/secure-exec/tests/projects/`)

### 7.3 Expectations Update

Tests that were blocked by networking gaps should be re-tested and reclassified:

1. Re-run all 492 FIX-01 (HTTP server) tests — remove expectations for tests that now pass
2. Re-run all 76 dgram tests — remove expectations for tests that now pass
3. Re-run https/tls/net/http2 glob tests — reclassify from `unsupported-module` to specific failure reasons
4. Update `docs-internal/nodejs-compat-roadmap.md` with new pass counts
5. Regenerate conformance report (`scripts/generate-report.ts`)

### 7.4 PRD Update via Ralph

After the review, any remaining gaps, regressions, or incomplete items must be captured as new stories in `scripts/ralph/prd.json`:

1. Load the Ralph skill (`/ralph`)
2. For each gap found during proofing:
   - Create a new user story with specific acceptance criteria
   - Include the exact test names that are still failing
   - Reference the kernel component that needs fixing
3. Stories should be right-sized for one Ralph iteration (one context window)
4. Set priorities sequentially after existing stories
5. Ralph then executes the remaining stories autonomously until all pass

This ensures no gaps are left undocumented and the work converges to completion through automated iteration.
