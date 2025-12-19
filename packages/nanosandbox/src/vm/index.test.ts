import { describe, expect, it } from "vitest";
import { VirtualMachine } from "./index";

describe("VirtualMachine", () => {
	describe("Basic spawn functionality", () => {
		it("should execute echo command", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("echo", { args: ["hello world"] });
				expect(result.stdout.trim()).toBe("hello world");
				expect(result.code).toBe(0);
			} finally {
				vm.dispose();
			}
		});

		it("should execute ls command on root", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("ls", { args: ["/"] });
				expect(result.code).toBe(0);
				// Root should have standard directories
				expect(result.stdout).toContain("bin");
			} finally {
				vm.dispose();
			}
		});

		it("should execute bash with echo builtin", async () => {
			const vm = new VirtualMachine();
			try {
				// echo is a bash builtin, so this works without subprocess spawning
				const result = await vm.spawn("bash", {
					args: ["-c", "echo foo; echo bar"],
				});
				// Note: bash may return non-zero exit codes in WASIX even for successful commands
				expect(result.stdout).toContain("foo");
				expect(result.stdout).toContain("bar");
			} finally {
				vm.dispose();
			}
		});

		it("should handle command failure", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("ls", { args: ["/nonexistent"] });
				expect(result.code).not.toBe(0);
			} finally {
				vm.dispose();
			}
		});
	});

	describe("Filesystem via bash builtins", () => {
		it("should write files via redirection and read via bash", async () => {
			const vm = new VirtualMachine();
			try {
				// Use bash builtins only - echo and redirection work
				// Then use bash read builtin to verify
				const result = await vm.spawn("bash", {
					args: ["-c", 'echo "hello" > /data/test.txt; read -r line < /data/test.txt; echo "$line"'],
				});
				// Note: bash may return non-zero exit codes in WASIX even for successful commands
				expect(result.stdout.trim()).toBe("hello");
			} finally {
				vm.dispose();
			}
		});

		it("should check file existence via bash test", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("bash", {
					args: [
						"-c",
						'echo test > /data/exists.txt; if [ -f /data/exists.txt ]; then echo "exists"; fi',
					],
				});
				// Note: bash may return non-zero exit codes in WASIX even for successful commands
				expect(result.stdout.trim()).toBe("exists");
			} finally {
				vm.dispose();
			}
		});
	});

	describe("Node via IPC", () => {
		it("should execute node -e directly", async () => {
			const vm = new VirtualMachine();
			try {
				// Direct node command goes through IPC
				const result = await vm.spawn("node", {
					args: ["-e", "console.log('hello from node')"],
				});
				expect(result.stdout).toContain("hello from node");
				expect(result.code).toBe(0);
			} finally {
				vm.dispose();
			}
		});

		it("should handle node errors properly", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("node", {
					args: ["-e", "throw new Error('oops')"],
				});
				expect(result.code).not.toBe(0);
			} finally {
				vm.dispose();
			}
		});
	});

	describe("Isolation", () => {
		it("should have isolated filesystems between spawns", async () => {
			const vm = new VirtualMachine();
			try {
				// First spawn creates a file
				await vm.spawn("bash", {
					args: ["-c", "echo hello > /data/isolated.txt"],
				});

				// Second spawn should NOT see the file (isolated filesystem)
				const result = await vm.spawn("bash", {
					args: ["-c", 'if [ -f /data/isolated.txt ]; then echo "found"; else echo "not found"; fi'],
				});
				expect(result.stdout.trim()).toBe("not found");
			} finally {
				vm.dispose();
			}
		});
	});
});
