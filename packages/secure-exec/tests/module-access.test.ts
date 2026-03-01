import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { NodeProcess, createNodeDriver } from "../src/index.js";

type PackageFiles = Record<string, string | Uint8Array>;

async function createTempProject(): Promise<string> {
	const projectDir = await mkdtemp(
		path.join(tmpdir(), "secure-exec-module-access-"),
	);
	await mkdir(path.join(projectDir, "node_modules"), { recursive: true });
	return projectDir;
}

async function writePackage(
	projectDir: string,
	packageName: string,
	options: {
		main?: string;
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
		files: PackageFiles;
	},
): Promise<string> {
	const packageDir = path.join(
		projectDir,
		"node_modules",
		...packageName.split("/"),
	);
	await mkdir(packageDir, { recursive: true });
	const packageJson = {
		name: packageName,
		main: options.main ?? "index.js",
		dependencies: options.dependencies,
		optionalDependencies: options.optionalDependencies,
		peerDependencies: options.peerDependencies,
	};
	await writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify(packageJson, null, 2),
	);
	for (const [relativePath, contents] of Object.entries(options.files)) {
		const absolutePath = path.join(packageDir, relativePath);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, contents);
	}
	return packageDir;
}

describe("moduleAccess", () => {
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

	it("loads allowlisted packages and transitive runtime dependencies", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "transitive-dep", {
			files: {
				"index.js": "module.exports = { value: 41 };",
			},
		});
		await writePackage(projectDir, "allowed-root", {
			dependencies: {
				"transitive-dep": "1.0.0",
			},
			files: {
				"index.js": "module.exports = { value: require('transitive-dep').value + 1 };",
			},
		});
		await writePackage(projectDir, "blocked-root", {
			files: {
				"index.js": "module.exports = { value: 'blocked' };",
			},
		});

		const driver = createNodeDriver({
			moduleAccess: {
				cwd: projectDir,
				allowPackages: ["allowed-root"],
			},
		});
		proc = new NodeProcess({ driver });

		const allowedResult = await proc.exec(
			`const mod = require("allowed-root"); console.log(mod.value);`,
			{ cwd: "/app", filePath: "/app/index.js" },
		);
		expect(allowedResult.code).toBe(0);
		expect(allowedResult.stdout).toBe("42\n");

		const blockedResult = await proc.exec(`require("blocked-root")`, {
			cwd: "/app",
			filePath: "/app/index.js",
		});
		expect(blockedResult.code).toBe(1);
		expect(blockedResult.stderr).toContain("Cannot find module");
	});

	it("loads dependency-of-dependency chains (A -> B -> C)", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "pkg-c", {
			files: {
				"index.js": "module.exports = { value: 39 };",
			},
		});
		await writePackage(projectDir, "pkg-b", {
			dependencies: {
				"pkg-c": "1.0.0",
			},
			files: {
				"index.js": "module.exports = { value: require('pkg-c').value + 2 };",
			},
		});
		await writePackage(projectDir, "pkg-a", {
			dependencies: {
				"pkg-b": "1.0.0",
			},
			files: {
				"index.js": "module.exports = { value: require('pkg-b').value + 1 };",
			},
		});

		const driver = createNodeDriver({
			moduleAccess: {
				cwd: projectDir,
				allowPackages: ["pkg-a"],
			},
		});
		proc = new NodeProcess({ driver });

		const result = await proc.exec(
			`const mod = require("pkg-a"); console.log(mod.value);`,
			{ cwd: "/app", filePath: "/app/index.js" },
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("42\n");
	});

	it("keeps projected node_modules read-only", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "read-only-pkg", {
			files: {
				"index.js": "module.exports = { ok: true };",
			},
		});

		const driver = createNodeDriver({
			moduleAccess: {
				cwd: projectDir,
				allowPackages: ["read-only-pkg"],
			},
		});
		proc = new NodeProcess({ driver });

		const result = await proc.exec(
			`
      const fs = require("fs");
      try {
        fs.writeFileSync("/app/node_modules/read-only-pkg/index.js", "module.exports = 0;");
        console.log("unexpected");
      } catch (error) {
        console.log(error && error.message);
      }
    `,
			{ cwd: "/app", filePath: "/app/index.js" },
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("EACCES: permission denied");
	});

	it("rejects invalid moduleAccess configuration deterministically", async () => {
		expect(() =>
			createNodeDriver({
				moduleAccess: {
					cwd: "relative/path",
					allowPackages: ["allowed-root"],
				},
			}),
		).toThrow(/ERR_MODULE_ACCESS_INVALID_CONFIG/);

		expect(() =>
			createNodeDriver({
				moduleAccess: {
					allowPackages: [],
				},
			}),
		).toThrow(/ERR_MODULE_ACCESS_INVALID_CONFIG/);

		expect(() =>
			createNodeDriver({
				moduleAccess: {
					allowPackages: ["./not-a-package"],
				},
			}),
		).toThrow(/ERR_MODULE_ACCESS_INVALID_PACKAGE/);
	});

	it("fails closed when resolved package path escapes cwd/node_modules", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);
		const outsideDir = await mkdtemp(path.join(tmpdir(), "secure-exec-module-outside-"));
		tempDirs.push(outsideDir);

		const outsidePackageRoot = path.join(outsideDir, "escape-pkg");
		await mkdir(outsidePackageRoot, { recursive: true });
		await writeFile(
			path.join(outsidePackageRoot, "package.json"),
			JSON.stringify({ name: "escape-pkg", main: "index.js" }),
		);
		await writeFile(
			path.join(outsidePackageRoot, "index.js"),
			"module.exports = 'escape';",
		);

		const escapeLink = path.join(projectDir, "node_modules", "escape-pkg");
		await symlink(outsidePackageRoot, escapeLink, "dir");

		expect(() =>
			createNodeDriver({
				moduleAccess: {
					cwd: projectDir,
					allowPackages: ["escape-pkg"],
				},
			}),
		).toThrow(/ERR_MODULE_ACCESS_OUT_OF_SCOPE/);
	});

	it("rejects native addon artifacts in discovered package closure", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "native-addon-pkg", {
			files: {
				"index.js": "module.exports = { ok: true };",
				"binding.node": new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
			},
		});

		expect(() =>
			createNodeDriver({
				moduleAccess: {
					cwd: projectDir,
					allowPackages: ["native-addon-pkg"],
				},
			}),
		).toThrow(/ERR_MODULE_ACCESS_NATIVE_ADDON/);
	});
});
