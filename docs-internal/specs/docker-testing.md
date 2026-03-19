# E2E Docker Testing Spec

## Problem

The project-matrix test suite validates that npm packages **load and construct** identically in secure-exec and host Node.js. But for service-oriented packages (pg, mysql2, ioredis, ssh2, ssh2-sftp-client, ws), the fixtures only verify `require()` succeeds and classes have the right prototype methods — they never make a real connection. This leaves a gap: the sandbox could silently break at the protocol/transport layer without any test catching it.

## Goal

Add a Docker-backed e2e test layer that:

1. Spins up real services (Postgres, MySQL, Redis, SSH/SFTP) in containers
2. Executes **real operations** against them from inside the secure-exec sandbox
3. Compares results between host Node.js and secure-exec (same parity model as project-matrix)
4. Skips gracefully when Docker is unavailable (local dev without Docker, CI without Docker services)

## Design Principles

- **Reuse existing infrastructure**: `tests/utils/docker.ts` already has `startContainer()`, health checks, and `skipUnlessDocker()`. Build on it.
- **Black-box fixtures**: Same contract as project-matrix — fixtures are normal Node.js projects with no sandbox-specific code.
- **Parity testing**: Each fixture runs against both host Node.js and secure-exec. Normalized stdout/stderr/exit code must match.
- **No Docker in default CI**: Tests skip via `skipUnlessDocker()` unless a CI job explicitly enables Docker services. A separate CI workflow handles Docker tests.

## Architecture

```
tests/
├── e2e-docker.test.ts              # Test runner (discovers + runs fixtures)
├── e2e-docker/                     # Fixture projects
│   ├── pg-connect/                 # Real Postgres operations
│   │   ├── fixture.json
│   │   ├── package.json
│   │   └── src/index.js
│   ├── mysql2-connect/             # Real MySQL operations
│   │   ├── fixture.json
│   │   ├── package.json
│   │   └── src/index.js
│   ├── ioredis-connect/            # Real Redis operations
│   │   ├── fixture.json
│   │   ├── package.json
│   │   └── src/index.js
│   ├── ssh2-connect/               # Real SSH session
│   │   ├── fixture.json
│   │   ├── package.json
│   │   └── src/index.js
│   └── ssh2-sftp-transfer/         # Real SFTP file transfer
│       ├── fixture.json
│       ├── package.json
│       └── src/index.js
└── utils/
    └── docker.ts                   # Existing (no changes needed)
```

## Container Specifications

### PostgreSQL

| Property | Value |
| --- | --- |
| Image | `postgres:16-alpine` |
| Container port | 5432 |
| Host port | 0 (auto-assign) |
| Env | `POSTGRES_USER=testuser`, `POSTGRES_PASSWORD=testpass`, `POSTGRES_DB=testdb` |
| Health check | `pg_isready -U testuser -d testdb` |
| Health timeout | 30s |
| Extra args | `--tmpfs /var/lib/postgresql/data` (RAM-backed for speed) |

### MySQL

| Property | Value |
| --- | --- |
| Image | `mysql:8.0` |
| Container port | 3306 |
| Host port | 0 (auto-assign) |
| Env | `MYSQL_ROOT_PASSWORD=rootpass`, `MYSQL_DATABASE=testdb`, `MYSQL_USER=testuser`, `MYSQL_PASSWORD=testpass` |
| Health check | `mysql -u testuser -ptestpass -e "SELECT 1"` |
| Health timeout | 60s (MySQL is slow to init) |
| Extra args | `--tmpfs /var/lib/mysql` |

### Redis

| Property | Value |
| --- | --- |
| Image | `redis:7-alpine` |
| Container port | 6379 |
| Host port | 0 (auto-assign) |
| Health check | `redis-cli ping` |
| Health timeout | 15s |

### SSH / SFTP

| Property | Value |
| --- | --- |
| Image | Custom Alpine (see below) |
| Container port | 22 |
| Host port | 0 (auto-assign) |
| Auth | Password-based: `testuser` / `testpass` |
| Health check | `ssh-keyscan -p 22 127.0.0.1` (run from host, not docker exec) — or `sshd -t` inside container |
| Health timeout | 15s |

**SSH Dockerfile** (`tests/e2e-docker/dockerfiles/sshd.Dockerfile`):

