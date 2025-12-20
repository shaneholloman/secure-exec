import { describe, expect, it, beforeAll } from "vitest";
import { Runtime } from "../src/runtime/index.js";

/**
 * Tests for async spawn() with event callbacks.
 * Uses the active handles mechanism to keep the sandbox alive.
 * See: packages/sandboxed-node/docs/ACTIVE_HANDLES.md
 */
describe("Async spawn", () => {
	let runtime: Runtime;

	beforeAll(async () => {
		runtime = await Runtime.load();
	});

	it("should spawn and stream stdout via events", async () => {
		const script = `
			const { spawn } = require('child_process');
			const child = spawn('echo', ['hello', 'world']);

			let output = '';
			child.stdout.on('data', (data) => {
				output += data.toString();
			});

			child.on('close', (code) => {
				console.log('output:', output.trim());
				console.log('code:', code);
			});
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		expect(vm.stdout).toContain("output: hello world");
		expect(vm.stdout).toContain("code: 0");
	}, 30000);

	it("should spawn ls and stream directory listing", async () => {
		const script = `
			const { spawn } = require('child_process');
			const child = spawn('ls', ['/']);

			let output = '';
			child.stdout.on('data', (data) => {
				output += data.toString();
			});

			child.on('close', (code) => {
				console.log('has bin:', output.includes('bin'));
				console.log('code:', code);
			});
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		expect(vm.stdout).toContain("has bin: true");
		expect(vm.stdout).toContain("code: 0");
	}, 30000);

	it("should handle multiple concurrent spawns", async () => {
		const script = `
			const { spawn } = require('child_process');

			let results = [];
			let pending = 2;

			const child1 = spawn('echo', ['first']);
			const child2 = spawn('echo', ['second']);

			child1.stdout.on('data', (data) => results.push('1:' + data.toString().trim()));
			child2.stdout.on('data', (data) => results.push('2:' + data.toString().trim()));

			child1.on('close', () => { if (--pending === 0) done(); });
			child2.on('close', () => { if (--pending === 0) done(); });

			function done() {
				console.log('results:', results.sort().join(','));
			}
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		expect(vm.stdout).toContain("results: 1:first,2:second");
	}, 30000);
});
