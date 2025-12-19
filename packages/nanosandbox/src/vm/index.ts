import { init } from "@wasmer/sdk/node";
import type { VFS } from "@wasmer/sdk/node";
import { NodeProcess, createDefaultNetworkAdapter } from "sandboxed-node";
import {
	DATA_MOUNT_PATH,
	InteractiveSession,
	WasixInstance,
} from "../wasix/index.js";
import { createVirtualFileSystem } from "./node-vfs.js";

export { WasixInstance, InteractiveSession, DATA_MOUNT_PATH };

export interface SpawnResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface SpawnOptions {
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface VirtualMachineOptions {
	memoryLimit?: number; // MB, default 128 for isolates
}

let wasmerInitialized = false;

export class VirtualMachine {
	private options: VirtualMachineOptions;
	private initialized = false;
	private wasixInstance: WasixInstance | null = null;

	constructor(options: VirtualMachineOptions = {}) {
		this.options = options;
	}

	/**
	 * Initialize the VM (ensures wasmer is initialized)
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		if (!wasmerInitialized) {
			await init();
			wasmerInitialized = true;
		}

		// Create WasixInstance with NodeProcess factory
		// The factory creates a fresh NodeProcess per-spawn with the spawn's VFS
		this.wasixInstance = new WasixInstance({
			nodeProcessFactory: (vfs: VFS) => {
				const virtualFs = createVirtualFileSystem(vfs);
				return new NodeProcess({
					memoryLimit: this.options.memoryLimit,
					filesystem: virtualFs,
					osConfig: { homedir: "/data/root" },
					networkAdapter: createDefaultNetworkAdapter(),
				});
			},
			memoryLimit: this.options.memoryLimit,
		});

		this.initialized = true;
	}

	/**
	 * Spawn a command in the virtual machine.
	 * Each spawn is isolated - no shared state between spawns.
	 */
	async spawn(command: string, options: SpawnOptions = {}): Promise<SpawnResult> {
		await this.init();

		if (!this.wasixInstance) {
			throw new Error("VirtualMachine not properly initialized");
		}

		const { args = [], env, cwd } = options;

		// All commands go through WasixInstance
		// Node commands are handled via IPC when the WASM "node" binary runs
		return this.wasixInstance.runWithIpc(command, args, env, cwd);
	}

	/**
	 * Run an interactive command with streaming I/O.
	 * Returns an InteractiveSession for stream access.
	 */
	async runInteractive(
		command: string,
		args: string[] = [],
	): Promise<InteractiveSession> {
		await this.init();

		if (!this.wasixInstance) {
			throw new Error("VirtualMachine not properly initialized");
		}

		return this.wasixInstance.runInteractive(command, args);
	}

	/**
	 * Dispose of resources
	 */
	dispose(): void {
		this.wasixInstance = null;
		this.initialized = false;
	}

	/**
	 * Dispose of resources and wait for async cleanup to settle.
	 * Use this in tests to avoid wasmer SDK async cleanup errors.
	 */
	async disposeAsync(): Promise<void> {
		this.dispose();
		// Give wasmer SDK time to complete async cleanup operations
		// This works around wasmer-js bugs where cleanup throws after disposal
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
