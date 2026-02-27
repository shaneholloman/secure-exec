import ivm from "isolated-vm";
import { getBridgeWithConfig } from "./bridge-loader.js";
import { exists, mkdir, readDirWithTypes, rename, stat } from "./fs-helpers.js";
import { loadFile, resolveModule } from "./package-bundler.js";
import { bundlePolyfill, hasPolyfill } from "./polyfills.js";
import { createNodeDriver } from "./node/driver.js";
import {
	createCommandExecutorStub,
	createFsStub,
	createNetworkStub,
	filterEnv,
	wrapCommandExecutor,
	wrapFileSystem,
	wrapNetworkAdapter,
} from "./shared/permissions.js";
import {
	extractDynamicImportSpecifiers,
	isESM,
	transformDynamicImport,
	wrapCJSForESM,
} from "./shared/esm-utils.js";
import { getRequireSetupCode } from "./shared/require-setup.js";
import type {
	CommandExecutor,
	NetworkAdapter,
	Permissions,
	SandboxDriver,
	SpawnedProcess,
	VirtualFileSystem,
} from "./types.js";
import type {
	ExecOptions,
	ExecResult,
	OSConfig,
	ProcessConfig,
	RunResult,
	TimingMitigation,
} from "./shared/api-types.js";

// Re-export types
export type {
	CommandExecutor,
	NetworkAdapter,
	Permissions,
	SandboxDriver,
	VirtualFileSystem,
} from "./types.js";
export type { DirEntry, StatInfo } from "./fs-helpers.js";
export type {
	ExecOptions,
	ExecResult,
	OSConfig,
	ProcessConfig,
	RunResult,
	TimingMitigation,
} from "./shared/api-types.js";
export {
	createDefaultNetworkAdapter,
	createNodeDriver,
	NodeFileSystem,
} from "./node/driver.js";
export { createInMemoryFileSystem } from "./shared/in-memory-fs.js";
export {
	allowAll,
	allowAllChildProcess,
	allowAllEnv,
	allowAllFs,
	allowAllNetwork,
} from "./shared/permissions.js";

// Config types for process and os modules


export interface NodeProcessOptions {
	memoryLimit?: number; // MB, default 128
	cpuTimeLimitMs?: number; // Maximum execution time budget in milliseconds
	driver?: SandboxDriver; // Preferred system driver
	permissions?: Permissions; // Applied when creating default driver
	filesystem?: VirtualFileSystem; // For accessing virtual filesystem
	processConfig?: ProcessConfig; // Process object configuration
	commandExecutor?: CommandExecutor; // For child_process support
	networkAdapter?: NetworkAdapter; // For network support (fetch, http, https, dns)
	osConfig?: OSConfig; // OS module configuration
	timingMitigation?: TimingMitigation; // Timing side-channel mitigation mode
}

// Cache of bundled polyfills
const polyfillCodeCache: Map<string, string> = new Map();
const DEFAULT_TIMING_MITIGATION: TimingMitigation = "freeze";
const TIMEOUT_EXIT_CODE = 124;
const TIMEOUT_ERROR_MESSAGE = "CPU time limit exceeded";

class ExecutionTimeoutError extends Error {
	constructor() {
		super(TIMEOUT_ERROR_MESSAGE);
		this.name = "ExecutionTimeoutError";
	}
}

const BRIDGE_MODULES = [
	"fs",
	"fs/promises",
	"module",
	"os",
	"http",
	"https",
	"http2",
	"dns",
	"child_process",
	"process",
	"v8",
] as const;

const DEFERRED_CORE_MODULES = [
	"net",
	"tls",
	"readline",
	"perf_hooks",
	"async_hooks",
	"worker_threads",
] as const;

const UNSUPPORTED_CORE_MODULES = [
	"dgram",
	"cluster",
	"wasi",
	"diagnostics_channel",
	"inspector",
	"repl",
	"trace_events",
	"domain",
] as const;

const KNOWN_BUILTIN_MODULES = new Set([
	...BRIDGE_MODULES,
	...DEFERRED_CORE_MODULES,
	...UNSUPPORTED_CORE_MODULES,
	"assert",
	"buffer",
	"constants",
	"crypto",
	"events",
	"path",
	"querystring",
	"stream",
	"stream/web",
	"string_decoder",
	"timers",
	"tty",
	"url",
	"util",
	"vm",
	"zlib",
]);

const BUILTIN_NAMED_EXPORTS: Record<string, string[]> = {
	fs: [
		"promises",
		"readFileSync",
		"writeFileSync",
		"appendFileSync",
		"existsSync",
		"statSync",
		"mkdirSync",
		"readdirSync",
		"createReadStream",
		"createWriteStream",
	],
	"fs/promises": [
		"readFile",
		"writeFile",
		"appendFile",
		"mkdir",
		"readdir",
		"rm",
		"rmdir",
		"stat",
	],
	module: [
		"createRequire",
		"Module",
		"isBuiltin",
		"builtinModules",
		"SourceMap",
		"syncBuiltinESMExports",
	],
	os: [
		"arch",
		"platform",
		"tmpdir",
		"homedir",
		"hostname",
		"type",
		"release",
		"constants",
	],
	http: [
		"request",
		"get",
		"createServer",
		"Server",
		"IncomingMessage",
		"ServerResponse",
		"Agent",
		"METHODS",
		"STATUS_CODES",
	],
	https: ["request", "get", "createServer", "Agent", "globalAgent"],
	dns: ["lookup", "resolve", "resolve4", "resolve6", "promises"],
	child_process: [
		"spawn",
		"spawnSync",
		"exec",
		"execSync",
		"execFile",
		"execFileSync",
		"fork",
	],
	process: [
		"argv",
		"env",
		"cwd",
		"chdir",
		"exit",
		"pid",
		"platform",
		"version",
		"versions",
		"stdout",
		"stderr",
		"stdin",
		"nextTick",
	],
	path: [
		"sep",
		"delimiter",
		"basename",
		"dirname",
		"extname",
		"format",
		"isAbsolute",
		"join",
		"normalize",
		"parse",
		"relative",
		"resolve",
	],
};

function isValidIdentifier(value: string): boolean {
	return /^[$A-Z_][0-9A-Z_$]*$/i.test(value);
}

function createBuiltinESMWrapper(
	bindingExpression: string,
	namedExports: string[],
): string {
	const exportLines = Array.from(new Set(namedExports))
		.filter(isValidIdentifier)
		.map(
			(name) =>
				`export const ${name} = _builtin == null ? undefined : _builtin[${JSON.stringify(name)}];`,
		)
		.join("\n");

	return `
      const _builtin = ${bindingExpression};
      export default _builtin;
      ${exportLines}
    `;
}

