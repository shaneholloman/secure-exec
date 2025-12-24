import { describe, expect, it, beforeAll } from "vitest";
import { Runtime } from "../src/runtime/index.js";

/**
 * Tests for sandboxed Node.js execution via the V8 Accelerator.
 *
 * When WASM runs `node`, the host_exec syscalls delegate to sandboxed-node's
 * NodeProcess (V8 isolate) instead of spawning a real process.
 */
describe("Node Process", () => {
	let runtime: Runtime;

	beforeAll(async () => {
		runtime = await Runtime.load();
	});

	describe("Sanity check", () => {
		it("bash echo works (verifies runtime without host_exec)", async () => {
			const vm = await runtime.run("bash", { args: ["-c", "echo hello"] });
			expect(vm.stdout.trim()).toBe("hello");
			expect(vm.code).toBe(0);
		});
	});

	describe("Basic execution", () => {
		it("should execute node -e directly", async () => {
			const vm = await runtime.run("node", {
				args: ["-e", "console.log('hello from node')"],
			});
			expect(vm.stdout).toContain("hello from node");
			expect(vm.code).toBe(0);
		});

		it("should handle node errors properly", async () => {
			const vm = await runtime.run("node", {
				args: ["-e", "throw new Error('oops')"],
			});
			expect(vm.code).not.toBe(0);
		});
	});

	describe("Stdin handling", () => {
		// Skipped: stdin forwarding to host_exec is not supported due to wasmer-js
		// poll_oneoff bug. When stdin is in the subscription list, poll_oneoff
		// blocks indefinitely even with a timeout.
		it.skip("should read stdin and output it (node)", async () => {
			const script = `
				let data = '';
				process.stdin.on('data', chunk => data += chunk);
				process.stdin.on('end', () => console.log('got:', data.trim()));
			`;
			const vm = await runtime.run("node", {
				args: ["-e", script],
				stdin: "hello world",
			});
			expect(vm.stdout.trim()).toBe("got: hello world");
		});

		// Streaming stdin tests are skipped due to wasmer-js TTY bug.
		// See: docs/research/wasmer-js-tty-stdin-bug.md
		it.skip("should stream stdin to node with spawn()", async () => {
			const script = `
				let data = '';
				process.stdin.on('data', chunk => data += chunk);
				process.stdin.on('end', () => {
					data.trim().split('\\n').forEach(line => console.log('OUT:' + line));
				});
			`;
			const proc = await runtime.spawn("node", {
				args: ["-e", script],
			});

			await proc.writeStdin("ping1\n");
			await proc.writeStdin("ping2\n");
			await proc.writeStdin("ping3\n");
			await proc.closeStdin();

			const result = await proc.wait();
			expect(result.stdout).toContain("OUT:ping1");
			expect(result.stdout).toContain("OUT:ping2");
			expect(result.stdout).toContain("OUT:ping3");
		}, 30000);
	});
});
