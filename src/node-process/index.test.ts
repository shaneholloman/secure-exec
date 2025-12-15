import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { init, Directory } from "@wasmer/sdk/node";
import { NodeProcess } from "./index";
import { SystemBridge } from "../system-bridge/index";

describe("NodeProcess", () => {
  let proc: NodeProcess;

  beforeAll(async () => {
    await init();
  });

  afterEach(() => {
    proc?.dispose();
  });

  describe("Step 1: Basic isolate execution", () => {
    it("should run basic code and return module.exports", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`module.exports = 1 + 1`);
      expect(result).toBe(2);
    });

    it("should return complex objects", async () => {
      proc = new NodeProcess();
      const result = await proc.run<{ foo: string; bar: number }>(
        `module.exports = { foo: "hello", bar: 42 }`
      );
      expect(result).toEqual({ foo: "hello", bar: 42 });
    });

    it("should execute code with console output", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`console.log("hello world")`);
      expect(result.stdout).toBe("hello world\n");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });

    it("should capture errors to stderr", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`throw new Error("oops")`);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("oops");
    });

    it("should capture console.error to stderr", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`console.error("bad thing")`);
      expect(result.stderr).toBe("bad thing\n");
      expect(result.code).toBe(0);
    });
  });

  describe("Step 2: require() with node stdlib polyfills", () => {
    it("should require path module and use join", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const path = require("path");
        module.exports = path.join("foo", "bar");
      `);
      expect(result).toBe("foo/bar");
    });

    it("should require path module with node: prefix", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const path = require("node:path");
        module.exports = path.dirname("/foo/bar/baz.txt");
      `);
      expect(result).toBe("/foo/bar");
    });

    it("should require events module", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const { EventEmitter } = require("events");
        const emitter = new EventEmitter();
        let called = false;
        emitter.on("test", () => { called = true; });
        emitter.emit("test");
        module.exports = called;
      `);
      expect(result).toBe(true);
    });

    it("should require util module", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const util = require("util");
        module.exports = util.format("hello %s", "world");
      `);
      expect(result).toBe("hello world");
    });

    it("should cache modules", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const path1 = require("path");
        const path2 = require("path");
        module.exports = path1 === path2;
      `);
      expect(result).toBe(true);
    });

    it("should throw for unknown modules", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`
        const unknown = require("nonexistent-module");
      `);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Cannot find module");
    });
  });

  describe("Step 8: Package imports from node_modules", () => {
    it("should load a simple package from virtual node_modules", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Create a simple mock package
      bridge.mkdir("/node_modules/my-pkg");
      bridge.writeFile(
        "/node_modules/my-pkg/package.json",
        JSON.stringify({ name: "my-pkg", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/my-pkg/index.js",
        `module.exports = { add: (a, b) => a + b };`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const pkg = require('my-pkg');
        module.exports = pkg.add(2, 3);
      `);

      expect(result).toBe(5);
    });

    it("should load package with default index.js", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Package without explicit main
      bridge.mkdir("/node_modules/simple-pkg");
      bridge.writeFile(
        "/node_modules/simple-pkg/package.json",
        JSON.stringify({ name: "simple-pkg" })
      );
      bridge.writeFile(
        "/node_modules/simple-pkg/index.js",
        `module.exports = "hello from simple-pkg";`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const pkg = require('simple-pkg');
        module.exports = pkg;
      `);

      expect(result).toBe("hello from simple-pkg");
    });

    it("should prioritize polyfills over node_modules", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Even if path exists in node_modules, polyfill should be used
      bridge.mkdir("/node_modules/path");
      bridge.writeFile(
        "/node_modules/path/package.json",
        JSON.stringify({ name: "path", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/path/index.js",
        `module.exports = { fake: true };`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const path = require('path');
        // Real path polyfill has join, our fake doesn't
        module.exports = typeof path.join === 'function';
      `);

      expect(result).toBe(true);
    });

    it("should use setSystemBridge to add bridge later", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      bridge.mkdir("/node_modules/late-pkg");
      bridge.writeFile(
        "/node_modules/late-pkg/package.json",
        JSON.stringify({ name: "late-pkg", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/late-pkg/index.js",
        `module.exports = 42;`
      );

      proc = new NodeProcess();
      proc.setSystemBridge(bridge);

      const result = await proc.run(`
        const pkg = require('late-pkg');
        module.exports = pkg;
      `);

      expect(result).toBe(42);
    });
  });

  describe("Dynamic CommonJS module resolution", () => {
    it("should resolve relative imports", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Create a file with relative import
      bridge.mkdir("/lib");
      bridge.writeFile("/lib/helper.js", `module.exports = { greet: () => 'Hello' };`);
      bridge.writeFile(
        "/main.js",
        `const helper = require('./lib/helper'); module.exports = helper.greet();`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const main = require('/main.js');
        module.exports = main;
      `);

      expect(result).toBe("Hello");
    });

    it("should resolve parent directory imports", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      bridge.mkdir("/src/utils");
      bridge.writeFile("/src/config.js", `module.exports = { name: 'test' };`);
      bridge.writeFile(
        "/src/utils/reader.js",
        `const config = require('../config'); module.exports = config.name;`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const reader = require('/src/utils/reader.js');
        module.exports = reader;
      `);

      expect(result).toBe("test");
    });

    it("should load JSON files", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      bridge.writeFile("/data.json", JSON.stringify({ version: "1.0.0" }));

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const data = require('/data.json');
        module.exports = data.version;
      `);

      expect(result).toBe("1.0.0");
    });

    it("should handle nested requires with dependencies", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Create a package with internal dependencies
      bridge.mkdir("/node_modules/my-lib");
      bridge.writeFile(
        "/node_modules/my-lib/package.json",
        JSON.stringify({ name: "my-lib", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/my-lib/utils.js",
        `module.exports = { double: x => x * 2 };`
      );
      bridge.writeFile(
        "/node_modules/my-lib/index.js",
        `const utils = require('./utils'); module.exports = { calc: x => utils.double(x) };`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const lib = require('my-lib');
        module.exports = lib.calc(5);
      `);

      expect(result).toBe(10);
    });

    it("should handle package subpath imports", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      bridge.mkdir("/node_modules/toolkit");
      bridge.writeFile(
        "/node_modules/toolkit/package.json",
        JSON.stringify({ name: "toolkit", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/toolkit/index.js",
        `module.exports = { main: true };`
      );
      bridge.writeFile(
        "/node_modules/toolkit/extra.js",
        `module.exports = { extra: true };`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const extra = require('toolkit/extra');
        module.exports = extra.extra;
      `);

      expect(result).toBe(true);
    });

    it("should cache modules", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      bridge.writeFile("/counter.js", `
        let count = 0;
        module.exports = { increment: () => ++count };
      `);

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const c1 = require('/counter.js');
        const c2 = require('/counter.js');
        c1.increment();
        c1.increment();
        module.exports = c2.increment();
      `);

      // If caching works, c2 is the same instance as c1
      expect(result).toBe(3);
    });
  });

  describe("fs polyfill", () => {
    it("should read and write files", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const fs = require('fs');
        fs.writeFileSync('/test.txt', 'hello world');
        module.exports = fs.readFileSync('/test.txt', 'utf8');
      `);

      expect(result).toBe("hello world");
    });

    it("should check file existence", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);
      bridge.writeFile("/existing.txt", "content");

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const fs = require('fs');
        module.exports = {
          exists: fs.existsSync('/existing.txt'),
          notExists: fs.existsSync('/nonexistent.txt'),
        };
      `);

      expect(result).toEqual({ exists: true, notExists: false });
    });

    it("should get file stats", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);
      bridge.writeFile("/myfile.txt", "hello");

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const fs = require('fs');
        const stats = fs.statSync('/myfile.txt');
        module.exports = {
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
        };
      `);

      expect(result).toEqual({
        isFile: true,
        isDirectory: false,
        size: 5,
      });
    });

    it("should read directory contents", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);
      bridge.mkdir("/mydir");
      bridge.writeFile("/mydir/a.txt", "a");
      bridge.writeFile("/mydir/b.txt", "b");

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run<string[]>(`
        const fs = require('fs');
        module.exports = fs.readdirSync('/mydir').sort();
      `);

      expect(result).toContain("a.txt");
      expect(result).toContain("b.txt");
    });

    it("should delete files", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);
      bridge.writeFile("/todelete.txt", "content");

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const fs = require('fs');
        const existsBefore = fs.existsSync('/todelete.txt');
        fs.unlinkSync('/todelete.txt');
        const existsAfter = fs.existsSync('/todelete.txt');
        module.exports = { existsBefore, existsAfter };
      `);

      expect(result).toEqual({ existsBefore: true, existsAfter: false });
    });

    it("should work with file descriptors", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const fs = require('fs');
        const fd = fs.openSync('/fd-test.txt', 'w');
        fs.writeSync(fd, 'hello');
        fs.closeSync(fd);
        module.exports = fs.readFileSync('/fd-test.txt', 'utf8');
      `);

      expect(result).toBe("hello");
    });

    it("should append to files", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);
      bridge.writeFile("/append.txt", "hello");

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const fs = require('fs');
        fs.appendFileSync('/append.txt', ' world');
        module.exports = fs.readFileSync('/append.txt', 'utf8');
      `);

      expect(result).toBe("hello world");
    });

    it("should create directories", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const fs = require('fs');
        fs.mkdirSync('/newdir');
        fs.writeFileSync('/newdir/file.txt', 'content');
        module.exports = fs.existsSync('/newdir/file.txt');
      `);

      expect(result).toBe(true);
    });
  });
});
