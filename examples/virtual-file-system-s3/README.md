# S3 Filesystem Driver Example

A custom filesystem driver backed by S3 (or any S3-compatible store like [MinIO](https://min.io)). Sandboxed code uses `fs.readFileSync`, `fs.writeFileSync`, and other Node.js filesystem APIs as normal — all I/O is transparently routed to S3 objects.

[Docs](https://secureexec.dev/docs) | [GitHub](https://github.com/rivet-dev/secure-exec)

## Start the test server

Run MinIO locally with Docker:

```bash
docker compose up -d
```

Or without Docker Compose:

```bash
docker run -d -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

MinIO console is available at http://localhost:9001 (login: minioadmin / minioadmin).

## Run the example

```bash
pnpm install
pnpm test
```

This creates a `NodeRuntime` with the S3-backed filesystem, runs sandboxed code that writes and reads files, then verifies the data was persisted to MinIO via the S3 API.

## How it works

- `S3FileSystem` implements the `VirtualFileSystem` interface from `secure-exec`
- Files are stored as S3 objects keyed by their path (leading `/` stripped)
- Directories are inferred from key prefixes; `mkdir` creates empty marker objects
- `readDir` uses `ListObjectsV2` with delimiter-based prefix listing
- Symlinks and hard links throw `ENOSYS` (not practical for object storage)
- `chmod`, `chown`, `utimes` are no-ops (S3 doesn't have POSIX permissions)

## Use cases

- **Persistent sandboxes**: User-generated code writes files that survive across sessions
- **Multi-tenant isolation**: Each sandbox gets its own S3 prefix or bucket
- **Cloud-native deployments**: Store sandbox artifacts in the same object store as your application
