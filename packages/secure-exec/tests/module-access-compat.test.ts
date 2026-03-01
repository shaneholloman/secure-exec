import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeProcess, createNodeDriver } from "../src/index.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 55_000;
const COMMAND_TIMEOUT_MS = 45_000;

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = path.join(TESTS_ROOT, "projects", "module-access-pass");

describe("moduleAccess compatibility fixture", () => {
	const tempDirs: string[] = [];
	let proc: NodeProcess | undefined;

	afterEach(async () => {
		proc?.dispose();
		proc = undefined;
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (!dir) continue;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it(
		"matches host Node output for allowlisted + transitive package loading",
		async () => {
			const projectDir = await mkdtemp(
				path.join(tmpdir(), "secure-exec-module-access-fixture-"),
			);
			tempDirs.push(projectDir);

			await cp(FIXTURE_SOURCE, projectDir, {
				recursive: true,
				filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
			});

			await execFileAsync(
				"pnpm",
				["install", "--ignore-workspace", "--prefer-offline"],
				{
					cwd: projectDir,
					timeout: COMMAND_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024,
				},
			);

			const hostEntry = path.join(projectDir, "src", "index.js");
			const hostResult = await execFileAsync(process.execPath, [hostEntry], {
				cwd: projectDir,
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: 10 * 1024 * 1024,
			});

			const sandboxCode = await readFile(hostEntry, "utf8");
			const sandboxDriver = createNodeDriver({
				moduleAccess: {
					cwd: projectDir,
					allowPackages: ["entry-lib"],
				},
			});
			proc = new NodeProcess({
				driver: sandboxDriver,
				processConfig: {
					cwd: "/app",
					env: {},
				},
			});

			const sandboxResult = await proc.exec(sandboxCode, {
				filePath: "/app/src/index.js",
				cwd: "/app",
				env: {},
			});

			expect(sandboxResult.code).toBe(0);
			expect(sandboxResult.stdout).toBe(hostResult.stdout);
			expect(sandboxResult.stderr).toBe(hostResult.stderr);
		},
		TEST_TIMEOUT_MS,
	);
});
