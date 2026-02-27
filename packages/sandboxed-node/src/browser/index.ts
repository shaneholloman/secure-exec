// @ts-nocheck
import type {
	ExecOptions,
	ExecResult,
	OSConfig,
	ProcessConfig,
	RunResult,
} from "../shared/api-types.js";
import type { Permissions } from "../types.js";

export interface BrowserSandboxOptions {
	processConfig?: ProcessConfig;
	osConfig?: OSConfig;
	permissions?: Permissions;
	filesystem?: "opfs" | "memory";
	networkEnabled?: boolean;
	workerUrl?: URL | string;
}

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
};

type SerializedPermissions = {
	fs?: string;
	network?: string;
	childProcess?: string;
	env?: string;
};

type WorkerRequest =
	| { id: number; type: "init"; payload: unknown }
	| { id: number; type: "exec"; payload: { code: string; options?: ExecOptions } }
	| { id: number; type: "run"; payload: { code: string; filePath?: string } }
	| { id: number; type: "dispose" };

type WorkerResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; error: { message: string; stack?: string; code?: string } };

function serializePermissions(permissions?: Permissions): SerializedPermissions | undefined {
	if (!permissions) return undefined;
	const serialize = (fn?: unknown) => (typeof fn === "function" ? fn.toString() : undefined);
	return {
		fs: serialize(permissions.fs),
		network: serialize(permissions.network),
		childProcess: serialize(permissions.childProcess),
		env: serialize(permissions.env),
	};
}

export class BrowserSandbox {
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private ready: Promise<void>;

	constructor(options: BrowserSandboxOptions = {}) {
		const workerUrl =
			options.workerUrl instanceof URL
				? options.workerUrl
				: options.workerUrl
					? new URL(options.workerUrl, import.meta.url)
					: new URL("./worker.js", import.meta.url);

		this.worker = new Worker(workerUrl, { type: "module" });
		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const message = event.data;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.ok) {
				pending.resolve(message.result);
			} else {
				const err = new Error(message.error.message);
				if (message.error.stack) err.stack = message.error.stack;
				(err as { code?: string }).code = message.error.code;
				pending.reject(err);
			}
		};

		this.ready = this.callWorker("init", {
			processConfig: options.processConfig,
			osConfig: options.osConfig,
			permissions: serializePermissions(options.permissions),
			filesystem: options.filesystem ?? "opfs",
			networkEnabled: options.networkEnabled ?? false,
		}).then(() => undefined);
	}

	private callWorker<T = unknown>(type: WorkerRequest["type"], payload?: unknown): Promise<T> {
		const id = this.nextId++;
		const message: WorkerRequest = { id, type, payload } as WorkerRequest;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage(message);
		}) as Promise<T>;
	}

	async exec(code: string, options?: ExecOptions): Promise<ExecResult> {
		await this.ready;
		return this.callWorker<ExecResult>("exec", { code, options });
	}

	async run<T = unknown>(code: string, filePath?: string): Promise<RunResult<T>> {
		await this.ready;
		return this.callWorker<RunResult<T>>("run", { code, filePath });
	}

	async dispose(): Promise<void> {
		await this.callWorker("dispose");
		this.worker.terminate();
	}
}

export { createBrowserDriver, createBrowserNetworkAdapter, createOpfsFileSystem } from "./driver.js";
export { createInMemoryFileSystem } from "../shared/in-memory-fs.js";