```dockerfile
FROM alpine:3.19
RUN apk add --no-cache openssh \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh testuser \
 && echo "testuser:testpass" | chpasswd \
 && sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#PermitEmptyPasswords.*/PermitEmptyPasswords no/' /etc/ssh/sshd_config \
 && mkdir -p /home/testuser/upload
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
```

We build this image once per test run and tag it `secure-exec-test-sshd:latest`. The `startContainer` helper needs a small extension to support building from a Dockerfile (or we build it in the test setup with `docker build`).

## Fixture Designs

### `pg-connect`

```js
const { Client } = require("pg");

async function main() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: "testuser",
    password: "testpass",
    database: "testdb",
  });

  await client.connect();

  // Create table, insert, query, drop
  await client.query("CREATE TABLE IF NOT EXISTS test_e2e (id SERIAL PRIMARY KEY, value TEXT)");
  await client.query("INSERT INTO test_e2e (value) VALUES ($1)", ["hello-sandbox"]);
  const res = await client.query("SELECT value FROM test_e2e WHERE value = $1", ["hello-sandbox"]);
  await client.query("DROP TABLE test_e2e");
  await client.end();

  console.log(JSON.stringify({
    connected: true,
    rowCount: res.rowCount,
    value: res.rows[0].value,
  }));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

**What this proves**: TCP connection through `net` bridge → Postgres wire protocol → parameterized queries → result parsing. All through the sandbox's network adapter.

### `mysql2-connect`

```js
const mysql = require("mysql2/promise");

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT),
    user: "testuser",
    password: "testpass",
    database: "testdb",
  });

  await conn.execute("CREATE TABLE IF NOT EXISTS test_e2e (id INT AUTO_INCREMENT PRIMARY KEY, value VARCHAR(255))");
  await conn.execute("INSERT INTO test_e2e (value) VALUES (?)", ["hello-sandbox"]);
  const [rows] = await conn.execute("SELECT value FROM test_e2e WHERE value = ?", ["hello-sandbox"]);
  await conn.execute("DROP TABLE test_e2e");
  await conn.end();

  console.log(JSON.stringify({
    connected: true,
    rowCount: rows.length,
    value: rows[0].value,
  }));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

**What this proves**: MySQL binary protocol over TCP, prepared statements, type coercion through the sandbox bridge.

### `ioredis-connect`

```js
const Redis = require("ioredis");

async function main() {
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    lazyConnect: false,
  });

  // Basic set/get
  await redis.set("e2e:key", "hello-sandbox");
  const value = await redis.get("e2e:key");

  // Pipeline
  const pipeline = redis.pipeline();
  pipeline.set("e2e:p1", "a");
  pipeline.set("e2e:p2", "b");
  pipeline.get("e2e:p1");
  pipeline.get("e2e:p2");
  const pipeResults = await pipeline.exec();

  // Cleanup
  await redis.del("e2e:key", "e2e:p1", "e2e:p2");
  await redis.quit();

  console.log(JSON.stringify({
    connected: true,
    value,
    pipelineP1: pipeResults[2][1],
    pipelineP2: pipeResults[3][1],
  }));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

**What this proves**: Redis RESP protocol over TCP, pipelining, command serialization through the sandbox bridge.

### `ssh2-connect`

```js
const { Client } = require("ssh2");

