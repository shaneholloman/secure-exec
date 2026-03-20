# SQLite Filesystem Driver Example

A custom filesystem driver backed by a SQLite database (via [sql.js](https://github.com/sql-js/sql.js) / WASM). Sandboxed code uses `fs.readFileSync`, `fs.writeFileSync`, and other Node.js filesystem APIs as normal — all I/O is transparently stored as rows in a single SQLite table.

No native compilation required — sql.js runs SQLite as WASM.

[Docs](https://secureexec.dev/docs) | [GitHub](https://github.com/rivet-dev/secure-exec)

## Run the example

No external services needed:

```bash
pnpm install
pnpm test
```

This creates a `NodeRuntime` with the SQLite-backed filesystem, runs sandboxed code that writes and reads files, then verifies the data was persisted to the database.

## How it works

- `SQLiteFileSystem` implements the `VirtualFileSystem` interface from `secure-exec`
- All files, directories, and symlinks are stored in a single `entries` table
- File content is stored as `BLOB`, metadata as columns (`mode`, timestamps, etc.)
- Supports symlinks (with cycle detection), hard links, `chmod`, `utimes`, and `truncate`
- Use `SQLiteFileSystem.create()` for a fresh database, or pass existing bytes to restore a snapshot
- Call `.export()` to get the database as `Uint8Array` for persistence

## Schema

```sql
CREATE TABLE entries (
  path         TEXT PRIMARY KEY,
  content      BLOB,
  mode         INTEGER NOT NULL DEFAULT 33188,
  is_dir       INTEGER NOT NULL DEFAULT 0,
  is_symlink   INTEGER NOT NULL DEFAULT 0,
  link_target  TEXT,
  atime_ms     REAL NOT NULL,
  mtime_ms     REAL NOT NULL,
  ctime_ms     REAL NOT NULL,
  birthtime_ms REAL NOT NULL
)
```

## Use cases

- **Snapshotting**: Call `.export()` to serialize the entire filesystem state, restore later with `SQLiteFileSystem.create(bytes)`
- **Auditing**: Query the database to inspect what files sandboxed code created or modified
- **Embedded applications**: No external service dependencies — runs entirely in-process
- **Testing**: Fast, disposable in-memory filesystems with full POSIX semantics
