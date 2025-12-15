import ivm from "isolated-vm";

export interface NodeProcessOptions {
  memoryLimit?: number; // MB, default 128
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class NodeProcess {
  private isolate: ivm.Isolate;
  private context: ivm.Context | null = null;
  private memoryLimit: number;

  constructor(options: NodeProcessOptions = {}) {
    this.memoryLimit = options.memoryLimit ?? 128;
    this.isolate = new ivm.Isolate({ memoryLimit: this.memoryLimit });
  }

  /**
   * Run code and return the value of module.exports
   */
  async run<T = unknown>(code: string): Promise<T> {
    const context = await this.isolate.createContext();

    try {
      // Set up module.exports
      const jail = context.global;
      await jail.set("global", jail.derefInto());

      // Create module object
      const moduleObj = await this.isolate.compileScript(
        "globalThis.module = { exports: {} };"
      );
      await moduleObj.run(context);

      // Run user code
      const script = await this.isolate.compileScript(code);
      await script.run(context);

      // Get module.exports
      const result = await context.eval("module.exports", { copy: true });
      return result as T;
    } finally {
      context.release();
    }
  }

  /**
   * Execute code like a script with console output capture
   */
  async exec(code: string): Promise<RunResult> {
    const context = await this.isolate.createContext();
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const jail = context.global;
      await jail.set("global", jail.derefInto());

      // Set up console with output capture via References
      const logRef = new ivm.Reference((msg: string) => {
        stdout.push(String(msg));
      });
      const errorRef = new ivm.Reference((msg: string) => {
        stderr.push(String(msg));
      });

      await jail.set("_log", logRef);
      await jail.set("_error", errorRef);

      await context.eval(`
        globalThis.console = {
          log: (...args) => _log.applySync(undefined, [args.map(a =>
            typeof a === 'object' ? JSON.stringify(a) : String(a)
          ).join(' ')]),
          error: (...args) => _error.applySync(undefined, [args.map(a =>
            typeof a === 'object' ? JSON.stringify(a) : String(a)
          ).join(' ')]),
          warn: (...args) => _error.applySync(undefined, [args.map(a =>
            typeof a === 'object' ? JSON.stringify(a) : String(a)
          ).join(' ')]),
          info: (...args) => _log.applySync(undefined, [args.map(a =>
            typeof a === 'object' ? JSON.stringify(a) : String(a)
          ).join(' ')]),
        };
        globalThis.module = { exports: {} };
      `);

      // Run user code
      const script = await this.isolate.compileScript(code);
      await script.run(context);

      return {
        stdout: stdout.join("\n") + (stdout.length > 0 ? "\n" : ""),
        stderr: stderr.join("\n") + (stderr.length > 0 ? "\n" : ""),
        code: 0,
      };
    } catch (err) {
      stderr.push(err instanceof Error ? err.message : String(err));
      return {
        stdout: stdout.join("\n") + (stdout.length > 0 ? "\n" : ""),
        stderr: stderr.join("\n") + (stderr.length > 0 ? "\n" : ""),
        code: 1,
      };
    } finally {
      context.release();
    }
  }

  dispose(): void {
    this.isolate.dispose();
  }
}
