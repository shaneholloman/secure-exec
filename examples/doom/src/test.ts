/**
 * Non-interactive smoke test: boots Doom in the sandbox, captures output,
 * verifies we get ANSI-colored frame data with half-block characters.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createKernel, createInMemoryFileSystem, allowAll } from "@secure-exec/core";
import { createWasmVmRuntime } from "@secure-exec/wasmvm";

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(exampleDir, "build");

console.log("Loading WAD...");
const wadData = await readFile(path.join(buildDir, "doom1.wad"));

const filesystem = createInMemoryFileSystem();
await filesystem.mkdir("/game", { recursive: true });
await filesystem.writeFile("/game/doom1.wad", wadData);

const kernel = createKernel({
	filesystem,
	permissions: allowAll,
	env: { HOME: "/game", PATH: "/bin", COLUMNS: "80" },
	cwd: "/game",
});

const wasmRuntime = createWasmVmRuntime({ commandDirs: [buildDir] });
await kernel.mount(wasmRuntime);
console.log("doom command discovered:", kernel.commands.has("doom"));

let stdoutBytes = 0;
let hasAnsiColor = false;
let hasHalfBlock = false;
let hasCursorHome = false;
let firstChunk = "";

const proc = kernel.spawn("doom", ["-iwad", "/game/doom1.wad"], {
	cwd: "/game",
	env: { HOME: "/game", COLUMNS: "80" },
	onStdout: (data) => {
		const chunk = Buffer.from(data).toString("utf-8");
		stdoutBytes += data.length;
		if (!hasAnsiColor && chunk.includes("\x1b[38;2;")) hasAnsiColor = true;
		if (!hasHalfBlock && chunk.includes("\u2580")) hasHalfBlock = true;
		if (!hasCursorHome && chunk.includes("\x1b[H")) hasCursorHome = true;
		if (firstChunk.length < 2000) firstChunk += chunk.slice(0, 2000 - firstChunk.length);
	},
	onStderr: (data) => {
		process.stderr.write(Buffer.from(data));
	},
});

console.log("Waiting 5 seconds for frames...");
await new Promise((r) => setTimeout(r, 5000));
proc.kill(9);
await proc.wait();

console.log("");
console.log("Results:");
console.log("  stdout bytes:", stdoutBytes);
console.log("  ANSI color escapes:", hasAnsiColor);
console.log("  half-block chars:", hasHalfBlock);
console.log("  cursor home:", hasCursorHome);
console.log("");

const allChecks = hasAnsiColor && hasHalfBlock && hasCursorHome && stdoutBytes > 10000;
if (allChecks) {
	console.log("SUCCESS: Doom is rendering ANSI frames in the sandbox!");
} else {
	console.log("FAILURE: Expected ANSI frame output not found.");
	console.log("First 500 chars:", JSON.stringify(firstChunk.slice(0, 500)));
	process.exitCode = 1;
}

await kernel.dispose();
