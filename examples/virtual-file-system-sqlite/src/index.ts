import {
	NodeRuntime,
	allowAllFs,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "secure-exec";
import { SQLiteFileSystem } from "./sqlite-filesystem.js";

const filesystem = await SQLiteFileSystem.create();

const runtime = new NodeRuntime({
	systemDriver: createNodeDriver({
		filesystem,
		permissions: { ...allowAllFs },
	}),
	runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

try {
	// Sandbox writes files — stored as rows in SQLite
	const writeResult = await runtime.exec(
		`
		const fs = require("node:fs");
		fs.mkdirSync("/workspace/src", { recursive: true });
		fs.writeFileSync("/workspace/src/index.js", "console.log('hello')");
		fs.writeFileSync("/workspace/package.json", JSON.stringify({ name: "test", version: "1.0.0" }));
		console.log("files written");
	`,
	);

	if (writeResult.code !== 0) {
		throw new Error(`Write step failed: ${writeResult.errorMessage}`);
	}

	// Sandbox reads files and lists directories
	let readOutput = "";
	const readResult = await runtime.exec(
		`
		const fs = require("node:fs");
		const entries = fs.readdirSync("/workspace");
		const code = fs.readFileSync("/workspace/src/index.js", "utf8");
		const pkg = JSON.parse(fs.readFileSync("/workspace/package.json", "utf8"));
		console.log(JSON.stringify({ entries, code, pkgName: pkg.name }));
	`,
		{
			onStdio: (event) => {
				if (event.channel === "stdout") readOutput += event.message;
			},
		},
	);

	if (readResult.code !== 0) {
		throw new Error(`Read step failed: ${readResult.errorMessage}`);
	}

	// Verify from host side via the VFS
	const hostContent = await filesystem.readTextFile(
		"/workspace/src/index.js",
	);
	const parsed = JSON.parse(readOutput.trim());

	const ok =
		hostContent === "console.log('hello')" &&
		parsed.code === "console.log('hello')" &&
		parsed.pkgName === "test" &&
		parsed.entries.includes("src") &&
		parsed.entries.includes("package.json");

	console.log(
		JSON.stringify({
			ok,
			hostContent,
			sandboxResult: parsed,
			summary:
				"SQLite-backed VFS: sandbox wrote files to SQLite, read them back, host verified via SQL",
		}),
	);
} finally {
	runtime.dispose();
	filesystem.close();
}