async function main() {
  const result = await new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.exec("echo hello-from-sandbox && whoami", (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";

        stream.on("data", (data) => { stdout += data.toString(); });
        stream.stderr.on("data", (data) => { stderr += data.toString(); });
        stream.on("close", (code) => {
          conn.end();
          resolve({ connected: true, code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
    });

    conn.on("error", reject);

    conn.connect({
      host: process.env.SSH_HOST,
      port: Number(process.env.SSH_PORT),
      username: "testuser",
      password: "testpass",
    });
  });

  console.log(JSON.stringify(result));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

**What this proves**: SSH handshake (key exchange, auth) over TCP, channel multiplexing, remote command execution, stream I/O — all through the sandbox's `net` bridge. This is the hardest test because SSH uses complex binary framing, crypto negotiation, and bidirectional streaming.

### `ssh2-sftp-transfer`

```js
const { Client } = require("ssh2");

async function main() {
  const result = await new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);

        const remotePath = "/home/testuser/upload/test-e2e.txt";
        const content = "hello-sftp-sandbox";

        // Write file
        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.end(content, () => {
          // Read it back
          sftp.readFile(remotePath, "utf8", (err, data) => {
            if (err) return reject(err);

            // Stat it
            sftp.stat(remotePath, (err, stats) => {
              if (err) return reject(err);

              // Delete it
              sftp.unlink(remotePath, (err) => {
                conn.end();
                if (err) return reject(err);
                resolve({
                  connected: true,
                  written: content,
                  readBack: data,
                  match: data === content,
                  size: stats.size,
                });
              });
            });
          });
        });
      });
    });

    conn.on("error", reject);

    conn.connect({
      host: process.env.SSH_HOST,
      port: Number(process.env.SSH_PORT),
      username: "testuser",
      password: "testpass",
    });
  });

  console.log(JSON.stringify(result));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

**What this proves**: SFTP subsystem negotiation, file write/read/stat/unlink over the SSH channel, binary stream correctness through the sandbox bridge.

## Test Runner Design

`tests/e2e-docker.test.ts` follows the same pattern as `project-matrix.test.ts` but with service lifecycle:

```
describe("e2e-docker")
  beforeAll:
    - Skip if Docker unavailable (skipUnlessDocker)
    - Build SSH image (docker build)
    - Start all containers in parallel
    - Wait for all health checks
    - Store connection details (host:port) for each service

  for each fixture:
    it("parity: <fixture-name>"):
      - Install fixture deps (npm install in fixture dir, cached)
      - Run fixture in host Node.js with service env vars (PG_HOST, PG_PORT, etc.)
      - Run fixture in secure-exec with same env vars
      - Compare normalized stdout/stderr/exit code

  afterAll:
    - Stop all containers
```

### Environment Variables

Each fixture receives connection details via environment variables. The test runner sets these based on the container's resolved host/port:

| Variable | Source |
| --- | --- |
| `PG_HOST` | `pgContainer.host` (always `127.0.0.1`) |
| `PG_PORT` | `pgContainer.port` (auto-assigned) |
| `MYSQL_HOST` | `mysqlContainer.host` |
| `MYSQL_PORT` | `mysqlContainer.port` |
| `REDIS_HOST` | `redisContainer.host` |
| `REDIS_PORT` | `redisContainer.port` |
| `SSH_HOST` | `sshContainer.host` |
| `SSH_PORT` | `sshContainer.port` |

The secure-exec runtime passes these through via `permissions.env` (allowAllEnv in the fixture config).

### Fixture Metadata

Same schema as project-matrix, with an added `services` field:

```json
{
  "entry": "src/index.js",
  "expectation": "pass",
  "services": ["postgres"]
}
```

The `services` array tells the runner which containers this fixture needs. Only those containers' env vars are injected.

Valid service names: `postgres`, `mysql`, `redis`, `ssh`.

## Parity Model

Same as project-matrix:

1. Run fixture against host Node.js → capture `{ code, stdout, stderr }`
2. Run fixture in secure-exec → capture `{ code, stdout, stderr }`
3. Normalize paths and timing-sensitive output
4. Assert `code`, `stdout`, `stderr` match

**Important**: Each fixture must produce **deterministic output**. This means:
- No timestamps in output
- No random values (use seeded or known inputs)
- Clean up test data after each run (DROP TABLE, DEL keys, unlink files) so reruns are idempotent
- Sort any unordered results before printing

## Isolation Between Runs

Each parity run (host vs sandbox) hits the same container. To avoid cross-contamination:

- Host run creates/drops its own tables/keys
- Sandbox run creates/drops its own tables/keys
- Fixture code is self-contained — it cleans up after itself

If needed, fixtures can use unique prefixes (`host_` vs `sandbox_`) in table/key names, but since runs are sequential and each fixture drops its own state, this should be unnecessary.

## Docker Utility Extensions

The existing `docker.ts` needs one addition:

### `buildImage(dockerfilePath, tag)`

```typescript
export function buildImage(dockerfilePath: string, tag: string): void {
  execFileSync("docker", [
    "build", "-t", tag, "-f", dockerfilePath,
    path.dirname(dockerfilePath),
  ], { stdio: "ignore", timeout: 120_000 });
}
```

This is needed for the custom SSH Dockerfile. All other services use published images.

## CI Integration

### New workflow: `.github/workflows/e2e-docker.yml`

```yaml
name: E2E Docker Tests
on:
  pull_request:
  push:
    branches: [main]

jobs:
  e2e-docker:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: testdb
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U testuser -d testdb"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: rootpass
          MYSQL_DATABASE: testdb
          MYSQL_USER: testuser
          MYSQL_PASSWORD: testpass
        ports:
          - 3306:3306
        options: >-
          --health-cmd "mysql -u testuser -ptestpass -e 'SELECT 1'"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 10
          --health-start-period 30s
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install
      - run: pnpm turbo build
      # Build SSH test image
      - run: docker build -t secure-exec-test-sshd -f packages/secure-exec/tests/e2e-docker/dockerfiles/sshd.Dockerfile packages/secure-exec/tests/e2e-docker/dockerfiles/
      - run: |
          docker run -d --name test-sshd -p 2222:22 secure-exec-test-sshd
          # Wait for sshd
          for i in $(seq 1 30); do
            docker exec test-sshd sh -c "ss -tlnp | grep -q :22" && break || sleep 1
          done
      - name: Run e2e Docker tests
        run: pnpm --filter secure-exec vitest run tests/e2e-docker.test.ts
        env:
          PG_HOST: 127.0.0.1
          PG_PORT: 5432
          MYSQL_HOST: 127.0.0.1
          MYSQL_PORT: 3306
          REDIS_HOST: 127.0.0.1
          REDIS_PORT: 6379
          SSH_HOST: 127.0.0.1
          SSH_PORT: 2222
          E2E_DOCKER_CI: "true"
```

When `E2E_DOCKER_CI=true`, the test runner skips container startup/teardown and reads connection details from env vars (GitHub Actions manages the containers via `services:`).

When running locally, the test runner manages containers itself via `startContainer()`.

## Timeout Budget

| Phase | Timeout |
| --- | --- |
| Container startup (all) | 90s total (parallel start, MySQL dominates) |
| Health check per container | 15-60s (see container specs) |
| Fixture dep install | 30s per fixture (cached after first run) |
| Fixture execution (host) | 30s |
| Fixture execution (sandbox) | 30s |
| **Total per fixture** | ~60s execution + install |
| **Total test suite** | ~5 min (containers + 5 fixtures × ~60s) |

## Test Script

Add to `packages/secure-exec/package.json`:

```json
"test:e2e-docker": "vitest run tests/e2e-docker.test.ts"
```

## Dependency on `net` Bridge

**Critical blocker**: The `net` module is currently Tier 4 (Deferred) — `require('net')` works but `net.connect()` throws. Postgres, MySQL, Redis, and SSH all use TCP sockets via `net.connect()`.

This means:
- **Host Node.js runs will work** (they use real `net`)
- **Secure-exec runs will fail** until `net` is promoted to Tier 1 (Bridge)

Two options:

1. **Wait for `net` bridge**: Write the fixtures now, expect them to fail in sandbox. The tests serve as a forcing function and regression gate for when `net` is implemented.
2. **Use HTTP-based alternatives first**: Some services have HTTP APIs (Redis has REST proxies, Postgres has PostgREST). But this defeats the purpose of testing the real client libraries.

**Recommendation**: Option 1. Write the fixtures now. Mark them with `expectation: "fail"` with `stderrIncludes: "net.connect is not supported"` (or similar) until the `net` bridge lands. When `net` is implemented, flip them to `expectation: "pass"` — they become instant regression tests.

## Open Questions

1. **WebSocket e2e**: The existing `ws-pass` fixture already does real WebSocket I/O in-process. Should we add an external WebSocket server container, or is the in-process test sufficient?
2. **Connection pooling**: Should any fixture test connection pool behavior (multiple concurrent queries through a pool)? This would stress the sandbox's event loop and async bridge more aggressively.
3. **TLS connections**: Postgres and MySQL support TLS. Should we add TLS-enabled variants to test the `tls` bridge when it lands?
4. **Container reuse across fixtures**: Should all fixtures in a given service group share one container (faster) or each get their own (more isolated)? Recommendation: share, since fixtures clean up after themselves.

