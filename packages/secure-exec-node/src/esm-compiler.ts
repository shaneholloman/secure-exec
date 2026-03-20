import ivm from "isolated-vm";
import {
	createBuiltinESMWrapper,
	getStaticBuiltinWrapperSource,
	BUILTIN_NAMED_EXPORTS,
	normalizeBuiltinSpecifier,
	loadFile,
	getIsolateRuntimeSource,
} from "@secure-exec/core";
import { bundlePolyfill, hasPolyfill } from "./polyfills.js";
import {
	extractCjsNamedExports,
	extractDynamicImportSpecifiers,
	wrapCJSForESMWithModulePath,
} from "@secure-exec/core/internal/shared/esm-utils";
import {
	HOST_BRIDGE_GLOBAL_KEYS,
} from "@secure-exec/core/internal/shared/bridge-contract";
import {
	getExecutionRunOptions,
	runWithExecutionDeadline,
} from "./isolate.js";
import {
	getHostBuiltinNamedExports,
	polyfillCodeCache,
	polyfillNamedExportsCache,
} from "./isolate-bootstrap.js";
import type { DriverDeps } from "./isolate-bootstrap.js";
import { getModuleFormat, resolveESMPath } from "./module-resolver.js";

type CompilerDeps = Pick<
	DriverDeps,
	| "isolate"
	| "filesystem"
	| "esmModuleCache"
	| "esmModuleReverseCache"
	| "moduleFormatCache"
	| "packageTypeCache"
	| "isolateJsonPayloadLimitBytes"
	| "dynamicImportCache"
	| "dynamicImportPending"
	| "resolutionCache"
>;

/**
 * Load and compile an ESM module, handling both ESM and CJS sources.
 */
export async function compileESMModule(
	deps: CompilerDeps,
	filePath: string,
	_context: ivm.Context,
): Promise<ivm.Module> {
	// Check cache first
	const cached = deps.esmModuleCache.get(filePath);
	if (cached) {
		return cached;
	}

	let code: string;

	// Handle built-in modules (node: prefix or known polyfills)
	const builtinSpecifier = normalizeBuiltinSpecifier(filePath);
	const moduleName = (builtinSpecifier ?? filePath).replace(/^node:/, "");

	if (builtinSpecifier) {
		const hostBuiltinNamedExports = getHostBuiltinNamedExports(moduleName);
		const declaredBuiltinNamedExports = BUILTIN_NAMED_EXPORTS[moduleName] ?? [];
		const mergedBuiltinNamedExports = Array.from(
			new Set([...hostBuiltinNamedExports, ...declaredBuiltinNamedExports]),
		);
		const runtimeBuiltinBinding = `globalThis._requireFrom(${JSON.stringify(moduleName)}, "/")`;
		const staticWrapperCode = getStaticBuiltinWrapperSource(moduleName);
		if (staticWrapperCode !== null) {
			code = staticWrapperCode;
		} else if (hostBuiltinNamedExports.length > 0) {
			// Prefer the runtime builtin bridge when host exports are known.
			code = createBuiltinESMWrapper(
				runtimeBuiltinBinding,
				mergedBuiltinNamedExports,
			);
		} else if (hasPolyfill(moduleName)) {
			// Get polyfill code and wrap for ESM.
			let polyfillCode = polyfillCodeCache.get(moduleName);
			if (!polyfillCode) {
				polyfillCode = await bundlePolyfill(moduleName);
				polyfillCodeCache.set(moduleName, polyfillCode);
			}

			let inferredNamedExports = polyfillNamedExportsCache.get(moduleName);
			if (!inferredNamedExports) {
				inferredNamedExports = extractCjsNamedExports(polyfillCode);
				polyfillNamedExportsCache.set(moduleName, inferredNamedExports);
			}

			code = createBuiltinESMWrapper(
				String(polyfillCode),
				Array.from(
					new Set([
						...inferredNamedExports,
						...mergedBuiltinNamedExports,
					]),
				),
			);
		} else {
			// Fall back to the runtime require bridge for built-ins without
			// dedicated polyfills so ESM named imports can still bind.
			code = createBuiltinESMWrapper(
				runtimeBuiltinBinding,
				mergedBuiltinNamedExports,
			);
		}
	} else {
		// Load from filesystem
		const source = await loadFile(filePath, deps.filesystem);
		if (source === null) {
			throw new Error(`Cannot load module: ${filePath}`);
		}

		// Classify source module format using extension + package metadata.
		const moduleFormat = await getModuleFormat(deps, filePath, source);
		if (moduleFormat === "json") {
			code = "export default " + source + ";";
		} else if (moduleFormat === "cjs") {
			// Transform CommonJS modules into ESM default exports.
			code = wrapCJSForESMWithModulePath(source, filePath);
		} else {
			code = source;
		}
	}

	// Compile the module
	const module = await deps.isolate.compileModule(code, {
		filename: filePath,
	});

	// Cache it (forward and reverse)
	deps.esmModuleCache.set(filePath, module);
	deps.esmModuleReverseCache.set(module, filePath);

	return module;
}

/**
 * Create the ESM resolver callback for module.instantiate().
 */
export function createESMResolver(
	deps: CompilerDeps,
	context: ivm.Context,
): (specifier: string, referrer: ivm.Module) => Promise<ivm.Module> {
	return async (specifier: string, referrer: ivm.Module) => {
		// O(1) reverse lookup via dedicated reverse cache
		const referrerPath = deps.esmModuleReverseCache.get(referrer) ?? "/";

		// Resolve the specifier
		const resolved = await resolveESMPath(deps, specifier, referrerPath);
		if (!resolved) {
			throw new Error(
				`Cannot resolve module '${specifier}' from '${referrerPath}'`,
			);
		}

		// Compile and return the module
		return compileESMModule(deps, resolved, context);
	};
}

