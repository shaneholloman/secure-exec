import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Directory, init, Wasmer, createVFS } from "@wasmer/sdk/node";
import type { VFS } from "@wasmer/sdk/node";
import type { NodeProcess } from "sandboxed-node";

/** Type for a wasmer command from a loaded package */
type WasmerCommand = Awaited<
	ReturnType<typeof Wasmer.fromFile>
>["commands"][string];

/** Type for a running wasmer instance */
type WasmerInstance = Awaited<ReturnType<WasmerCommand["run"]>>;

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface InteractiveSession {
	/** The running WASM instance - use stdin/stdout/stderr for streaming */
	instance: WasmerInstance;
	/** Wait for the command to complete and get exit code */
	wait(): Promise<number>;
	/** Stop the IPC poller (call when done) */
	stop(): void;
}

export interface WasixInstanceOptions {
	nodeProcessFactory?: (vfs: VFS) => NodeProcess;
	memoryLimit?: number; // MB - reserved for future WASM memory limiting
}

const POLL_INTERVAL_MS = 20;

/**
 * Mount path for the user's Directory in the WASM filesystem.
 * Files written to the Directory at "/foo.txt" will be accessible at "/data/foo.txt"
 */
export const DATA_MOUNT_PATH = "/data";

/**
 * Mount path for IPC communication between WASM and NodeProcess.
 */
export const IPC_MOUNT_PATH = "/ipc";

let wasmerInitialized = false;
let wasixRuntime: Awaited<ReturnType<typeof Wasmer.fromFile>> | null = null;

/**
 * WasixInstance provides isolated command execution.
 * Each spawn creates a fresh Instance with its own filesystem.
 */
export class WasixInstance {
	private nodeProcessFactory?: (vfs: VFS) => NodeProcess;
	private memoryLimit?: number;
	private initialized = false;

	constructor(options: WasixInstanceOptions = {}) {
		this.nodeProcessFactory = options.nodeProcessFactory;
		this.memoryLimit = options.memoryLimit;
	}

	/**
	 * Initialize the WASIX runtime (loads the runtime package once)
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		if (!wasmerInitialized) {
			await init({ log: "warn" });
			wasmerInitialized = true;
		}

		// Load runtime package (includes bash + node-shim for IPC)
		if (!wasixRuntime) {
			const currentDir = path.dirname(fileURLToPath(import.meta.url));
			const webcPath = path.resolve(currentDir, "../../assets/runtime.webc");
			const webcBytes = await fs.readFile(webcPath);
			wasixRuntime = await Wasmer.fromFile(webcBytes);
		}

		this.initialized = true;
	}

	/**
	 * Execute a shell command string.
	 * Each call creates a fresh isolated Instance.
	 */
	async exec(commandString: string): Promise<ExecResult> {
		await this.init();
		return this.run("bash", ["-c", commandString]);
	}

