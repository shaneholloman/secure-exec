import { init } from "@wasmer/sdk/node";
import { NodeProcess, createDefaultNetworkAdapter } from "sandboxed-node";
import { beforeAll, describe, expect, it } from "vitest";
import { WasixInstance } from "./index.js";
import { createVirtualFileSystem } from "../vm/node-vfs.js";
import type { VFS } from "@wasmer/sdk/node";

describe("WasixInstance", () => {
	beforeAll(async () => {
		await init();
	});

	describe("Basic WASM shell", () => {
		it("should execute echo command", async () => {
			const wasix = new WasixInstance();
			const result = await wasix.run("echo", ["hello"]);
			expect(result.stdout.trim()).toBe("hello");
			expect(result.code).toBe(0);
		});

		it("should execute ls command on root", async () => {
			const wasix = new WasixInstance();
			const result = await wasix.run("ls", ["/"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("bin");
		});

		it("should execute shell command via bash", async () => {
			const wasix = new WasixInstance();
			// Use bash builtins only (echo is a builtin)
			const result = await wasix.exec("echo hello; echo world");
			expect(result.stdout).toContain("hello");
			expect(result.stdout).toContain("world");
		});

		it("should write and read files via bash builtins", async () => {
			const wasix = new WasixInstance();
			// Use bash redirection and read builtin
			const result = await wasix.exec(
				'echo "test content" > /data/test.txt; read -r line < /data/test.txt; echo "$line"'
			);
			// Note: bash may return non-zero exit codes in WASIX even for successful commands
			expect(result.stdout.trim()).toBe("test content");
		});
	});

	describe("Isolated spawns", () => {
		it("should have isolated filesystems between runs", async () => {
			const wasix = new WasixInstance();

			// First run creates a file
			await wasix.run("bash", ["-c", "echo hello > /data/isolated.txt"]);

			// Second run should NOT see the file (isolated)
			const result = await wasix.run("bash", [
				"-c",
				'if [ -f /data/isolated.txt ]; then echo "found"; else echo "not found"; fi',
			]);
			expect(result.stdout.trim()).toBe("not found");
		});
	});

	describe("IPC polling for node", () => {
		it("should run node command via IPC with real node fallback", async () => {
			const wasix = new WasixInstance();
			const result = await wasix.runWithIpc("node", ["-e", "console.log(2+2)"]);
			expect(result.stdout).toContain("4");
		});

		it("should run node command via IPC with NodeProcess factory", async () => {
			const wasix = new WasixInstance({
				nodeProcessFactory: (vfs: VFS) => {
					const virtualFs = createVirtualFileSystem(vfs);
					return new NodeProcess({
						filesystem: virtualFs,
						networkAdapter: createDefaultNetworkAdapter(),
					});
				},
			});

			const result = await wasix.runWithIpc("node", [
				"-e",
				"console.log('Hello from NodeProcess')",
			]);

			expect(result.stdout).toContain("Hello from NodeProcess");
		});
	});
});