/**
 * Run ESM code.
 */
export async function runESM(
	deps: CompilerDeps,
	code: string,
	context: ivm.Context,
	filePath: string = "/<entry>.mjs",
	executionDeadlineMs?: number,
): Promise<unknown> {
	// Compile the entry module
	const entryModule = await deps.isolate.compileModule(code, {
		filename: filePath,
	});
	deps.esmModuleCache.set(filePath, entryModule);
	deps.esmModuleReverseCache.set(entryModule, filePath);

	// Instantiate with resolver (this resolves all dependencies)
	await entryModule.instantiate(context, createESMResolver(deps, context));

	// Evaluate before reading exports so namespace bindings are initialized.
	await runWithExecutionDeadline(
		entryModule.evaluate({
			promise: true,
			...getExecutionRunOptions(executionDeadlineMs),
		}),
		executionDeadlineMs,
	);

	// Set namespace on the isolate global so we can serialize a plain object.
	const jail = context.global;
	const namespaceGlobalKey = "__entryNamespace__";
	await jail.set(namespaceGlobalKey, entryModule.namespace.derefInto());

	try {
		// Get namespace exports for run() to mirror module.exports semantics.
		return context.eval("Object.fromEntries(Object.entries(globalThis.__entryNamespace__))", {
			copy: true,
			...getExecutionRunOptions(executionDeadlineMs),
		});
	} finally {
		// Clean up temporary namespace binding after copying exports.
		await jail.delete(namespaceGlobalKey);
	}
}

export function isAlreadyInstantiatedModuleError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = error.message.toLowerCase();
	return (
		message.includes("already instantiated") ||
		message.includes("already linked")
	);
}

/**
 * Get a cached namespace or evaluate the module on first dynamic import.
 */
export async function resolveDynamicImportNamespace(
	deps: CompilerDeps,
	specifier: string,
	context: ivm.Context,
	referrerPath: string,
	executionDeadlineMs?: number,
): Promise<ivm.Reference<unknown> | null> {
	// Get directly cached namespaces first.
	const cached = deps.dynamicImportCache.get(specifier);
	if (cached) {
		return cached;
	}

	// Resolve before compile/evaluate.
	const resolved = await resolveESMPath(deps, specifier, referrerPath);
	if (!resolved) {
		return null;
	}

	// Get resolved-path cache entry.
	const resolvedCached = deps.dynamicImportCache.get(resolved);
	if (resolvedCached) {
		deps.dynamicImportCache.set(specifier, resolvedCached);
		return resolvedCached;
	}

	// Wait for an existing evaluation in progress.
	const pending = deps.dynamicImportPending.get(resolved);
	if (pending) {
		const namespace = await pending;
		deps.dynamicImportCache.set(specifier, namespace);
		return namespace;
	}

	// Evaluate once, then cache by both resolved path and original specifier.
		const evaluateModule = (async (): Promise<ivm.Reference<unknown>> => {
			const module = await compileESMModule(deps, resolved, context);
			try {
				await module.instantiate(context, createESMResolver(deps, context));
			} catch (error) {
				if (!isAlreadyInstantiatedModuleError(error)) {
					throw error;
				}
			}
			await runWithExecutionDeadline(
				module.evaluate({
					promise: true,
					...getExecutionRunOptions(executionDeadlineMs),
			}),
			executionDeadlineMs,
		);
		return module.namespace;
	})();

	deps.dynamicImportPending.set(resolved, evaluateModule);

	try {
		const namespace = await evaluateModule;
		deps.dynamicImportCache.set(resolved, namespace);
		deps.dynamicImportCache.set(specifier, namespace);
		return namespace;
	} finally {
		deps.dynamicImportPending.delete(resolved);
	}
}

/**
 * Pre-compile all static dynamic import specifiers found in the code.
 * This must be called BEFORE running the code to avoid deadlocks.
 */
export async function precompileDynamicImports(
	deps: CompilerDeps,
	transformedCode: string,
	context: ivm.Context,
	referrerPath: string = "/",
): Promise<void> {
	const specifiers = extractDynamicImportSpecifiers(transformedCode);

	for (const specifier of specifiers) {
		// Resolve the module path
		const resolved = await resolveESMPath(deps, specifier, referrerPath);
		if (!resolved) {
			continue; // Skip unresolvable modules, error will be thrown at runtime
		}

		// Compile only to warm module cache without triggering side effects.
		try {
			await compileESMModule(deps, resolved, context);
		} catch {
			// Skip unresolved/invalid modules so runtime import() rejects on demand.
		}
	}
}

/**
 * Set up dynamic import() function for ESM.
 * Note: precompileDynamicImports must be called BEFORE running user code.
 * Falls back to require() for CommonJS modules when not pre-compiled.
 */
export async function setupDynamicImport(
	deps: CompilerDeps,
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
			const namespace = await resolveDynamicImportNamespace(
				deps,
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

	await jail.set(HOST_BRIDGE_GLOBAL_KEYS.dynamicImport, dynamicImportRef);
	await jail.set(
		"__runtimeDynamicImportConfig",
		{ referrerPath },
		{ copy: true },
	);
	// Resolve in ESM mode first and only use require() fallback for explicit CJS/JSON.
	await context.eval(getIsolateRuntimeSource("setupDynamicImport"));
}
