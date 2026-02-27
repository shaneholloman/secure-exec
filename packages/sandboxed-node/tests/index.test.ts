import { afterEach, describe, expect, it } from "vitest";
import {
	allowAllEnv,
	allowAllFs,
	allowAllNetwork,
	NodeFileSystem,
	NodeProcess,
	createInMemoryFileSystem,
	createNodeDriver,
} from "../src/index.js";

function createFs() {
	return createInMemoryFileSystem();
}

const allowFsNetworkEnv = {
	...allowAllFs,
	...allowAllNetwork,
	...allowAllEnv,
};

describe("NodeProcess", () => {
	let proc: NodeProcess | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	it("runs basic code and returns module.exports", async () => {
		proc = new NodeProcess();
		const result = await proc.run(`module.exports = 1 + 1`);
		expect(result.exports).toBe(2);
	});

	it("returns ESM default export namespace from run()", async () => {
		proc = new NodeProcess();
		const result = await proc.run(`export default 42;`, "/entry.mjs");
		expect(result.exports).toEqual({ default: 42 });
	});

	it("returns ESM named exports from run()", async () => {
		proc = new NodeProcess();
		const result = await proc.run(
			`
	      export const message = 'hello';
	      export const count = 3;
	    `,
			"/entry.mjs",
		);
		expect(result.exports).toEqual({ count: 3, message: "hello" });
	});

	it("returns mixed ESM default and named exports from run()", async () => {
		proc = new NodeProcess();
		const result = await proc.run(
			`
	      export const named = 'value';
	      export default 99;
	    `,
			"/entry.mjs",
		);
		expect(result.exports).toEqual({ default: 99, named: "value" });
	});

	it("captures stdout and stderr", async () => {
		proc = new NodeProcess();
		const result = await proc.exec(`console.log('hello'); console.error('oops');`);
		expect(result.stdout).toBe("hello\n");
		expect(result.stderr).toBe("oops\n");
		expect(result.code).toBe(0);
	});

	it("loads node stdlib polyfills", async () => {
		proc = new NodeProcess();
		const result = await proc.run(`
      const path = require('path');
      module.exports = path.join('foo', 'bar');
    `);
		expect(result.exports).toBe("foo/bar");
	});

	it("does not shim third-party packages in require resolution", async () => {
		proc = new NodeProcess();
		const result = await proc.exec(`require('chalk')`);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Cannot find module");
	});

	it("loads tty/constants polyfills and v8 stub", async () => {
		proc = new NodeProcess();
		const result = await proc.run(`
      const tty = require('tty');
      const constants = require('constants');
      const v8 = require('v8');
      let readStreamThrows = false;
      try {
        new tty.ReadStream();
      } catch (error) {
        readStreamThrows = true;
      }
      module.exports = {
        ttyIsatty: tty.isatty(1),
        ttyReadStreamThrows: readStreamThrows,
        constantsKeyCount: Object.keys(constants).length,
        hasSigtermConstant: typeof constants.SIGTERM === 'number',
        heapSizeLimitType: typeof v8.getHeapStatistics().heap_size_limit,
      };
    `);
		const exports = result.exports as {
			ttyIsatty: boolean;
			ttyReadStreamThrows: boolean;
			constantsKeyCount: number;
			hasSigtermConstant: boolean;
			heapSizeLimitType: string;
		};
		expect(exports.ttyIsatty).toBe(false);
		expect(exports.ttyReadStreamThrows).toBe(true);
		expect(exports.constantsKeyCount).toBeGreaterThan(10);
		expect(exports.hasSigtermConstant).toBe(true);
		expect(exports.heapSizeLimitType).toBe("number");
	});

	it("errors for unknown modules", async () => {
		proc = new NodeProcess();
		const result = await proc.exec(`require('nonexistent-module')`);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Cannot find module");
	});

	it("loads packages from virtual node_modules", async () => {
		const fs = createFs();
		await fs.mkdir("/node_modules/my-pkg");
		await fs.writeFile(
			"/node_modules/my-pkg/package.json",
			JSON.stringify({ name: "my-pkg", main: "index.js" }),
		);
		await fs.writeFile(
			"/node_modules/my-pkg/index.js",
			"module.exports = { add: (a, b) => a + b };",
		);

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.run(`
      const pkg = require('my-pkg');
      module.exports = pkg.add(2, 3);
    `);
		expect(result.exports).toBe(5);
	});

	it("exposes fs module backed by virtual filesystem", async () => {
		const fs = createFs();
		await fs.mkdir("/data");
		await fs.writeFile("/data/hello.txt", "hello world");

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.run(`
      const fs = require('fs');
      module.exports = fs.readFileSync('/data/hello.txt', 'utf8');
		`);
		expect(result.exports).toBe("hello world");
	});

	it("resolves package exports and ESM entrypoints from node_modules", async () => {
		const fs = createFs();
		await fs.mkdir("/node_modules/exported");
		await fs.mkdir("/node_modules/exported/dist");
		await fs.writeFile(
			"/node_modules/exported/package.json",
			JSON.stringify({
				name: "exported",
				exports: {
					".": {
						import: "./dist/index.mjs",
						require: "./dist/index.cjs",
					},
					"./feature": {
						import: "./dist/feature.mjs",
						require: "./dist/feature.cjs",
					},
				},
			}),
		);
		await fs.writeFile(
			"/node_modules/exported/dist/index.cjs",
			"module.exports = { value: 'cjs-entry' };",
		);
		await fs.writeFile(
			"/node_modules/exported/dist/index.mjs",
			"export const value = 'esm-entry';",
		);
		await fs.writeFile(
			"/node_modules/exported/dist/feature.cjs",
			"module.exports = { feature: 'cjs-feature' };",
		);
		await fs.writeFile(
			"/node_modules/exported/dist/feature.mjs",
			"export const feature = 'esm-feature';",
		);

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });

		const cjsResult = await proc.run(`
      const pkg = require('exported');
      const feature = require('exported/feature');
      module.exports = pkg.value + ':' + feature.feature;
    `);
		expect(cjsResult.exports).toBe("cjs-entry:cjs-feature");

		const esmResult = await proc.exec(
			`
        import { value } from 'exported';
        import { feature } from 'exported/feature';
        console.log(value + ':' + feature);
      `,
			{ filePath: "/entry.mjs" },
		);
		expect(esmResult.code).toBe(0);
		expect(esmResult.stdout).toContain("esm-entry:esm-feature");
	});

	it("treats .js entry files as ESM under package type module", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile("/app/package.json", JSON.stringify({ type: "module" }));
		await fs.writeFile("/app/value.js", "export const value = 42;");

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
	      import { value } from './value.js';
	      console.log(value);
	    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("42\n");
	});

	it("uses CommonJS semantics for .js under package type commonjs", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile("/app/package.json", JSON.stringify({ type: "commonjs" }));
		await fs.writeFile("/app/value.js", "module.exports = 9;");

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.run("module.exports = require('/app/value.js');", "/app/entry.js");
		expect(result.exports).toBe(9);
	});

	it("uses Node-like main precedence for require and import when exports is absent", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.mkdir("/node_modules/entry-meta");
		await fs.writeFile(
			"/node_modules/entry-meta/package.json",
			JSON.stringify({
				name: "entry-meta",
				main: "main.cjs",
				module: "module.mjs",
			}),
		);
		await fs.writeFile(
			"/node_modules/entry-meta/main.cjs",
			"module.exports = { value: 'main-entry' };",
		);
		await fs.writeFile(
			"/node_modules/entry-meta/module.mjs",
			"export const value = 'module-entry';",
		);

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });

		const requireResult = await proc.run(`
	      const pkg = require('entry-meta');
	      module.exports = pkg.value;
	    `);
		expect(requireResult.exports).toBe("main-entry");

		const importResult = await proc.exec(
			`
	        import pkg from 'entry-meta';
	        console.log(pkg.value);
	      `,
			{ filePath: "/app/entry.mjs" },
		);
		expect(importResult.code).toBe(0);
		expect(importResult.stdout).toBe("main-entry\n");
	});

	it("returns builtin identifiers from require.resolve helpers", async () => {
		proc = new NodeProcess();
		const result = await proc.run(`
	      const Module = require('module');
	      module.exports = {
	        requireResolve: require.resolve('fs'),
	        createRequireResolve: Module.createRequire('/app/entry.js').resolve('path'),
	      };
	    `);

		expect(result.exports).toEqual({
			requireResolve: "fs",
			createRequireResolve: "path",
		});
	});

	it("supports default and named ESM imports for node:fs and node:path", async () => {
		proc = new NodeProcess();
		const result = await proc.exec(
			`
	      import fs, { readFileSync } from 'node:fs';
	      import path, { join, sep } from 'node:path';
	      console.log(
	        typeof readFileSync,
	        readFileSync === fs.readFileSync,
	        join === path.join,
	        sep === path.sep
	      );
	    `,
			{ filePath: "/entry.mjs" },
		);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("function true true true");
	});

	it("evaluates dynamic imports only when import() is reached", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile(
			"/app/side-effect.mjs",
			`
      console.log("side-effect");
      export const value = 1;
    `,
		);

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
      (async () => {
        console.log("before");
        await import("./side-effect.mjs");
        console.log("after");
      })();
    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("before\nside-effect\nafter\n");
	});

	it("does not evaluate dynamic imports in untaken branches", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile(
			"/app/unused.mjs",
			`
      console.log("loaded");
      export const value = 1;
    `,
		);

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
      (async () => {
        if (false) {
          await import("./unused.mjs");
        }
        console.log("done");
      })();
    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("done\n");
		expect(result.stdout).not.toContain("loaded");
	});

	it("returns cached namespace for repeated dynamic imports", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile(
			"/app/reused.mjs",
			`
      globalThis.__dynamicImportCount = (globalThis.__dynamicImportCount || 0) + 1;
      export const value = 42;
    `,
		);

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
      (async () => {
        const first = await import("./reused.mjs");
        const second = await import("./reused.mjs");

        if (first !== second) {
          throw new Error("namespace mismatch");
        }
        if (globalThis.__dynamicImportCount !== 1) {
          throw new Error("module evaluated multiple times");
        }

        console.log("ok");
      })();
    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("ok\n");
	});

	it("rejects dynamic import for missing modules with descriptive error", async () => {
		const fs = createFs();
		await fs.mkdir("/app");

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
      (async () => {
        await import("./missing.mjs");
      })();
    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Cannot load module: /app/missing.mjs");
	});

	it("preserves ESM syntax errors from dynamic import", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile("/app/broken.mjs", "export const broken = ;");

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
	      (async () => {
	        await import('./broken.mjs');
	      })();
	    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unexpected");
		expect(result.stderr).not.toContain("Cannot dynamically import");
	});

	it("preserves ESM evaluation errors from dynamic import", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile(
			"/app/throws.mjs",
			"throw new Error('dynamic-import-eval-failure');",
		);

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
	      (async () => {
	        await import('./throws.mjs');
	      })();
	    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dynamic-import-eval-failure");
		expect(result.stderr).not.toContain("Cannot dynamically import");
	});

	it("returns safe dynamic-import namespaces for primitive and null CommonJS exports", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile("/app/primitive.cjs", "module.exports = 7;");
		await fs.writeFile("/app/nullish.cjs", "module.exports = null;");

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(
			`
	      (async () => {
	        const primitive = await import('./primitive.cjs');
	        const nullish = await import('./nullish.cjs');
	        console.log(String(primitive.default) + '|' + String(nullish.default));
	      })();
	    `,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("7|null\n");
	});

	it("uses frozen timing values by default", async () => {
		proc = new NodeProcess();
		const result = await proc.run(`
      module.exports = {
        dateFrozen: Date.now() === Date.now(),
        perfFrozen: performance.now() === performance.now(),
        hrtimeFrozen: process.hrtime.bigint() === process.hrtime.bigint(),
        sharedArrayBufferType: typeof SharedArrayBuffer,
      };
    `);
		expect(result.exports).toEqual({
			dateFrozen: true,
			perfFrozen: true,
			hrtimeFrozen: true,
			sharedArrayBufferType: "undefined",
		});
	});

	it("restores advancing clocks when timing mitigation is off", async () => {
		proc = new NodeProcess({ timingMitigation: "off" });
		const result = await proc.exec(`
      (async () => {
        const dateStart = Date.now();
        const perfStart = performance.now();
        const hrStart = process.hrtime.bigint();
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log(JSON.stringify({
          dateAdvanced: Date.now() > dateStart,
          perfAdvanced: performance.now() > perfStart,
          hrtimeAdvanced: process.hrtime.bigint() > hrStart,
        }));
      })();
    `);
		expect(result.code).toBe(0);
		const metrics = JSON.parse(result.stdout.trim()) as {
			dateAdvanced: boolean;
			perfAdvanced: boolean;
			hrtimeAdvanced: boolean;
		};
		expect(metrics.dateAdvanced).toBe(true);
		expect(metrics.perfAdvanced).toBe(true);
		expect(metrics.hrtimeAdvanced).toBe(true);
	});

	it("times out non-terminating CommonJS execution with cpuTimeLimitMs", async () => {
		proc = new NodeProcess({ cpuTimeLimitMs: 100 });
		const result = await proc.exec("while (true) {}");
		expect(result.code).toBe(124);
		expect(result.stderr).toContain("CPU time limit exceeded");
	});

	it("times out non-terminating ESM execution with cpuTimeLimitMs", async () => {
		proc = new NodeProcess({ cpuTimeLimitMs: 100 });
		const result = await proc.exec("while (true) {}", { filePath: "/entry.mjs" });
		expect(result.code).toBe(124);
		expect(result.stderr).toContain("CPU time limit exceeded");
	});

	it("times out non-terminating dynamic import evaluation", async () => {
		const fs = createFs();
		await fs.mkdir("/app");
		await fs.writeFile("/app/loop.mjs", "while (true) {}");

		proc = new NodeProcess({
			filesystem: fs,
			permissions: allowAllFs,
			cpuTimeLimitMs: 100,
		});
		const result = await proc.exec(
			`
      (async () => {
        await import("./loop.mjs");
      })();
    `,
			{ filePath: "/app/entry.js" },
		);
		expect(result.code).toBe(124);
		expect(result.stderr).toContain("CPU time limit exceeded");
	});

	it("enforces shared cpuTimeLimitMs deadline during active-handle wait", async () => {
		proc = new NodeProcess({ cpuTimeLimitMs: 100 });
		const result = await proc.run(`
	      globalThis._waitForActiveHandles = () => new Promise(() => {});
	      module.exports = 42;
	    `);
		expect(result.code).toBe(124);
		expect(result.stderr).toContain("CPU time limit exceeded");
	});

	it("keeps isolate usable after cpuTimeLimitMs timeout", async () => {
		proc = new NodeProcess({ cpuTimeLimitMs: 100 });
		const timedOut = await proc.exec("while (true) {}");
		expect(timedOut.code).toBe(124);

		const recovered = await proc.run("module.exports = 7;");
		expect(recovered.code).toBe(0);
		expect(recovered.exports).toBe(7);
	});

	it("serves requests through bridged http.createServer and host network fetch", async () => {
		const driver = createNodeDriver({
			filesystem: new NodeFileSystem(),
			useDefaultNetwork: true,
			permissions: allowFsNetworkEnv,
		});
		proc = new NodeProcess({
			driver,
			processConfig: {
				cwd: "/",
			},
		});

		const port = 33221;
		const execPromise = proc.exec(
			`
      (async () => {
        const http = require('http');
        let server;
        server = http.createServer((req, res) => {
          if (req.url === '/shutdown') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('closing');
            server.close();
            return;
          }

          if (req.url === '/json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, runtime: 'sandboxed-node' }));
            return;
          }

          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('bridge-ok');
        });

        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(Number(process.env.TEST_PORT), process.env.TEST_HOST, resolve);
        });

        await new Promise((resolve) => {
          server.once('close', resolve);
        });
      })();
    `,
			{
				env: {
					TEST_PORT: String(port),
					TEST_HOST: "127.0.0.1",
				},
			},
		);

		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				const ready = await proc.network.fetch(
					`http://127.0.0.1:${port}/`,
					{ method: "GET" },
				);
				if (ready.status === 200) {
					break;
				}
			} catch {
				// Retry while server starts.
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		const textResponse = await proc.network.fetch(
			`http://127.0.0.1:${port}/`,
			{ method: "GET" },
		);
		expect(textResponse.status).toBe(200);
		expect(textResponse.body).toBe("bridge-ok");

		const jsonResponse = await proc.network.fetch(
			`http://127.0.0.1:${port}/json`,
			{ method: "GET" },
		);
		expect(jsonResponse.status).toBe(200);
		expect(jsonResponse.body).toContain('"ok":true');

		const shutdownResponse = await proc.network.fetch(
			`http://127.0.0.1:${port}/shutdown`,
			{ method: "GET" },
		);
		expect(shutdownResponse.status).toBe(200);

		const result = await execPromise;
		expect(result.code).toBe(0);
	});

	it("coerces 0.0.0.0 listen to loopback for strict sandboxing", async () => {
		const driver = createNodeDriver({
			filesystem: new NodeFileSystem(),
			useDefaultNetwork: true,
			permissions: allowFsNetworkEnv,
		});
		proc = new NodeProcess({
			driver,
			processConfig: {
				cwd: "/",
			},
		});

		const port = 33222;
		const execPromise = proc.exec(
			`
      (async () => {
        const http = require('http');
        let server;
        server = http.createServer((req, res) => {
          if (req.url === '/shutdown') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('closing');
            server.close();
            return;
          }
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('loopback-only');
        });

        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(Number(process.env.TEST_PORT), process.env.TEST_HOST, resolve);
        });
        await new Promise((resolve) => server.once('close', resolve));
      })();
    `,
			{
				env: {
					TEST_PORT: String(port),
					TEST_HOST: "0.0.0.0",
				},
			},
		);

		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				const ready = await proc.network.fetch(
					`http://127.0.0.1:${port}/`,
					{ method: "GET" },
				);
				if (ready.status === 200) {
					break;
				}
			} catch {
				// Retry while server starts.
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		const response = await proc.network.fetch(
			`http://127.0.0.1:${port}/`,
			{ method: "GET" },
		);
		expect(response.status).toBe(200);
		expect(response.body).toBe("loopback-only");

		const shutdown = await proc.network.fetch(
			`http://127.0.0.1:${port}/shutdown`,
			{ method: "GET" },
		);
		expect(shutdown.status).toBe(200);

		const result = await execPromise;
		expect(result.code).toBe(0);
	});

	it("can terminate a running sandbox HTTP server from host side", async () => {
		const driver = createNodeDriver({
			filesystem: new NodeFileSystem(),
			useDefaultNetwork: true,
			permissions: allowFsNetworkEnv,
		});
		proc = new NodeProcess({
			driver,
			processConfig: {
				cwd: "/",
			},
		});

		const port = 33223;
		const execPromise = proc.exec(
			`
      (async () => {
        const http = require('http');
        const server = http.createServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('running');
        });

        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(Number(process.env.TEST_PORT), process.env.TEST_HOST, resolve);
        });

        await new Promise(() => {
          // Keep alive until host termination.
        });
      })();
    `,
			{
				env: {
					TEST_PORT: String(port),
					TEST_HOST: "127.0.0.1",
				},
			},
		);

		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				const ready = await proc.network.fetch(
					`http://127.0.0.1:${port}/`,
					{ method: "GET" },
				);
				if (ready.status === 200) {
					break;
				}
			} catch {
				// Retry while server starts.
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		const response = await proc.network.fetch(
			`http://127.0.0.1:${port}/`,
			{ method: "GET" },
		);
		expect(response.status).toBe(200);
		expect(response.body).toBe("running");

		await proc.terminate();

		const result = await Promise.race([
			execPromise,
			new Promise<{ code: number }>((resolve) =>
				setTimeout(() => resolve({ code: -999 }), 2000),
			),
		]);
		expect(result.code).not.toBe(-999);
	});
});
