import { describe, it, expect, afterEach } from "vitest";
import { NodeProcess } from "./index";

describe("NodeProcess", () => {
  let proc: NodeProcess;

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
});
