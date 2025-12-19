import type { CommandExecutor, SpawnedProcess } from "sandboxed-node";

/**
 * Context interface for spawning child processes.
 * This is a subset of HostExecContext that only includes the spawnChildStreaming method.
 */
interface ChildSpawnContext {
	spawnChildStreaming?(
		command: string,
		args: string[],
		options: {
			cwd?: string;
			env?: Record<string, string>;
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
	): SpawnedProcess;
}

/**
 * Create a CommandExecutor that passes spawn requests through HostExecContext.
 * This keeps child processes sandboxed by routing them through wasmer-js.
 *
 * Returns null if the context doesn't support child process spawning.
 */
export function createCommandExecutor(
	ctx: ChildSpawnContext,
): CommandExecutor | null {
	// If spawnChildStreaming is not available, we can't create a CommandExecutor
	if (!ctx.spawnChildStreaming) {
		return null;
	}

	const spawnChild = ctx.spawnChildStreaming;

	return {
		spawn(command, args, options): SpawnedProcess {
			return spawnChild(command, args, {
				cwd: options.cwd,
				env: options.env,
				onStdout: options.onStdout,
				onStderr: options.onStderr,
			});
		},
	};
}
