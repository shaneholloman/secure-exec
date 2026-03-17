/**
 * Device layer.
 *
 * Intercepts device node paths (/dev/*) before they reach the VFS backend.
 * Wraps a VirtualFileSystem and handles device-specific read/write semantics.
 */

import type { VirtualFileSystem, VirtualStat, VirtualDirEntry } from "./vfs.js";

const DEVICE_PATHS = new Set([
	"/dev/null",
	"/dev/zero",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/urandom",
]);

const DEVICE_INO: Record<string, number> = {
	"/dev/null": 0xffff_0001,
	"/dev/zero": 0xffff_0002,
	"/dev/stdin": 0xffff_0003,
	"/dev/stdout": 0xffff_0004,
	"/dev/stderr": 0xffff_0005,
	"/dev/urandom": 0xffff_0006,
};

function isDevicePath(path: string): boolean {
	return DEVICE_PATHS.has(path) || path.startsWith("/dev/fd/");
}

function deviceStat(path: string): VirtualStat {
	const now = Date.now();
	return {
		mode: 0o666,
		size: 0,
		isDirectory: false,
		isSymbolicLink: false,
		atimeMs: now,
		mtimeMs: now,
		ctimeMs: now,
		birthtimeMs: now,
		ino: DEVICE_INO[path] ?? 0xffff_0000,
		nlink: 1,
		uid: 0,
		gid: 0,
	};
}

const DEV_DIR_ENTRIES: VirtualDirEntry[] = [
	{ name: "null", isDirectory: false },
	{ name: "zero", isDirectory: false },
	{ name: "stdin", isDirectory: false },
	{ name: "stdout", isDirectory: false },
	{ name: "stderr", isDirectory: false },
	{ name: "urandom", isDirectory: false },
	{ name: "fd", isDirectory: true },
];

/**
 * Wrap a VFS with device node interception.
 * Device paths are handled directly; all other paths pass through.
 */
export function createDeviceLayer(vfs: VirtualFileSystem): VirtualFileSystem {
	return {
		async readFile(path) {
			if (path === "/dev/null") return new Uint8Array(0);
			if (path === "/dev/zero") return new Uint8Array(4096);
			if (path === "/dev/urandom") {
				const buf = new Uint8Array(4096);
				if (typeof globalThis.crypto?.getRandomValues === "function") {
					globalThis.crypto.getRandomValues(buf);
				} else {
					for (let i = 0; i < buf.length; i++) {
						buf[i] = (Math.random() * 256) | 0;
					}
				}
				return buf;
			}
			return vfs.readFile(path);
		},

		async readTextFile(path) {
			if (path === "/dev/null") return "";
			const bytes = await this.readFile(path);
			return new TextDecoder().decode(bytes);
		},

		async readDir(path) {
			if (path === "/dev") {
				return DEV_DIR_ENTRIES.map((e) => e.name);
			}
			return vfs.readDir(path);
		},

		async readDirWithTypes(path) {
			if (path === "/dev") {
				return DEV_DIR_ENTRIES;
			}
			return vfs.readDirWithTypes(path);
		},

		async writeFile(path, content) {
			if (path === "/dev/null") return; // discard
			return vfs.writeFile(path, content);
		},

		async createDir(path) {
			if (path === "/dev") return;
			return vfs.createDir(path);
		},

		async mkdir(path, options?) {
			if (path === "/dev") return;
			return vfs.mkdir(path, options);
		},

		async exists(path) {
			if (isDevicePath(path) || path === "/dev") return true;
			return vfs.exists(path);
		},

		async stat(path) {
			if (isDevicePath(path)) return deviceStat(path);
			if (path === "/dev") {
				const now = Date.now();
				return {
					mode: 0o755,
					size: 0,
					isDirectory: true,
					isSymbolicLink: false,
					atimeMs: now,
					mtimeMs: now,
					ctimeMs: now,
					birthtimeMs: now,
					ino: 0xffff_0000,
					nlink: 2,
					uid: 0,
					gid: 0,
				};
			}
			return vfs.stat(path);
		},

		async removeFile(path) {
			if (isDevicePath(path)) throw new Error("EPERM: cannot remove device");
			return vfs.removeFile(path);
		},

		async removeDir(path) {
			if (path === "/dev") throw new Error("EPERM: cannot remove /dev");
			return vfs.removeDir(path);
		},

		async rename(oldPath, newPath) {
			if (isDevicePath(oldPath) || isDevicePath(newPath)) {
				throw new Error("EPERM: cannot rename device");
			}
			return vfs.rename(oldPath, newPath);
		},

		async realpath(path) {
			return vfs.realpath(path);
		},

		// Passthrough for POSIX extensions
		async symlink(target, linkPath) {
			return vfs.symlink(target, linkPath);
		},

		async readlink(path) {
			return vfs.readlink(path);
		},

		async lstat(path) {
			if (isDevicePath(path)) return deviceStat(path);
			return vfs.lstat(path);
		},

		async link(oldPath, newPath) {
			if (isDevicePath(oldPath)) throw new Error("EPERM: cannot link device");
			return vfs.link(oldPath, newPath);
		},

		async chmod(path, mode) {
			if (isDevicePath(path)) return;
			return vfs.chmod(path, mode);
		},

		async chown(path, uid, gid) {
			if (isDevicePath(path)) return;
			return vfs.chown(path, uid, gid);
		},

		async utimes(path, atime, mtime) {
			if (isDevicePath(path)) return;
			return vfs.utimes(path, atime, mtime);
		},

		async truncate(path, length) {
			if (path === "/dev/null") return;
			return vfs.truncate(path, length);
		},
	};
}