export class NodeProcess {
	private isolate: ivm.Isolate;
	private memoryLimit: number;
	private filesystem?: VirtualFileSystem;
	private processConfig: ProcessConfig;
	private commandExecutor?: CommandExecutor;
	private networkAdapter?: NetworkAdapter;
	private osConfig: OSConfig;
	private permissions?: Permissions;
	private cpuTimeLimitMs?: number;
	private timingMitigation: TimingMitigation;
	private filesystemEnabled: boolean = false;
	private commandExecutorEnabled: boolean = false;
	private networkEnabled: boolean = false;
	private activeHttpServerIds: Set<number> = new Set();
	private disposed: boolean = false;
	// Cache for compiled ESM modules (per isolate)
	private esmModuleCache: Map<string, ivm.Module> = new Map();
	private moduleFormatCache: Map<string, "esm" | "cjs" | "json"> = new Map();
	private packageTypeCache: Map<string, "module" | "commonjs" | null> =
		new Map();

	constructor(options: NodeProcessOptions = {}) {
		this.memoryLimit = options.memoryLimit ?? 128;
		this.isolate = this.createIsolate();
		const driver =
			options.driver ??
			// Set up explicit permissions so direct adapters stay deny-by-default.
			createNodeDriver({
				filesystem: options.filesystem,
				networkAdapter: options.networkAdapter,
				commandExecutor: options.commandExecutor,
				permissions: options.permissions ?? {},
			});
		const permissions = options.permissions ?? driver.permissions;
		this.permissions = permissions;
		this.filesystemEnabled = Boolean(driver.filesystem);
		this.commandExecutorEnabled = Boolean(driver.commandExecutor);
		this.networkEnabled = Boolean(driver.network);
		this.filesystem = driver.filesystem
			? wrapFileSystem(driver.filesystem, permissions)
			: createFsStub();
		this.commandExecutor = driver.commandExecutor
			? wrapCommandExecutor(driver.commandExecutor, permissions)
			: createCommandExecutorStub();
		this.networkAdapter = driver.network
			? wrapNetworkAdapter(driver.network, permissions)
			: createNetworkStub();
		const processConfig = options.processConfig ?? {};
		processConfig.env = filterEnv(processConfig.env, permissions);
		this.processConfig = processConfig;
		this.osConfig = options.osConfig ?? {};
		this.cpuTimeLimitMs = options.cpuTimeLimitMs;
		this.timingMitigation =
			options.timingMitigation ?? DEFAULT_TIMING_MITIGATION;
	}

	/**
	 * Set the command executor for child_process support
	 */
	setCommandExecutor(executor: CommandExecutor): void {
		this.commandExecutorEnabled = true;
		this.commandExecutor = wrapCommandExecutor(executor, this.permissions);
	}

	/**
	 * Set the network adapter for fetch/http/https/dns support
	 */
	setNetworkAdapter(adapter: NetworkAdapter): void {
		this.networkEnabled = true;
		this.networkAdapter = wrapNetworkAdapter(adapter, this.permissions);
	}

	/**
	 * Host-side network access routed through the sandbox network adapter.
	 */
	get network(): Pick<NetworkAdapter, "fetch" | "dnsLookup" | "httpRequest"> {
		const adapter = this.networkAdapter ?? createNetworkStub();
		return {
			fetch: (url, options) => adapter.fetch(url, options),
			dnsLookup: (hostname) => adapter.dnsLookup(hostname),
			httpRequest: (url, options) => adapter.httpRequest(url, options),
		};
	}

	/**
	 * Set the filesystem for file access
	 */
	setFilesystem(filesystem: VirtualFileSystem): void {
		this.filesystemEnabled = true;
		this.filesystem = wrapFileSystem(filesystem, this.permissions);
	}