	/**
	 * Run a specific command with arguments.
	 * Each call creates a fresh isolated Instance with IPC support.
	 */
	async run(commandName: string, args: string[] = []): Promise<ExecResult> {
		await this.init();

		if (!wasixRuntime) {
			throw new Error("WASIX not properly initialized");
		}

		const cmd = wasixRuntime.commands[commandName];
		if (!cmd) {
			throw new Error(`Command not found: ${commandName}`);
		}

		// Create fresh directories for this spawn
		const directory = new Directory();
		const ipcDir = new Directory();

		// Start the command
		const instance = await cmd.run({
			args,
			mount: {
				[DATA_MOUNT_PATH]: directory,
				[IPC_MOUNT_PATH]: ipcDir,
			},
		});

		// Get VFS from this instance
		const vfs = createVFS(instance);

		// Create NodeProcess for this spawn if factory provided
		const nodeProcess = this.nodeProcessFactory?.(vfs) ?? null;

		// Start IPC poller
		let pollActive = true;
		const pollPromise = this.runIpcPoller(ipcDir, vfs, nodeProcess, () => pollActive);

		// Wait for command to complete - output is in the result
		const result = await instance.wait();

		// Stop IPC poller
		pollActive = false;
		await pollPromise;

		// Dispose NodeProcess if created
		if (nodeProcess) {
			nodeProcess.dispose();
		}

		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code ?? 0,
		};
	}

	/**
	 * Run a command with IPC support (same as run, kept for compatibility)
	 */
	async runWithIpc(
		commandName: string,
		args: string[] = [],
		_env?: Record<string, string>,
		_cwd?: string,
	): Promise<ExecResult> {
		return this.run(commandName, args);
	}

	/**
	 * Run an interactive command with streaming I/O
	 */
	async runInteractive(
		commandName: string,
		args: string[] = [],
	): Promise<InteractiveSession> {
		await this.init();

		if (!wasixRuntime) {
			throw new Error("WASIX not properly initialized");
		}

		const cmd = wasixRuntime.commands[commandName];
		if (!cmd) {
			throw new Error(`Command not found: ${commandName}`);
		}

		// Create fresh directories for this session
		const directory = new Directory();
		const ipcDir = new Directory();

		let pollActive = true;

		const instance = await cmd.run({
			args,
			mount: {
				[DATA_MOUNT_PATH]: directory,
				[IPC_MOUNT_PATH]: ipcDir,
			},
		});

		const vfs = createVFS(instance);
		const nodeProcess = this.nodeProcessFactory?.(vfs) ?? null;
		const pollPromise = this.runIpcPoller(ipcDir, vfs, nodeProcess, () => pollActive);

		return {
			instance,
			async wait(): Promise<number> {
				const result = await instance.wait();
				pollActive = false;
				await pollPromise;
				if (nodeProcess) {
					nodeProcess.dispose();
				}
				return result.code ?? 0;
			},
			stop(): void {
				pollActive = false;
			},
		};
	}

	/**
	 * Run the IPC poller for node execution support
	 */
	private async runIpcPoller(
		ipcDir: Directory,
		vfs: VFS,
		nodeProcess: NodeProcess | null,
		isActive: () => boolean,
	): Promise<void> {
		while (isActive()) {
			try {
				const requestContent = await ipcDir.readTextFile("/request.txt");
				let nodeArgs = requestContent.trim().split("\n").filter(Boolean);

				// Handle --ipc-script
				const ipcScriptIdx = nodeArgs.indexOf("--ipc-script");
				if (ipcScriptIdx !== -1) {
					const scriptContent = await ipcDir.readTextFile("/script.js");
					nodeArgs = ["-e", scriptContent];
				}

				let nodeResult: { exitCode: number; stdout: string; stderr: string };

				if (nodeProcess) {
					nodeResult = await this.executeNodeViaProcess(nodeArgs, vfs, nodeProcess);
				} else {
					nodeResult = await this.executeNodeViaSpawn(nodeArgs);
				}

				const responseContent = `${nodeResult.exitCode}\n${nodeResult.stdout}`;
				await ipcDir.writeFile("/response.txt", responseContent);

				try {
					await ipcDir.removeFile("/request.txt");
					await ipcDir.removeFile("/script.js");
				} catch {
					// Ignore
				}
			} catch {
				await sleep(POLL_INTERVAL_MS);
			}
		}
	}

	/**
	 * Execute node code via NodeProcess (isolated-vm)
	 */
	private async executeNodeViaProcess(
		args: string[],
		vfs: VFS,
		nodeProcess: NodeProcess,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		let code = "";

		for (let i = 0; i < args.length; i++) {
			if (args[i] === "-e" || args[i] === "--eval") {
				code = args[i + 1] || "";
				break;
			} else if (!args[i].startsWith("-")) {
				const scriptPath = args[i];
				try {
					code = await vfs.readTextFile(scriptPath);
				} catch {
					return {
						exitCode: 1,
						stdout: "",
						stderr: `Cannot find module '${scriptPath}'`,
					};
				}
				break;
			}
		}

		if (!code) {
			return { exitCode: 0, stdout: "", stderr: "" };
		}

		const result = await nodeProcess.exec(code);
		return {
			exitCode: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}

	/**
	 * Execute node by spawning real node process (fallback)
	 */
	private async executeNodeViaSpawn(
		args: string[],
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const { spawn } = await import("node:child_process");

		return new Promise((resolve) => {
			const proc = spawn("node", args, {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				resolve({
					exitCode: code ?? 1,
					stdout,
					stderr,
				});
			});

			proc.on("error", (err) => {
				resolve({
					exitCode: 1,
					stdout: "",
					stderr: err.message,
				});
			});
		});
	}

	/**
	 * Dispose is a no-op since each spawn is isolated
	 */
	async dispose(): Promise<void> {
		// No persistent state to clean up
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Directory, createVFS };
export type { VFS };
