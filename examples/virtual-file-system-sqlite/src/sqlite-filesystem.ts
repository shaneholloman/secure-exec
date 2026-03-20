import type { VirtualFileSystem } from "secure-exec";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";

/**
 * A VirtualFileSystem backed by a SQLite database (via sql.js / WASM).
 *
 * All files, directories, and symlinks are stored in a single `entries` table.
 * Supports symlinks (with cycle detection), hard links, chmod, utimes, and truncate.
 *
 * No native compilation required — sql.js runs SQLite as WASM.
 */
export class SQLiteFileSystem implements VirtualFileSystem {
	private db: SqlJsDatabase;

	private constructor(db: SqlJsDatabase) {
		this.db = db;
	}

	/**
	 * Create a new SQLiteFileSystem.
	 * Optionally pass existing database bytes to restore from a snapshot.
	 */
	static async create(data?: ArrayLike<number>): Promise<SQLiteFileSystem> {
		const SQL = await initSqlJs();
		const db = data ? new SQL.Database(data) : new SQL.Database();

		db.run(`
			CREATE TABLE IF NOT EXISTS entries (
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
		`);

		// Ensure root directory exists
		const now = Date.now();
		db.run(
			`INSERT OR IGNORE INTO entries
			(path, content, mode, is_dir, atime_ms, mtime_ms, ctime_ms, birthtime_ms)
			VALUES ('/', NULL, 16877, 1, ?, ?, ?, ?)`,
			[now, now, now, now],
		);

		return new SQLiteFileSystem(db);
	}

	/** Export the database as bytes (for snapshotting / persistence). */
	export(): Uint8Array {
		return this.db.export();
	}

