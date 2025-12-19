/**
 * VirtualFileSystem implementation for nanosandbox.
 *
 * This module wraps the wasmer-js VFS API to provide the VirtualFileSystem
 * interface needed by sandboxed-node.
 *
 * Paths are passed through as-is - no transformation.
 */
import type { VirtualFileSystem } from "sandboxed-node";
import type { VFS } from "@wasmer/sdk/node";

/**
 * Create a VirtualFileSystem that delegates directly to a wasmer-js VFS.
 * Paths are passed through as-is - no transformation.
 *
 * @param vfs - The wasmer-js VFS to delegate to
 * @returns A VirtualFileSystem implementation
 */
export function createVirtualFileSystem(vfs: VFS): VirtualFileSystem {
	return {
		readFile: async (path: string): Promise<Uint8Array> => {
			return vfs.readFile(path);
		},

		readTextFile: async (path: string): Promise<string> => {
			return vfs.readTextFile(path);
		},

		readDir: async (path: string): Promise<string[]> => {
			const entries = vfs.readDir(path);
			return entries.map((entry) => entry.name);
		},

		writeFile: async (path: string, content: string | Uint8Array): Promise<void> => {
			await vfs.writeFile(path, content);
		},

		createDir: async (path: string): Promise<void> => {
			vfs.mkdir(path);
		},

		removeFile: async (path: string): Promise<void> => {
			vfs.removeFile(path);
		},

		removeDir: async (path: string): Promise<void> => {
			vfs.removeDir(path);
		},

		exists: async (path: string): Promise<boolean> => {
			return vfs.exists(path);
		},

		mkdir: async (path: string): Promise<void> => {
			vfs.mkdir(path);
		},
	};
}
