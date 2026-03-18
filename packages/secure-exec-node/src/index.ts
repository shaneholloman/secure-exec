// V8 execution loop
export { executeWithRuntime } from "./execution.js";

// V8 isolate utilities
export {
	DEFAULT_TIMING_MITIGATION,
	TIMEOUT_EXIT_CODE,
	TIMEOUT_ERROR_MESSAGE,
	ExecutionTimeoutError,
	createIsolate,
	getExecutionDeadlineMs,
	getExecutionRunOptions,
	runWithExecutionDeadline,
	isExecutionTimeoutError,
} from "./isolate.js";

// Bridge compilation
export { getRawBridgeCode, getBridgeAttachCode } from "./bridge-loader.js";

// Stdlib polyfill bundling
export {
	bundlePolyfill,
	getAvailableStdlib,
	hasPolyfill,
	prebundleAllPolyfills,
} from "./polyfills.js";