	async readFile(path: string): Promise<Uint8Array> {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, open '${path}'`,
			);
		if (row.is_dir)
			throw new Error(
				`EISDIR: illegal operation on a directory, read '${path}'`,
			);
		return new Uint8Array(row.content as Uint8Array);
	}

	async readTextFile(path: string): Promise<string> {
		const bytes = await this.readFile(path);
		return new TextDecoder().decode(bytes);
	}

	async readDir(path: string): Promise<string[]> {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, scandir '${path}'`,
			);
		if (!row.is_dir)
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);

		const prefix = path === "/" ? "/" : path + "/";
		return this.#queryChildren(prefix).map((r) =>
			(r.path as string).slice(prefix.length),
		);
	}

	async readDirWithTypes(
		path: string,
	): Promise<Array<{ name: string; isDirectory: boolean }>> {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, scandir '${path}'`,
			);
		if (!row.is_dir)
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);

		const prefix = path === "/" ? "/" : path + "/";
		return this.#queryChildren(prefix).map((r) => ({
			name: (r.path as string).slice(prefix.length),
			isDirectory: r.is_dir === 1,
		}));
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
	): Promise<void> {
		const data =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: content;
		const now = Date.now();

		await this.mkdir(dirname(path));

		if (this.#exists(path)) {
			this.db.run(
				`UPDATE entries SET content = ?, mode = 33188, is_dir = 0,
				is_symlink = 0, link_target = NULL, mtime_ms = ?, ctime_ms = ?
				WHERE path = ?`,
				[data, now, now, path],
			);
		} else {
			this.db.run(
				`INSERT INTO entries
				(path, content, mode, is_dir, atime_ms, mtime_ms, ctime_ms, birthtime_ms)
				VALUES (?, ?, 33188, 0, ?, ?, ?, ?)`,
				[path, data, now, now, now, now],
			);
		}
	}

	async createDir(path: string): Promise<void> {
		const parent = dirname(path);
		if (!this.#getEntry(parent))
			throw new Error(
				`ENOENT: no such file or directory, mkdir '${path}'`,
			);

		const now = Date.now();
		this.db.run(
			`INSERT OR IGNORE INTO entries
			(path, content, mode, is_dir, atime_ms, mtime_ms, ctime_ms, birthtime_ms)
			VALUES (?, NULL, 16877, 1, ?, ?, ?, ?)`,
			[path, now, now, now, now],
		);
	}

	async mkdir(path: string): Promise<void> {
		const parts = path.split("/").filter(Boolean);
		let current = "";
		const now = Date.now();
		for (const part of parts) {
			current += "/" + part;
			this.db.run(
				`INSERT OR IGNORE INTO entries
				(path, content, mode, is_dir, atime_ms, mtime_ms, ctime_ms, birthtime_ms)
				VALUES (?, NULL, 16877, 1, ?, ?, ?, ?)`,
				[current, now, now, now, now],
			);
		}
	}

	async exists(path: string): Promise<boolean> {
		return this.#exists(path);
	}

	async stat(path: string) {
		const resolved = this.#resolveSymlink(path);
		const row = this.#getEntry(resolved);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, stat '${path}'`,
			);

		return {
			mode: row.mode as number,
			size: row.is_dir
				? 4096
				: ((row.content as Uint8Array | null)?.byteLength ?? 0),
			isDirectory: row.is_dir === 1,
			isSymbolicLink: false,
			atimeMs: row.atime_ms as number,
			mtimeMs: row.mtime_ms as number,
			ctimeMs: row.ctime_ms as number,
			birthtimeMs: row.birthtime_ms as number,
		};
	}

	async lstat(path: string) {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, lstat '${path}'`,
			);

		return {
			mode: row.mode as number,
			size: row.is_symlink
				? new TextEncoder().encode(row.link_target as string)
						.byteLength
				: row.is_dir
					? 4096
					: ((row.content as Uint8Array | null)?.byteLength ?? 0),
			isDirectory: row.is_dir === 1,
			isSymbolicLink: row.is_symlink === 1,
			atimeMs: row.atime_ms as number,
			mtimeMs: row.mtime_ms as number,
			ctimeMs: row.ctime_ms as number,
			birthtimeMs: row.birthtime_ms as number,
		};
	}

	async removeFile(path: string): Promise<void> {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, unlink '${path}'`,
			);
		if (row.is_dir)
			throw new Error(
				`EISDIR: illegal operation on a directory, unlink '${path}'`,
			);
		this.db.run(`DELETE FROM entries WHERE path = ?`, [path]);
	}

	async removeDir(path: string): Promise<void> {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, rmdir '${path}'`,
			);
		if (!row.is_dir)
			throw new Error(`ENOTDIR: not a directory, rmdir '${path}'`);

		const prefix = path === "/" ? "/" : path + "/";
		const children = this.#queryChildren(prefix);
		if (children.length > 0)
			throw new Error(
				`ENOTEMPTY: directory not empty, rmdir '${path}'`,
			);

		this.db.run(`DELETE FROM entries WHERE path = ?`, [path]);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const row = this.#getEntry(oldPath);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`,
			);

		await this.mkdir(dirname(newPath));
		const now = Date.now();
		this.db.run(
			`INSERT OR REPLACE INTO entries
			(path, content, mode, is_dir, is_symlink, link_target,
			 atime_ms, mtime_ms, ctime_ms, birthtime_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				newPath,
				row.content,
				row.mode,
				row.is_dir,
				row.is_symlink,
				row.link_target,
				row.atime_ms,
				now,
				now,
				row.birthtime_ms,
			],
		);
		this.db.run(`DELETE FROM entries WHERE path = ?`, [oldPath]);
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		if (this.#exists(linkPath))
			throw new Error(
				`EEXIST: file already exists, symlink '${target}' -> '${linkPath}'`,
			);

		await this.mkdir(dirname(linkPath));
		const now = Date.now();
		this.db.run(
			`INSERT INTO entries
			(path, content, mode, is_dir, is_symlink, link_target,
			 atime_ms, mtime_ms, ctime_ms, birthtime_ms)
			VALUES (?, NULL, 41471, 0, 1, ?, ?, ?, ?, ?)`,
			[linkPath, target, now, now, now, now],
		);
	}

	async readlink(path: string): Promise<string> {
		const row = this.#getEntry(path);
		if (!row || !row.is_symlink)
			throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		return row.link_target as string;
	}

	async link(oldPath: string, newPath: string): Promise<void> {
		const row = this.#getEntry(oldPath);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, link '${oldPath}' -> '${newPath}'`,
			);
		if (this.#exists(newPath))
			throw new Error(
				`EEXIST: file already exists, link '${oldPath}' -> '${newPath}'`,
			);

		await this.mkdir(dirname(newPath));
		const now = Date.now();
		this.db.run(
			`INSERT INTO entries
			(path, content, mode, is_dir, atime_ms, mtime_ms, ctime_ms, birthtime_ms)
			VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
			[newPath, row.content, row.mode, now, now, now, now],
		);
	}

	async chmod(path: string, mode: number): Promise<void> {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, chmod '${path}'`,
			);
		const typeBits = row.is_dir ? 0o040000 : 0o100000;
		this.db.run(`UPDATE entries SET mode = ? WHERE path = ?`, [
			typeBits | (mode & 0o7777),
			path,
		]);
	}

	async chown(path: string, _uid: number, _gid: number): Promise<void> {
		if (!this.#exists(path))
			throw new Error(
				`ENOENT: no such file or directory, chown '${path}'`,
			);
	}

	async utimes(path: string, atime: number, mtime: number): Promise<void> {
		if (!this.#exists(path))
			throw new Error(
				`ENOENT: no such file or directory, utimes '${path}'`,
			);
		this.db.run(
			`UPDATE entries SET atime_ms = ?, mtime_ms = ? WHERE path = ?`,
			[atime * 1000, mtime * 1000, path],
		);
	}

	async truncate(path: string, length: number): Promise<void> {
		const row = this.#getEntry(path);
		if (!row)
			throw new Error(
				`ENOENT: no such file or directory, truncate '${path}'`,
			);
		const data = new Uint8Array(row.content as Uint8Array);
		const result =
			length >= data.byteLength
				? (() => {
						const buf = new Uint8Array(length);
						buf.set(data);
						return buf;
					})()
				: data.slice(0, length);
		this.db.run(`UPDATE entries SET content = ? WHERE path = ?`, [
			result,
			path,
		]);
	}

	close() {
		this.db.close();
	}

	// --- Private helpers ---

	#getEntry(path: string): Record<string, unknown> | null {
		const stmt = this.db.prepare(
			`SELECT * FROM entries WHERE path = ?`,
		);
		stmt.bind([path]);
		const result = stmt.step() ? stmt.getAsObject() : null;
		stmt.free();
		return result;
	}

	#exists(path: string): boolean {
		const stmt = this.db.prepare(
			`SELECT 1 FROM entries WHERE path = ?`,
		);
		stmt.bind([path]);
		const found = stmt.step();
		stmt.free();
		return found;
	}

	#queryChildren(
		prefix: string,
	): Array<Record<string, unknown>> {
		const exclude = prefix + "%/%";
		const results: Array<Record<string, unknown>> = [];
		const stmt = this.db.prepare(
			`SELECT path, is_dir FROM entries
			WHERE path LIKE ? AND path != ? AND path NOT LIKE ?`,
		);
		stmt.bind([prefix + "%", prefix.slice(0, -1) || "/", exclude]);
		while (stmt.step()) {
			results.push(stmt.getAsObject());
		}
		stmt.free();
		return results;
	}

	#resolveSymlink(path: string, maxDepth = 16): string {
		let current = path;
		for (let i = 0; i < maxDepth; i++) {
			const row = this.#getEntry(current);
			if (!row || !row.is_symlink) return current;
			const target = row.link_target as string;
			current = target.startsWith("/")
				? target
				: dirname(current) + "/" + target;
		}
		throw new Error(
			`ELOOP: too many levels of symbolic links, stat '${path}'`,
		);
	}
}

function dirname(path: string): string {
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 1) return "/";
	return "/" + parts.slice(0, -1).join("/");
}
