// Re-exported from @secure-exec/node — canonical source is packages/secure-exec-node/src/isolate.ts
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
} from "@secure-exec/node/internal/isolate";
