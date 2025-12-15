import { init, Wasmer, Directory, Instance } from "@wasmer/sdk/node";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

export interface TerminalOptions {
  /** Directory to mount as root filesystem */
  directory?: Directory;
  /** Path to load files from host filesystem */
  hostPath?: string;
  /** Command to run (default: bash) */
  command?: string;
}

let wasmerInitialized = false;
let wasixRuntime: Awaited<ReturnType<typeof Wasmer.fromFile>> | null = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Load the wasix-runtime package
 */
async function loadRuntime(): Promise<void> {
  if (wasixRuntime) return;

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // Try multiple paths to find wasix-runtime.webc
  const possiblePaths = [
    path.resolve(currentDir, "../../nano-sandbox/assets/wasix-runtime.webc"),
    path.resolve(currentDir, "../../../nano-sandbox/assets/wasix-runtime.webc"),
    path.resolve(currentDir, "../assets/wasix-runtime.webc"),
  ];

  for (const webcPath of possiblePaths) {
    try {
      const webcBytes = await fs.readFile(webcPath);
      wasixRuntime = await Wasmer.fromFile(webcBytes);
      return;
    } catch {
      // Try next path
    }
  }

  throw new Error(
    "wasix-runtime.webc not found. Tried paths:\n" + possiblePaths.join("\n")
  );
}

/**
 * Connect terminal streams to WASM instance
 */
function connectStreams(instance: Instance): void {
  const stdin = instance.stdin?.getWriter();

  // Set up stdin from process.stdin
  if (stdin && process.stdin.isTTY) {
    // Enable raw mode for character-by-character input
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (data: string) => {
      // Handle Ctrl+C
      if (data === "\x03") {
        console.log("\n^C");
        process.exit(0);
      }
      // Handle Ctrl+D (EOF)
      if (data === "\x04") {
        stdin.close();
        return;
      }
      stdin.write(encoder.encode(data));
    });
  } else if (stdin) {
    // Non-TTY mode (piped input)
    process.stdin.on("data", (chunk: Buffer) => {
      stdin.write(new Uint8Array(chunk));
    });
    process.stdin.on("end", () => {
      stdin.close();
    });
  }

  // Connect stdout
  instance.stdout.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        const text = decoder.decode(chunk);
        // Convert \n to \r\n for proper terminal display
        process.stdout.write(text.replace(/\n/g, "\r\n"));
      },
    })
  );

  // Connect stderr
  instance.stderr.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        const text = decoder.decode(chunk);
        process.stderr.write(text.replace(/\n/g, "\r\n"));
      },
    })
  );
}

/**
 * Start an interactive terminal session
 */
export async function startTerminal(options: TerminalOptions = {}): Promise<number> {
  // Initialize wasmer
  if (!wasmerInitialized) {
    await init();
    wasmerInitialized = true;
  }

  await loadRuntime();

  if (!wasixRuntime) {
    throw new Error("Failed to load wasix runtime");
  }

  // Create or use provided directory
  const directory = options.directory ?? new Directory();

  // Load files from host if path provided
  if (options.hostPath) {
    await loadHostDirectory(options.hostPath, directory);
  }

  // Get the command to run
  const commandName = options.command ?? "bash";
  const cmd = wasixRuntime.commands[commandName];
  if (!cmd) {
    throw new Error(`Command not found: ${commandName}`);
  }

  // Run the command
  const instance = await cmd.run({
    args: [],
    mount: { "/": directory },
  });

  // Connect streams
  connectStreams(instance);

  // Wait for the command to complete
  const result = await instance.wait();

  // Restore terminal settings
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  return result.code ?? 0;
}

/**
 * Load files from host directory into wasmer Directory
 */
async function loadHostDirectory(
  hostPath: string,
  directory: Directory,
  virtualBasePath: string = "/"
): Promise<void> {
  const stats = await fs.stat(hostPath);
  if (!stats.isDirectory()) {
    throw new Error(`hostPath must be a directory: ${hostPath}`);
  }

  await copyDirectory(hostPath, virtualBasePath, directory);
}

async function copyDirectory(
  hostDir: string,
  virtualDir: string,
  directory: Directory
): Promise<void> {
  const entries = await fs.readdir(hostDir, { withFileTypes: true });

  for (const entry of entries) {
    const hostEntryPath = path.join(hostDir, entry.name);
    const virtualEntryPath = path.posix.join(virtualDir, entry.name);

    if (entry.isSymbolicLink()) {
      try {
        const realPath = await fs.realpath(hostEntryPath);
        const realStats = await fs.stat(realPath);

        if (realStats.isDirectory()) {
          directory.createDir(virtualEntryPath);
          await copyDirectory(realPath, virtualEntryPath, directory);
        } else if (realStats.isFile()) {
          const content = await fs.readFile(realPath);
          directory.writeFile(virtualEntryPath, content);
        }
      } catch {
        // Skip broken symlinks
      }
    } else if (entry.isDirectory()) {
      directory.createDir(virtualEntryPath);
      await copyDirectory(hostEntryPath, virtualEntryPath, directory);
    } else if (entry.isFile()) {
      const content = await fs.readFile(hostEntryPath);
      directory.writeFile(virtualEntryPath, content);
    }
  }
}

export { Directory };
