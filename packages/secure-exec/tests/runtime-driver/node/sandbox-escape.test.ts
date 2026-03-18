import { afterEach, describe, expect, it } from "vitest";
import { createTestNodeRuntime } from "../../test-utils.js";
import type { NodeRuntime } from "../../../src/index.js";

type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

function createConsoleCapture() {
	const events: CapturedConsoleEvent[] = [];
	return {
		events,
		onStdio: (event: CapturedConsoleEvent) => {
			events.push(event);
		},
		stdout: () =>
			events
				.filter((e) => e.channel === "stdout")
				.map((e) => e.message)
				.join("\n"),
	};
}

describe("sandbox escape security", () => {
	let proc: NodeRuntime | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	it("process.binding() returns inert stubs, not real native bindings", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			const results = {};

			// process.binding('fs') should not have real native methods
			const fsBind = process.binding('fs');
			results.fsHasOpen = typeof fsBind.open === 'function';
			results.fsHasStat = typeof fsBind.stat === 'function';
			results.fsHasRead = typeof fsBind.read === 'function';
			results.fsIsEmpty = Object.keys(fsBind).length === 0;

			// process.binding('spawn_sync') should return empty object
			const spawnBind = process.binding('spawn_sync');
			results.spawnSyncIsEmpty = Object.keys(spawnBind).length === 0;

			// process.binding('pipe_wrap') should return empty object
			const pipeBind = process.binding('pipe_wrap');
			results.pipeIsEmpty = Object.keys(pipeBind).length === 0;

			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.fsHasOpen).toBe(false);
		expect(results.fsHasStat).toBe(false);
		expect(results.fsHasRead).toBe(false);
		expect(results.fsIsEmpty).toBe(true);
		expect(results.spawnSyncIsEmpty).toBe(true);
		expect(results.pipeIsEmpty).toBe(true);
	});

	it("process.dlopen() is blocked inside sandbox", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			let blocked = false;
			let errorMsg = '';
			try {
				process.dlopen({}, '/tmp/fake.node');
			} catch (e) {
				blocked = true;
				errorMsg = e.message;
			}
			console.log(JSON.stringify({ blocked, errorMsg }));
		`);

		expect(result.code).toBe(0);
		const output = JSON.parse(capture.stdout().trim());
		expect(output.blocked).toBe(true);
		expect(output.errorMsg).toContain("not supported");
	});

	it("constructor.constructor('return this')() does not return host global", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			// Classic sandbox escape: use Function constructor to access the real global
			const escaped = (function() {}).constructor('return this')();

			// The returned global should be the sandbox global, not host
			// Host global would have process.pid matching the real host PID,
			// real require with native bindings, etc.
			const results = {};

			// If escape worked, we'd get the host's real require/process
			results.hasHostBinding = typeof escaped.process?.binding === 'function'
				&& typeof escaped.process.binding('fs')?.open === 'function';
			results.hasDlopen = false;
			try {
				escaped.process?.dlopen?.({}, '/tmp/fake.node');
			} catch (e) {
				// dlopen should still throw "not supported" even via constructor escape
				results.hasDlopen = !e.message.includes('not supported');
			}

			// Verify the escaped global IS the sandbox global (same object)
			results.sameGlobal = escaped === globalThis;

			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.hasHostBinding).toBe(false);
		expect(results.hasDlopen).toBe(false);
		expect(results.sameGlobal).toBe(true);
	});

	it("Object.prototype.__proto__ manipulation does not affect host objects", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		// Execute code that tries proto pollution, then run second execution
		// to verify sandbox isolation
		const result = await proc.exec(`
			const results = {};

			// Attempt prototype pollution
			const payload = { polluted: true };
			try {
				({}).__proto__.sandboxEscape = 'yes';
				results.protoWriteSucceeded = ({}).sandboxEscape === 'yes';
			} catch (e) {
				results.protoWriteSucceeded = false;
			}

			// Try more advanced prototype manipulation
			try {
				Object.prototype.constructor.prototype.hostAccess = true;
				results.constructorProtoWrite = ({}).hostAccess === true;
			} catch (e) {
				results.constructorProtoWrite = false;
			}

			// Attempt to replace Object.prototype entirely
			let protoReplaceBlocked = false;
			try {
				Object.setPrototypeOf(Object.prototype, { escaped: true });
			} catch (e) {
				protoReplaceBlocked = true;
			}
			results.protoReplaceBlocked = protoReplaceBlocked;

			// Verify sandbox process is still the sandbox's process
			results.processIsSandboxed = typeof process.dlopen === 'function';

			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		// Proto writes within the sandbox stay in the sandbox (isolated-vm provides isolation)
		// The critical assertion is that Object.setPrototypeOf(Object.prototype, ...) throws
		expect(results.protoReplaceBlocked).toBe(true);
		// Sandbox process remains sandboxed regardless of proto manipulation
		expect(results.processIsSandboxed).toBe(true);

		// Run a second execution to verify no cross-execution proto leakage
		const capture2 = createConsoleCapture();
		proc.dispose();
		proc = createTestNodeRuntime({ onStdio: capture2.onStdio });

		const result2 = await proc.exec(`
			const clean = {};
			console.log(JSON.stringify({
				noSandboxEscape: clean.sandboxEscape === undefined,
				noHostAccess: clean.hostAccess === undefined,
			}));
		`);

		expect(result2.code).toBe(0);
		const results2 = JSON.parse(capture2.stdout().trim());
		expect(results2.noSandboxEscape).toBe(true);
		expect(results2.noHostAccess).toBe(true);
	});

	it("require('v8').runInDebugContext is blocked or undefined", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			const results = {};
			try {
				const v8 = require('v8');
				results.hasRunInDebugContext = typeof v8.runInDebugContext === 'function';
				results.v8Keys = Object.keys(v8);

				// If it somehow exists, verify it throws
				if (typeof v8.runInDebugContext === 'function') {
					try {
						v8.runInDebugContext('Debug');
						results.debugContextEscaped = true;
					} catch {
						results.debugContextEscaped = false;
					}
				} else {
					results.debugContextEscaped = false;
				}

				// Also verify v8 module doesn't expose getHeapStatistics or other native internals
				results.hasGetHeapStatistics = typeof v8.getHeapStatistics === 'function';
				results.hasSerialize = typeof v8.serialize === 'function';
			} catch (e) {
				results.requireFailed = true;
				results.hasRunInDebugContext = false;
				results.debugContextEscaped = false;
			}
			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.hasRunInDebugContext).toBe(false);
		expect(results.debugContextEscaped).toBe(false);
	});

	it("all sandbox escape techniques fail together", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		// Combined stress test of multiple escape vectors in a single execution
		const result = await proc.exec(`
			const escapes = [];

			// 1. Function constructor global access
			try {
				const g = Function('return this')();
				if (g !== globalThis) escapes.push('Function-constructor-different-global');
				if (typeof g.process?.binding === 'function' &&
				    typeof g.process.binding('fs')?.open === 'function')
					escapes.push('Function-constructor-real-bindings');
			} catch { /* blocked is fine */ }

			// 2. eval-based escape
			try {
				const g = eval('this');
				if (g !== globalThis) escapes.push('eval-this-different-global');
			} catch { /* blocked is fine */ }

			// 3. Indirect eval
			try {
				const indirectEval = eval;
				const g = indirectEval('this');
				if (g !== globalThis) escapes.push('indirect-eval-different-global');
			} catch { /* blocked is fine */ }

			// 4. vm.runInThisContext should not grant real host access
			try {
				const vm = require('vm');
				if (typeof vm?.runInThisContext === 'function') {
					const g = vm.runInThisContext('this');
					// The real escape is if it has real native bindings
					if (typeof g?.process?.binding === 'function' &&
					    typeof g.process.binding('fs')?.open === 'function')
						escapes.push('vm-runInThisContext-real-bindings');
				}
			} catch { /* blocked is fine */ }

			// 5. Arguments callee chain
			try {
				(function() {
					const caller = arguments.callee.caller;
					if (caller) escapes.push('arguments-callee-caller-accessible');
				})();
			} catch { /* strict mode or blocked, fine */ }

			console.log(JSON.stringify({ escapes, count: escapes.length }));
		`);

		expect(result.code).toBe(0);
		const output = JSON.parse(capture.stdout().trim());
		expect(output.escapes).toEqual([]);
		expect(output.count).toBe(0);
	});
});
