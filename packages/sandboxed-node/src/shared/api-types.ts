export type TimingMitigation = "off" | "freeze";

export interface ProcessConfig {
	platform?: string;
	arch?: string;
	version?: string;
	cwd?: string;
	env?: Record<string, string>;
	argv?: string[];
	execPath?: string;
	pid?: number;
	ppid?: number;
	uid?: number;
	gid?: number;
	/** Stdin data to provide to the script */
	stdin?: string;
	/** Internal execution timing policy for bridge/process polyfills */
	timingMitigation?: TimingMitigation;
	/** Internal frozen clock source used when timing mitigation is enabled */
	frozenTimeMs?: number;
}

export interface OSConfig {
	platform?: string;
	arch?: string;
	type?: string;
	release?: string;
	version?: string;
	homedir?: string;
	tmpdir?: string;
	hostname?: string;
}

export interface RunResult<T = unknown> {
	stdout: string;
	stderr: string;
	code: number;
	exports?: T;
}

export interface ExecOptions {
	filePath?: string;
	env?: Record<string, string>;
	cwd?: string;
	/** Stdin data to pass to the script */
	stdin?: string;
	/** Maximum CPU time budget in milliseconds */
	cpuTimeLimitMs?: number;
	/** Timing side-channel mitigation mode */
	timingMitigation?: TimingMitigation;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}