	private getExecutionTimeoutMs(override?: number): number | undefined {
		const timeoutMs = override ?? this.cpuTimeLimitMs;
		if (timeoutMs === undefined) {
			return undefined;
		}
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new RangeError("cpuTimeLimitMs must be a positive finite number");
		}
		return Math.floor(timeoutMs);
	}

	private getTimingMitigation(mode?: TimingMitigation): TimingMitigation {
		return mode ?? this.timingMitigation;
	}

	private getExecutionDeadlineMs(timeoutMs?: number): number | undefined {
		if (timeoutMs === undefined) {
			return undefined;
		}
		return Date.now() + timeoutMs;
	}

	private getExecutionRunOptions(
		executionDeadlineMs?: number,
	): Pick<ivm.ScriptRunOptions, "timeout"> {
		if (executionDeadlineMs === undefined) {
			return {};
		}
		const remainingMs = Math.floor(executionDeadlineMs - Date.now());
		if (remainingMs <= 0) {
			throw new ExecutionTimeoutError();
		}
		return { timeout: Math.max(1, remainingMs) };
	}

	private async runWithExecutionDeadline<T>(
		operation: Promise<T>,
		executionDeadlineMs?: number,
	): Promise<T> {
		if (executionDeadlineMs === undefined) {
			return operation;
		}
		const remainingMs = Math.floor(executionDeadlineMs - Date.now());
		if (remainingMs <= 0) {
			throw new ExecutionTimeoutError();
		}
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new ExecutionTimeoutError()),
				remainingMs,
			);
			operation.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(err) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	}

	private isExecutionTimeoutError(error: unknown): boolean {
		if (error instanceof ExecutionTimeoutError) {
			return true;
		}
		const message = error instanceof Error ? error.message : String(error);
		return /timed out|time limit exceeded/i.test(message);
	}

	private createProcessConfigForExecution(
		timingMitigation: TimingMitigation,
		frozenTimeMs: number,
	): ProcessConfig {
		return {
			...this.processConfig,
			timingMitigation,
			frozenTimeMs: timingMitigation === "freeze" ? frozenTimeMs : undefined,
		};
	}

	private async applyTimingMitigation(
		context: ivm.Context,
		timingMitigation: TimingMitigation,
		frozenTimeMs: number,
	): Promise<void> {
		if (timingMitigation !== "freeze") {
			await context.eval(`
        if (typeof globalThis.performance === "undefined" || globalThis.performance === null) {
          globalThis.performance = { now: () => Date.now() };
        }
      `);
			return;
		}

		await context.eval(`
      const __frozenTimeMs = ${JSON.stringify(frozenTimeMs)};
      const __frozenDateNow = () => __frozenTimeMs;
      try {
        Object.defineProperty(Date, "now", {
          value: __frozenDateNow,
          configurable: true,
          writable: true,
        });
      } catch {
        Date.now = __frozenDateNow;
      }

      const __frozenPerformanceNow = () => 0;
      if (typeof globalThis.performance !== "undefined" && globalThis.performance !== null) {
        try {
          Object.defineProperty(globalThis.performance, "now", {
            value: __frozenPerformanceNow,
            configurable: true,
            writable: true,
          });
        } catch {
          try {
            globalThis.performance.now = __frozenPerformanceNow;
          } catch {}
        }
      } else {
        globalThis.performance = { now: __frozenPerformanceNow };
      }

      try {
        delete globalThis.SharedArrayBuffer;
      } catch {
        globalThis.SharedArrayBuffer = undefined;
      }
    `);
	}

	/**
	 * Resolve a module specifier to an absolute path
	 */
	private normalizeBuiltinSpecifier(request: string): string | null {
		const moduleName = request.replace(/^node:/, "");
		if (KNOWN_BUILTIN_MODULES.has(moduleName) || hasPolyfill(moduleName)) {
			return request.startsWith("node:") ? `node:${moduleName}` : moduleName;
		}
		return null;
	}

	private getPathDir(path: string): string {
		const normalizedPath = path.replace(/\\/g, "/");
		const lastSlash = normalizedPath.lastIndexOf("/");
		if (lastSlash <= 0) return "/";
		return normalizedPath.slice(0, lastSlash);
	}

	private async getNearestPackageType(
		filePath: string,
	): Promise<"module" | "commonjs" | null> {
		if (!this.filesystemEnabled || !this.filesystem) {
			return null;
		}

		let currentDir = this.getPathDir(filePath);
		const visitedDirs: string[] = [];
		while (true) {
			if (this.packageTypeCache.has(currentDir)) {
				return this.packageTypeCache.get(currentDir) ?? null;
			}
			visitedDirs.push(currentDir);

			const packageJsonPath =
				currentDir === "/" ? "/package.json" : `${currentDir}/package.json`;

			if (await exists(this.filesystem, packageJsonPath)) {
				try {
					const pkgJson = JSON.parse(
						await this.filesystem.readTextFile(packageJsonPath),
					) as { type?: unknown };
					const packageType =
						pkgJson.type === "module" || pkgJson.type === "commonjs"
							? pkgJson.type
							: null;
					for (const dir of visitedDirs) {
						this.packageTypeCache.set(dir, packageType);
					}
					return packageType;
				} catch {
					for (const dir of visitedDirs) {
						this.packageTypeCache.set(dir, null);
					}
					return null;
				}
			}

			if (currentDir === "/") {
				for (const dir of visitedDirs) {
					this.packageTypeCache.set(dir, null);
				}
				return null;
			}
			currentDir = this.getPathDir(currentDir);
		}
	}

	private async getModuleFormat(
		filePath: string,
	): Promise<"esm" | "cjs" | "json"> {
		const cached = this.moduleFormatCache.get(filePath);
		if (cached) {
			return cached;
		}

		let format: "esm" | "cjs" | "json";
		if (filePath.endsWith(".mjs")) {
			format = "esm";
		} else if (filePath.endsWith(".cjs")) {
			format = "cjs";
		} else if (filePath.endsWith(".json")) {
			format = "json";
		} else if (filePath.endsWith(".js")) {
			const packageType = await this.getNearestPackageType(filePath);
			format = packageType === "module" ? "esm" : "cjs";
		} else {
			format = "cjs";
		}

		this.moduleFormatCache.set(filePath, format);
		return format;
	}

	private async shouldRunAsESM(
		code: string,
		filePath?: string,
	): Promise<boolean> {
		// Keep heuristic mode for string-only snippets without file metadata.
		if (!filePath) {
			return isESM(code);
		}
		return (await this.getModuleFormat(filePath)) === "esm";
	}

	private async resolveESMPath(
		specifier: string,
		referrerPath: string,
	): Promise<string | null> {
		// Handle built-ins and bridged modules first.
		const builtinSpecifier = this.normalizeBuiltinSpecifier(specifier);
		if (builtinSpecifier) {
			return builtinSpecifier;
		}

		// Handle absolute paths - return as-is
		if (specifier.startsWith("/")) {
			return specifier;
		}

		// Get directory of referrer
		const referrerDir = referrerPath.includes("/")
			? referrerPath.substring(0, referrerPath.lastIndexOf("/")) || "/"
			: "/";

		// Handle relative paths
		if (specifier.startsWith("./") || specifier.startsWith("../")) {
			// Resolve relative to referrer directory
			const parts = referrerDir.split("/").filter(Boolean);
			const specParts = specifier.split("/");

			for (const part of specParts) {
				if (part === "..") {
					parts.pop();
				} else if (part !== ".") {
					parts.push(part);
				}
			}

			return `/${parts.join("/")}`;
		}

		// Bare specifier - try to resolve from node_modules
		if (!this.filesystemEnabled || !this.filesystem) {
			return null;
		}

		return resolveModule(specifier, referrerDir, this.filesystem, "import");
	}

	/**
	 * Load and compile an ESM module, handling both ESM and CJS sources
	 */
	private async compileESMModule(
		filePath: string,
		_context: ivm.Context,
	): Promise<ivm.Module> {
		// Check cache first
		const cached = this.esmModuleCache.get(filePath);
		if (cached) {
			return cached;
		}

		let code: string;

		// Handle built-in modules (node: prefix or known polyfills)
		const builtinSpecifier = this.normalizeBuiltinSpecifier(filePath);
		const moduleName = (builtinSpecifier ?? filePath).replace(/^node:/, "");

		if (builtinSpecifier) {
			if (moduleName === "fs") {
				code = createBuiltinESMWrapper(
					"globalThis.bridge?.fs || globalThis.bridge?.default || {}",
					BUILTIN_NAMED_EXPORTS.fs,
				);
			} else if (moduleName === "fs/promises") {
				code = createBuiltinESMWrapper(
					"(globalThis.bridge?.fs || globalThis.bridge?.default || {}).promises || {}",
					BUILTIN_NAMED_EXPORTS["fs/promises"],
				);
			} else if (moduleName === "module") {
				code = createBuiltinESMWrapper(
					`globalThis.bridge?.module || {
            createRequire: globalThis._createRequire || function(f) {
              const dir = f.replace(/\\\\[^\\\\]*$/, '') || '/';
              return function(m) { return globalThis._requireFrom(m, dir); };
            },
            Module: { builtinModules: [] },
            isBuiltin: () => false,
            builtinModules: []
          }`,
					BUILTIN_NAMED_EXPORTS.module,
				);
			} else if (moduleName === "os") {
				code = createBuiltinESMWrapper(
					"globalThis.bridge?.os || {}",
					BUILTIN_NAMED_EXPORTS.os,
				);
			} else if (moduleName === "http") {
				code = createBuiltinESMWrapper(
					"globalThis._httpModule || globalThis.bridge?.network?.http || {}",
					BUILTIN_NAMED_EXPORTS.http,
				);
			} else if (moduleName === "https") {
				code = createBuiltinESMWrapper(
					"globalThis._httpsModule || globalThis.bridge?.network?.https || {}",
					BUILTIN_NAMED_EXPORTS.https,
				);
			} else if (moduleName === "http2") {
				code = createBuiltinESMWrapper("globalThis._http2Module || {}", []);
			} else if (moduleName === "dns") {
				code = createBuiltinESMWrapper(
					"globalThis._dnsModule || globalThis.bridge?.network?.dns || {}",
					BUILTIN_NAMED_EXPORTS.dns,
				);
			} else if (moduleName === "child_process") {
				code = createBuiltinESMWrapper(
					"globalThis._childProcessModule || globalThis.bridge?.childProcess || {}",
					BUILTIN_NAMED_EXPORTS.child_process,
				);
			} else if (moduleName === "process") {
				code = createBuiltinESMWrapper(
					"globalThis.process || {}",
					BUILTIN_NAMED_EXPORTS.process,
				);
			} else if (hasPolyfill(moduleName)) {
				// Get polyfill code and wrap for ESM.
				let polyfillCode = polyfillCodeCache.get(moduleName);
				if (!polyfillCode) {
					polyfillCode = await bundlePolyfill(moduleName);
					polyfillCodeCache.set(moduleName, polyfillCode);
				}
				code = createBuiltinESMWrapper(
					`${polyfillCode}`,
					BUILTIN_NAMED_EXPORTS[moduleName] ?? [],
				);
			} else if (moduleName === "v8") {
				code = createBuiltinESMWrapper("globalThis._moduleCache?.v8 || {}", []);
			} else {
				code = createBuiltinESMWrapper("{}", []);
			}
		} else {
			// Load from filesystem
			if (!this.filesystemEnabled || !this.filesystem) {
				throw new Error("VirtualFileSystem required for loading modules");
			}
			const source = await loadFile(filePath, this.filesystem);
			if (source === null) {
				throw new Error(`Cannot load module: ${filePath}`);
			}

			// Classify source module format using extension + package metadata.
			const moduleFormat = await this.getModuleFormat(filePath);
			if (moduleFormat === "json") {
				code = `export default ${source};`;
			} else if (moduleFormat === "cjs") {
				// Transform CommonJS modules into ESM default exports.
				code = wrapCJSForESM(source);
			} else {
				code = source;
			}
		}

		// Compile the module
		const module = await this.isolate.compileModule(code, {
			filename: filePath,
		});

		// Cache it
		this.esmModuleCache.set(filePath, module);

		return module;
	}

	/**
	 * Create the ESM resolver callback for module.instantiate()
	 */
	private createESMResolver(
		context: ivm.Context,
	): (specifier: string, referrer: ivm.Module) => Promise<ivm.Module> {
		return async (specifier: string, referrer: ivm.Module) => {
			// Get the referrer's filename from our cache (reverse lookup)
			let referrerPath = "/";
			for (const [path, mod] of this.esmModuleCache.entries()) {
				if (mod === referrer) {
					referrerPath = path;
					break;
				}
			}

			// Resolve the specifier
			const resolved = await this.resolveESMPath(specifier, referrerPath);
			if (!resolved) {
				throw new Error(
					`Cannot resolve module '${specifier}' from '${referrerPath}'`,
				);
			}

			// Compile and return the module
			const module = await this.compileESMModule(resolved, context);

			return module;
		};
	}

	/**
	 * Run ESM code
	 */
	private async runESM(
		code: string,
		context: ivm.Context,
		filePath: string = "/<entry>.mjs",
		executionDeadlineMs?: number,
	): Promise<unknown> {
		// Compile the entry module
		const entryModule = await this.isolate.compileModule(code, {
			filename: filePath,
		});
		this.esmModuleCache.set(filePath, entryModule);

		// Instantiate with resolver (this resolves all dependencies)
		await entryModule.instantiate(context, this.createESMResolver(context));

		// Evaluate before reading exports so namespace bindings are initialized.
		await this.runWithExecutionDeadline(
			entryModule.evaluate({
				promise: true,
				...this.getExecutionRunOptions(executionDeadlineMs),
			}),
			executionDeadlineMs,
		);

		// Set namespace on the isolate global so we can serialize a plain object.
		const jail = context.global;
		const namespaceGlobalKey = "__entryNamespace__";
		await jail.set(namespaceGlobalKey, entryModule.namespace.derefInto());

		try {
			// Get namespace exports for run() to mirror module.exports semantics.
			return context.eval(
				`Object.fromEntries(Object.entries(globalThis.${namespaceGlobalKey}))`,
				{
					copy: true,
					...this.getExecutionRunOptions(executionDeadlineMs),
				},
			);
		} finally {
			// Clean up temporary namespace binding after copying exports.
			await jail.delete(namespaceGlobalKey);
		}
	}

	// Cache for evaluated dynamic import module namespaces
	private dynamicImportCache = new Map<string, ivm.Reference<unknown>>();
	// Track in-flight dynamic import evaluations per resolved module path
	private dynamicImportPending = new Map<string, Promise<ivm.Reference<unknown>>>();

	/**
	 * Get a cached namespace or evaluate the module on first dynamic import.
	 */
	private async resolveDynamicImportNamespace(
		specifier: string,
		context: ivm.Context,
		referrerPath: string,
		executionDeadlineMs?: number,
	): Promise<ivm.Reference<unknown> | null> {
		// Get directly cached namespaces first.
		const cached = this.dynamicImportCache.get(specifier);
		if (cached) {
			return cached;
		}

		// Resolve before compile/evaluate.
		const resolved = await this.resolveESMPath(specifier, referrerPath);
		if (!resolved) {
			return null;
		}

		// Get resolved-path cache entry.
		const resolvedCached = this.dynamicImportCache.get(resolved);
		if (resolvedCached) {
			this.dynamicImportCache.set(specifier, resolvedCached);
			return resolvedCached;
		}

		// Wait for an existing evaluation in progress.
		const pending = this.dynamicImportPending.get(resolved);
		if (pending) {
			const namespace = await pending;
			this.dynamicImportCache.set(specifier, namespace);
			return namespace;
		}

		// Evaluate once, then cache by both resolved path and original specifier.
		const evaluateModule = (async (): Promise<ivm.Reference<unknown>> => {
			const module = await this.compileESMModule(resolved, context);
			try {
				await module.instantiate(context, this.createESMResolver(context));
			} catch {
				// Already instantiated.
			}
			await this.runWithExecutionDeadline(
				module.evaluate({
					promise: true,
					...this.getExecutionRunOptions(executionDeadlineMs),
				}),
				executionDeadlineMs,
			);
			return module.namespace;
		})();

		this.dynamicImportPending.set(resolved, evaluateModule);

		try {
			const namespace = await evaluateModule;
			this.dynamicImportCache.set(resolved, namespace);
			this.dynamicImportCache.set(specifier, namespace);
			return namespace;
		} finally {
			this.dynamicImportPending.delete(resolved);
		}
	}

	/**
	 * Pre-compile all static dynamic import specifiers found in the code
	 * This must be called BEFORE running the code to avoid deadlocks
	 */
	private async precompileDynamicImports(
		transformedCode: string,
		context: ivm.Context,
		referrerPath: string = "/",
	): Promise<void> {
		const specifiers = extractDynamicImportSpecifiers(transformedCode);

		for (const specifier of specifiers) {
			// Resolve the module path
			const resolved = await this.resolveESMPath(specifier, referrerPath);
			if (!resolved) {
				continue; // Skip unresolvable modules, error will be thrown at runtime
			}

			// Compile only to warm module cache without triggering side effects.
			try {
				await this.compileESMModule(resolved, context);
			} catch {
				// Skip unresolved/invalid modules so runtime import() rejects on demand.
			}
		}
	}

	/**
	 * Set up dynamic import() function for ESM
	 * Note: precompileDynamicImports must be called BEFORE running user code
	 * Falls back to require() for CommonJS modules when not pre-compiled
	 */
	private async setupDynamicImport(
		context: ivm.Context,
		jail: ivm.Reference<Record<string, unknown>>,
		referrerPath: string = "/",
		executionDeadlineMs?: number,
	): Promise<void> {
		// Set up async module resolution/evaluation for first dynamic import.
			const dynamicImportRef = new ivm.Reference(
				async (specifier: string, fromPath?: string) => {
					const effectiveReferrer =
						typeof fromPath === "string" && fromPath.length > 0
							? fromPath
							: referrerPath;
					const namespace = await this.resolveDynamicImportNamespace(
						specifier,
						context,
						effectiveReferrer,
						executionDeadlineMs,
					);
					if (!namespace) {
						return null;
					}
				return namespace.derefInto();
			},
		);

		await jail.set("_dynamicImport", dynamicImportRef);

		// Create the __dynamicImport function in the isolate
		// Resolve in ESM mode first and only use require() fallback for explicit CJS/JSON.
		await context.eval(`
	      globalThis.__dynamicImport = async function(specifier, fromPath) {
	        const request = String(specifier);
	        const referrer = typeof fromPath === 'string' && fromPath.length > 0
	          ? fromPath
	          : ${JSON.stringify(referrerPath)};
	        const allowRequireFallback =
	          request.endsWith('.cjs') ||
	          request.endsWith('.json');

	        const namespace = await _dynamicImport.apply(
	            undefined,
	            [request, referrer],
	            { result: { promise: true } }
	          );

	        if (namespace !== null) {
	          return namespace;
	        }

	        if (!allowRequireFallback) {
	          throw new Error("Cannot find module '" + request + "'");
	        }

	        const mod = require(request);
	        const namespaceFallback = { default: mod };
	        if (mod !== null && (typeof mod === 'object' || typeof mod === 'function')) {
	          for (const key of Object.keys(mod)) {
	            if (!(key in namespaceFallback)) {
	              namespaceFallback[key] = mod[key];
	            }
	          }
	        }
	        return namespaceFallback;
	      };
	    `);
	}

	/**
	 * Set up the require() system in a context
	 */
	private async setupRequire(
		context: ivm.Context,
		jail: ivm.Reference<Record<string, unknown>>,
		timingMitigation: TimingMitigation,
		frozenTimeMs: number,
	): Promise<void> {
		// Create a reference that can load polyfills on demand
		const loadPolyfillRef = new ivm.Reference(
			async (moduleName: string): Promise<string | null> => {
				const name = moduleName.replace(/^node:/, "");

				// fs is handled specially
				if (name === "fs") {
					return null;
				}

				// child_process is handled specially
				if (name === "child_process") {
					return null;
				}

				// Network modules are handled specially
				if (
					name === "http" ||
					name === "https" ||
					name === "http2" ||
					name === "dns"
				) {
					return null;
				}

				// os module is handled specially with our own polyfill
				if (name === "os") {
					return null;
				}

				// module is handled specially with our own polyfill
				if (name === "module") {
					return null;
				}

				if (!hasPolyfill(name)) {
					return null;
				}
				// Check cache first
				let code = polyfillCodeCache.get(name);
				if (!code) {
					code = await bundlePolyfill(name);
					polyfillCodeCache.set(name, code);
				}
				return code;
			},
		);

		// Create a reference for resolving module paths
		const resolveModuleRef = new ivm.Reference(
			async (request: string, fromDir: string): Promise<string | null> => {
				const builtinSpecifier = this.normalizeBuiltinSpecifier(request);
				if (builtinSpecifier) {
					return builtinSpecifier;
				}
				if (!this.filesystemEnabled || !this.filesystem) {
					return null;
				}
				return resolveModule(request, fromDir, this.filesystem);
			},
		);

		// Create a reference for loading file content
		// Also transforms dynamic import() calls to __dynamicImport()
		const loadFileRef = new ivm.Reference(
			async (path: string): Promise<string | null> => {
				if (!this.filesystemEnabled || !this.filesystem) {
					return null;
				}
				const source = await loadFile(path, this.filesystem);
				if (source === null) {
					return null;
				}
				// Transform dynamic import() to __dynamicImport() for V8 compatibility
				return transformDynamicImport(source);
			},
		);

		await jail.set("_loadPolyfill", loadPolyfillRef);
		await jail.set("_resolveModule", resolveModuleRef);
		await jail.set("_loadFile", loadFileRef);

		// Set up timer Reference for actual delays (not just microtasks)
		// This allows setTimeout/setInterval to use real host-side timers
		const scheduleTimerRef = new ivm.Reference((delayMs: number) => {
			return new Promise<void>((resolve) => {
				// Use real host setTimeout with actual delay
				globalThis.setTimeout(resolve, delayMs);
			});
		});
		await jail.set("_scheduleTimer", scheduleTimerRef);

		// Set up fs References (stubbed if filesystem is disabled)
		{
			const fs = this.filesystem ?? createFsStub();

			// Create individual References for each fs operation
			const readFileRef = new ivm.Reference(async (path: string) => {
				return fs.readTextFile(path);
			});
			const writeFileRef = new ivm.Reference(
				async (path: string, content: string) => {
					await fs.writeFile(path, content);
				},
			);
			// Binary file operations using base64 encoding
			const readFileBinaryRef = new ivm.Reference(async (path: string) => {
				const data = await fs.readFile(path);
				// Convert to base64 for transfer across isolate boundary
				return Buffer.from(data).toString("base64");
			});
			const writeFileBinaryRef = new ivm.Reference(
				async (path: string, base64Content: string) => {
					// Decode base64 and write as binary
					const data = Buffer.from(base64Content, "base64");
					await fs.writeFile(path, data);
				},
			);
			const readDirRef = new ivm.Reference(async (path: string) => {
				const entries = await readDirWithTypes(fs, path);
				// Return as JSON string for transfer
				return JSON.stringify(entries);
			});
			const mkdirRef = new ivm.Reference(async (path: string) => {
				await mkdir(fs, path);
			});
			const rmdirRef = new ivm.Reference(async (path: string) => {
				await fs.removeDir(path);
			});
			const existsRef = new ivm.Reference(async (path: string) => {
				return exists(fs, path);
			});
			const statRef = new ivm.Reference(async (path: string) => {
				const statInfo = await stat(fs, path);
				// Return as JSON string for transfer
				return JSON.stringify({
					mode: statInfo.mode,
					size: statInfo.size,
					isDirectory: statInfo.isDirectory,
					atimeMs: statInfo.atimeMs,
					mtimeMs: statInfo.mtimeMs,
					ctimeMs: statInfo.ctimeMs,
					birthtimeMs: statInfo.birthtimeMs,
				});
			});
			const unlinkRef = new ivm.Reference(async (path: string) => {
				await fs.removeFile(path);
			});
			const renameRef = new ivm.Reference(
				async (oldPath: string, newPath: string) => {
					await rename(fs, oldPath, newPath);
				},
			);

			// Set up each fs Reference individually in the isolate
			await jail.set("_fsReadFile", readFileRef);
			await jail.set("_fsWriteFile", writeFileRef);
			await jail.set("_fsReadFileBinary", readFileBinaryRef);
			await jail.set("_fsWriteFileBinary", writeFileBinaryRef);
			await jail.set("_fsReadDir", readDirRef);
			await jail.set("_fsMkdir", mkdirRef);
			await jail.set("_fsRmdir", rmdirRef);
			await jail.set("_fsExists", existsRef);
			await jail.set("_fsStat", statRef);
			await jail.set("_fsUnlink", unlinkRef);
			await jail.set("_fsRename", renameRef);

			// Create the _fs object inside the isolate
			await context.eval(`
        globalThis._fs = {
          readFile: _fsReadFile,
          writeFile: _fsWriteFile,
          readFileBinary: _fsReadFileBinary,
          writeFileBinary: _fsWriteFileBinary,
          readDir: _fsReadDir,
          mkdir: _fsMkdir,
          rmdir: _fsRmdir,
          exists: _fsExists,
          stat: _fsStat,
          unlink: _fsUnlink,
          rename: _fsRename,
        };
      `);
		}

		// Set up child_process References (stubbed when disabled)
		{
			const executor = this.commandExecutor ?? createCommandExecutorStub();
			let nextSessionId = 1;
			const sessions = new Map<number, SpawnedProcess>();

			// Lazy-initialized dispatcher reference from isolate
			// We can't get this upfront because _childProcessDispatch is set by bridge code
			// which loads AFTER these references are set up
			let dispatchRef: ivm.Reference<
				(
					sessionId: number,
					type: "stdout" | "stderr" | "exit",
					data: Uint8Array | number,
				) => void
			> | null = null;

			const getDispatchRef = () => {
				if (!dispatchRef) {
					dispatchRef = context.global.getSync("_childProcessDispatch", {
						reference: true,
					}) as ivm.Reference<
						(
							sessionId: number,
							type: "stdout" | "stderr" | "exit",
							data: Uint8Array | number,
						) => void
					>;
				}
				return dispatchRef!;
			};

			// Start a spawn - returns session ID
			const spawnStartRef = new ivm.Reference(
				(command: string, argsJson: string, optionsJson: string): number => {
					const args = JSON.parse(argsJson) as string[];
					const options = JSON.parse(optionsJson) as {
						cwd?: string;
						env?: Record<string, string>;
					};
					const sessionId = nextSessionId++;

					const proc = executor.spawn(command, args, {
						cwd: options.cwd,
						env: options.env,
						onStdout: (data) => {
							getDispatchRef().applySync(
								undefined,
								[sessionId, "stdout", data],
								{ arguments: { copy: true } },
							);
						},
						onStderr: (data) => {
							getDispatchRef().applySync(
								undefined,
								[sessionId, "stderr", data],
								{ arguments: { copy: true } },
							);
						},
					});

					proc.wait().then((code) => {
						getDispatchRef().applySync(undefined, [sessionId, "exit", code]);
						sessions.delete(sessionId);
					});

					sessions.set(sessionId, proc);
					return sessionId;
				},
			);

			// Stdin write
			const stdinWriteRef = new ivm.Reference(
				(sessionId: number, data: Uint8Array): void => {
					sessions.get(sessionId)?.writeStdin(data);
				},
			);

			// Stdin close
			const stdinCloseRef = new ivm.Reference((sessionId: number): void => {
				sessions.get(sessionId)?.closeStdin();
			});

			// Kill
			const killRef = new ivm.Reference(
				(sessionId: number, signal: number): void => {
					sessions.get(sessionId)?.kill(signal);
				},
			);

			// Synchronous spawn - blocks until process exits, returns all output
			// Used by execSync/spawnSync which need to wait for completion
			const spawnSyncRef = new ivm.Reference(
				async (
					command: string,
					argsJson: string,
					optionsJson: string,
				): Promise<string> => {
					const args = JSON.parse(argsJson) as string[];
					const options = JSON.parse(optionsJson) as {
						cwd?: string;
						env?: Record<string, string>;
					};

					// Collect stdout/stderr
					const stdoutChunks: Uint8Array[] = [];
					const stderrChunks: Uint8Array[] = [];

					const proc = executor.spawn(command, args, {
						cwd: options.cwd,
						env: options.env,
						onStdout: (data) => {
							stdoutChunks.push(data);
						},
						onStderr: (data) => {
							stderrChunks.push(data);
						},
					});

					// Wait for process to exit
					const exitCode = await proc.wait();

					// Combine chunks into strings
					const decoder = new TextDecoder();
					const stdout = stdoutChunks
						.map((c) => decoder.decode(c))
						.join("");
					const stderr = stderrChunks
						.map((c) => decoder.decode(c))
						.join("");

					return JSON.stringify({ stdout, stderr, code: exitCode });
				},
			);

			await jail.set("_childProcessSpawnStart", spawnStartRef);
			await jail.set("_childProcessStdinWrite", stdinWriteRef);
			await jail.set("_childProcessStdinClose", stdinCloseRef);
			await jail.set("_childProcessKill", killRef);
			await jail.set("_childProcessSpawnSync", spawnSyncRef);
		}

		// Set up network References (stubbed when disabled)
		{
			const adapter = this.networkAdapter ?? createNetworkStub();

			// Reference for fetch - returns JSON string for transfer
			const networkFetchRef = new ivm.Reference(
				async (url: string, optionsJson: string): Promise<string> => {
					const options = JSON.parse(optionsJson);
					const result = await adapter.fetch(url, options);
					return JSON.stringify(result);
				},
			);

			// Reference for DNS lookup - returns JSON string for transfer
			const networkDnsLookupRef = new ivm.Reference(
				async (hostname: string): Promise<string> => {
					const result = await adapter.dnsLookup(hostname);
					return JSON.stringify(result);
				},
			);

			// Reference for HTTP request - returns JSON string for transfer
			const networkHttpRequestRef = new ivm.Reference(
				async (url: string, optionsJson: string): Promise<string> => {
					const options = JSON.parse(optionsJson);
					const result = await adapter.httpRequest(url, options);
					return JSON.stringify(result);
				},
			);

			// Lazy dispatcher reference for in-sandbox HTTP server callbacks
			let httpServerDispatchRef: ivm.Reference<
				(
					serverId: number,
					requestJson: string,
				) => Promise<string>
			> | null = null;

			const getHttpServerDispatchRef = () => {
				if (!httpServerDispatchRef) {
					httpServerDispatchRef = context.global.getSync("_httpServerDispatch", {
						reference: true,
					}) as ivm.Reference<
						(
							serverId: number,
							requestJson: string,
						) => Promise<string>
					>;
				}
				return httpServerDispatchRef!;
			};

			// Reference for starting an in-sandbox HTTP server
			const networkHttpServerListenRef = new ivm.Reference(
				async (optionsJson: string): Promise<string> => {
					if (!adapter.httpServerListen) {
						throw new Error(
							"http.createServer requires NetworkAdapter.httpServerListen support",
						);
					}

					const options = JSON.parse(optionsJson) as {
						serverId: number;
						port?: number;
						hostname?: string;
					};

					const result = await adapter.httpServerListen({
						serverId: options.serverId,
						port: options.port,
						hostname: options.hostname,
						onRequest: async (request) => {
							const requestJson = JSON.stringify(request);

							const responseJson = await getHttpServerDispatchRef().apply(
								undefined,
								[options.serverId, requestJson],
								{ result: { promise: true } },
							);
							return JSON.parse(String(responseJson)) as {
								status: number;
								headers?: Array<[string, string]>;
								body?: string;
								bodyEncoding?: "utf8" | "base64";
							};
						},
					});
					this.activeHttpServerIds.add(options.serverId);

					return JSON.stringify(result);
				},
			);

			// Reference for closing an in-sandbox HTTP server
			const networkHttpServerCloseRef = new ivm.Reference(
				async (serverId: number): Promise<void> => {
					if (!adapter.httpServerClose) {
						throw new Error(
							"http.createServer close requires NetworkAdapter.httpServerClose support",
						);
					}
					await adapter.httpServerClose(serverId);
					this.activeHttpServerIds.delete(serverId);
				},
			);

			await jail.set("_networkFetchRaw", networkFetchRef);
			await jail.set("_networkDnsLookupRaw", networkDnsLookupRef);
			await jail.set("_networkHttpRequestRaw", networkHttpRequestRef);
			await jail.set("_networkHttpServerListenRaw", networkHttpServerListenRef);
			await jail.set("_networkHttpServerCloseRaw", networkHttpServerCloseRef);
		}

		// Set up globals needed by the bridge BEFORE loading it
		const initialCwd = this.processConfig.cwd ?? "/";
		await context.eval(`
      globalThis._moduleCache = {};
      // Set up built-ins that have no bridge/polyfill implementation.
      globalThis._moduleCache['v8'] = {
        getHeapStatistics: function() {
          return {
            total_heap_size: 67108864,
            total_heap_size_executable: 1048576,
            total_physical_size: 67108864,
            total_available_size: 67108864,
            used_heap_size: 52428800,
            heap_size_limit: 134217728,
            malloced_memory: 8192,
            peak_malloced_memory: 16384,
            does_zap_garbage: 0,
            number_of_native_contexts: 1,
            number_of_detached_contexts: 0,
            external_memory: 0
          };
        },
        getHeapSpaceStatistics: function() { return []; },
        getHeapCodeStatistics: function() { return {}; },
        setFlagsFromString: function() {},
        serialize: function(value) { return Buffer.from(JSON.stringify(value)); },
        deserialize: function(buffer) { return JSON.parse(buffer.toString()); },
        cachedDataVersionTag: function() { return 0; }
      };
      globalThis._pendingModules = {};
      globalThis._currentModule = { dirname: ${JSON.stringify(initialCwd)} };
    `);

		// Load the bridge bundle which sets up all polyfill modules
		const bridgeCode = getBridgeWithConfig(
			this.createProcessConfigForExecution(timingMitigation, frozenTimeMs),
			this.osConfig,
		);
		await context.eval(bridgeCode);
		await this.applyTimingMitigation(context, timingMitigation, frozenTimeMs);

		// Store the fs module code for use in require (avoid re-evaluating the bridge)
		await jail.set(
			"_fsModuleCode",
			"(function() { return globalThis.bridge?.fs || globalThis.bridge?.default || {}; })()",
		);

		// Set up the require system with dynamic CommonJS resolution
		await context.eval(getRequireSetupCode());
		// module and process are already initialized by the bridge
	}

	/**
	 * Set up ESM-compatible globals (process, Buffer, etc.)
	 */
	private async setupESMGlobals(
		context: ivm.Context,
		jail: ivm.Reference<Record<string, unknown>>,
		timingMitigation: TimingMitigation,
		frozenTimeMs: number,
	): Promise<void> {
		await this.setupRequire(context, jail, timingMitigation, frozenTimeMs);
	}

	/**
	 * Run code and return the value of module.exports (CJS) or the ESM namespace
	 * object (including default and named exports), along with exit code and
	 * captured stdout/stderr.
	 */
	async run<T = unknown>(
		code: string,
		filePath?: string,
	): Promise<RunResult<T>> {
		return this.executeInternal<T>({
			mode: "run",
			code,
			filePath,
		});
	}

	/**
	 * Set up console with output capture
	 */
	private async setupConsole(
		context: ivm.Context,
		jail: ivm.Reference<Record<string, unknown>>,
		stdout: string[],
		stderr: string[],
	): Promise<void> {
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
    `);
	}

	/**
	 * Execute code like a script with console output capture
	 * Supports both CJS and ESM syntax
	 */
	async exec(code: string, options?: ExecOptions): Promise<ExecResult> {
		const result = await this.executeInternal({
			mode: "exec",
			code,
			filePath: options?.filePath,
			env: options?.env,
			cwd: options?.cwd,
			stdin: options?.stdin,
			cpuTimeLimitMs: options?.cpuTimeLimitMs,
			timingMitigation: options?.timingMitigation,
		});

		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code,
		};
	}

	/**
	 * Shared execution pipeline for module-oriented and script-oriented execution.
	 */
	private async executeInternal<T = unknown>(options: {
		mode: "run" | "exec";
		code: string;
		filePath?: string;
		env?: Record<string, string>;
		cwd?: string;
		stdin?: string;
		cpuTimeLimitMs?: number;
		timingMitigation?: TimingMitigation;
	}): Promise<RunResult<T>> {
		// Clear caches for fresh run
		this.esmModuleCache.clear();
		this.dynamicImportCache.clear();
		this.dynamicImportPending.clear();
		this.moduleFormatCache.clear();
		this.packageTypeCache.clear();
		this.activeHttpServerIds.clear();

		const context = await this.isolate.createContext();
		const stdout: string[] = [];
		const stderr: string[] = [];
		const timingMitigation = this.getTimingMitigation(options.timingMitigation);
		const frozenTimeMs = Date.now();
		const cpuTimeLimitMs = this.getExecutionTimeoutMs(options.cpuTimeLimitMs);
		const executionDeadlineMs = this.getExecutionDeadlineMs(cpuTimeLimitMs);
		let recycleIsolateAfterTimeout = false;

		try {
			const jail = context.global;
			await jail.set("global", jail.derefInto());

			// Set up console capture
			await this.setupConsole(context, jail, stdout, stderr);

			let exports: T | undefined;
			const transformedCode = transformDynamicImport(options.code);
			const entryReferrerPath = options.filePath ?? "/";

			// Detect ESM vs CJS using module metadata first.
			if (await this.shouldRunAsESM(options.code, options.filePath)) {
				await this.setupESMGlobals(
					context,
					jail,
					timingMitigation,
					frozenTimeMs,
				);

				if (options.mode === "exec") {
					await this.applyExecutionOverrides(
						context,
						options.env,
						options.cwd,
						options.stdin,
					);
				}

				await this.precompileDynamicImports(
					transformedCode,
					context,
					entryReferrerPath,
				);
				await this.setupDynamicImport(
					context,
					jail,
					entryReferrerPath,
					executionDeadlineMs,
				);

				const esmResult = await this.runESM(
					transformedCode,
					context,
					options.filePath,
					executionDeadlineMs,
				);
				if (options.mode === "run") {
					exports = esmResult as T;
				}
			} else {
				await this.setupRequire(
					context,
					jail,
					timingMitigation,
					frozenTimeMs,
				);
				await context.eval("globalThis.module = { exports: {} };");

				if (options.mode === "exec") {
					await this.applyExecutionOverrides(
						context,
						options.env,
						options.cwd,
						options.stdin,
					);

					if (options.filePath) {
						await this.setCommonJsFileGlobals(context, options.filePath);
					}
				}

				await this.precompileDynamicImports(
					transformedCode,
					context,
					entryReferrerPath,
				);
				await this.setupDynamicImport(
					context,
					jail,
					entryReferrerPath,
					executionDeadlineMs,
				);

				if (options.mode === "exec") {
					// Capture eval() result and await it if script returns a Promise.
					const wrappedCode = `
            globalThis.__scriptResult__ = eval(${JSON.stringify(transformedCode)});
          `;
					const script = await this.isolate.compileScript(wrappedCode);
					await script.run(
						context,
						this.getExecutionRunOptions(executionDeadlineMs),
					);
					await this.awaitScriptResult(context, executionDeadlineMs);
				} else {
					const script = await this.isolate.compileScript(transformedCode);
					await script.run(
						context,
						this.getExecutionRunOptions(executionDeadlineMs),
					);
					exports = (await context.eval("module.exports", {
						copy: true,
						...this.getExecutionRunOptions(executionDeadlineMs),
					})) as T;
				}
			}

			// Wait for any active handles (child processes, etc.) to complete.
			await this.runWithExecutionDeadline(
				context.eval(
					'typeof _waitForActiveHandles === "function" ? _waitForActiveHandles() : Promise.resolve()',
					{
						promise: true,
						...this.getExecutionRunOptions(executionDeadlineMs),
					},
				),
				executionDeadlineMs,
			);

			// Get exit code from process.exitCode if set.
			const exitCode = (await context.eval("process.exitCode || 0", {
				copy: true,
				...this.getExecutionRunOptions(executionDeadlineMs),
			})) as number;

			return {
				stdout: stdout.join("\n") + (stdout.length > 0 ? "\n" : ""),
				stderr: stderr.join("\n") + (stderr.length > 0 ? "\n" : ""),
				code: exitCode,
				exports,
			};
		} catch (err) {
			if (this.isExecutionTimeoutError(err)) {
				recycleIsolateAfterTimeout = true;
				stderr.push(TIMEOUT_ERROR_MESSAGE);
				return {
					stdout: stdout.join("\n") + (stdout.length > 0 ? "\n" : ""),
					stderr: stderr.join("\n") + (stderr.length > 0 ? "\n" : ""),
					code: TIMEOUT_EXIT_CODE,
					exports: undefined as T,
				};
			}

			// Handle controlled process exits from process.exit(N).
			const errMessage = err instanceof Error ? err.message : String(err);
			const exitMatch = errMessage.match(/process\.exit\((\d+)\)/);

			if (exitMatch) {
				const exitCode = parseInt(exitMatch[1], 10);
				return {
					stdout: stdout.join("\n") + (stdout.length > 0 ? "\n" : ""),
					stderr: stderr.join("\n") + (stderr.length > 0 ? "\n" : ""),
					code: exitCode,
					exports: undefined as T,
				};
			}

			stderr.push(errMessage);
			return {
				stdout: stdout.join("\n") + (stdout.length > 0 ? "\n" : ""),
				stderr: stderr.join("\n") + (stderr.length > 0 ? "\n" : ""),
				code: 1,
				exports: undefined as T,
			};
		} finally {
			context.release();
			if (recycleIsolateAfterTimeout) {
				this.recycleIsolate();
			}
		}
	}

	/**
	 * Apply runtime overrides used by script-style execution.
	 */
	private async applyExecutionOverrides(
		context: ivm.Context,
		env?: Record<string, string>,
		cwd?: string,
		stdin?: string,
	): Promise<void> {
		if (env || cwd) {
			await this.overrideProcessConfig(context, env, cwd);
		}
		if (stdin !== undefined) {
			await this.setStdinData(context, stdin);
		}
	}

	/**
	 * Set CommonJS file globals for accurate relative require() behavior.
	 */
	private async setCommonJsFileGlobals(
		context: ivm.Context,
		filePath: string,
	): Promise<void> {
		const dirname = filePath.includes("/")
			? filePath.substring(0, filePath.lastIndexOf("/")) || "/"
			: "/";
		await context.eval(`
      globalThis.__filename = ${JSON.stringify(filePath)};
      globalThis.__dirname = ${JSON.stringify(dirname)};
      globalThis._currentModule.dirname = ${JSON.stringify(dirname)};
      globalThis._currentModule.filename = ${JSON.stringify(filePath)};
    `);
	}

	/**
	 * Await script result when eval() returns a Promise.
	 */
	private async awaitScriptResult(
		context: ivm.Context,
		executionDeadlineMs?: number,
	): Promise<void> {
		const hasPromise = await context.eval(
			`globalThis.__scriptResult__ && typeof globalThis.__scriptResult__.then === 'function'`,
			{
				copy: true,
				...this.getExecutionRunOptions(executionDeadlineMs),
			},
		);
		if (hasPromise) {
			await this.runWithExecutionDeadline(
				context.eval(`globalThis.__scriptResult__`, {
					promise: true,
					...this.getExecutionRunOptions(executionDeadlineMs),
				}),
				executionDeadlineMs,
			);
		}
	}

	/**
	 * Override process.env and process.cwd for a specific execution context
	 */
	private async overrideProcessConfig(
		context: ivm.Context,
		env?: Record<string, string>,
		cwd?: string,
	): Promise<void> {
		if (env) {
			const filtered = filterEnv(env, this.permissions);
			// Merge provided env with existing env
			await context.eval(`
				Object.assign(process.env, ${JSON.stringify(filtered)});
			`);
		}
		if (cwd) {
			// Override cwd
			await context.eval(`
				process.cwd = () => ${JSON.stringify(cwd)};
			`);
		}
	}

	/**
	 * Set stdin data for a specific execution context.
	 * This injects stdin data that will be emitted when process.stdin listeners are added.
	 */
	private async setStdinData(
		context: ivm.Context,
		stdin: string,
	): Promise<void> {
		// The bridge exposes these variables for stdin management
		// We need to set them before the script runs so readline can access them
		await context.eval(`
			// Reset stdin state for this execution
			if (typeof _stdinData !== 'undefined') {
				_stdinData = ${JSON.stringify(stdin)};
				_stdinPosition = 0;
				_stdinEnded = false;
				_stdinFlowMode = false;
			}
			`);
	}

	private createIsolate(): ivm.Isolate {
		return new ivm.Isolate({ memoryLimit: this.memoryLimit });
	}

	private recycleIsolate(): void {
		if (this.disposed) {
			return;
		}
		this.isolate.dispose();
		this.isolate = this.createIsolate();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.isolate.dispose();
	}

	/**
	 * Terminate sandbox execution from the host.
	 * Closes bridged HTTP servers before disposing the isolate.
	 */
	async terminate(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const adapter = this.networkAdapter;
		if (adapter?.httpServerClose) {
			const ids = Array.from(this.activeHttpServerIds);
			await Promise.allSettled(ids.map((id) => adapter.httpServerClose!(id)));
		}
		this.activeHttpServerIds.clear();
		this.disposed = true;
		this.isolate.dispose();
	}
}
