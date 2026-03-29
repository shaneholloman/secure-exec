/**
 * examples/doom — Run Doom inside a secure-exec sandbox.
 *
 * Compiles doomgeneric (C) to WASM, loads it into a virtual kernel,
 * and connects the user's terminal for interactive play.
 *
 * Build first: make build
 * Then run:    pnpm tsx src/index.ts
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createKernel, createInMemoryFileSystem, allowAll } from "@secure-exec/core";
import { createWasmVmRuntime } from "@secure-exec/wasmvm";

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(exampleDir, "build");
const doomBinary = path.join(buildDir, "doom");
const wadFile = path.join(buildDir, "doom1.wad");

// Check build artifacts exist
import { existsSync } from "node:fs";
if (!existsSync(doomBinary)) {
	console.error("Doom WASM binary not found. Run `make build` first.");
	process.exit(1);
}
if (!existsSync(wadFile)) {
	console.error("doom1.wad not found. Run `make build` first.");
	process.exit(1);
}

// Load WAD into virtual filesystem
const filesystem = createInMemoryFileSystem();
const wadData = await readFile(wadFile);
await filesystem.mkdir("/game", { recursive: true });
await filesystem.writeFile("/game/doom1.wad", wadData);

// Create kernel
const kernel = createKernel({
	filesystem,
	permissions: allowAll,
	env: { HOME: "/game", PATH: "/bin" },
	cwd: "/game",
});

// Mount WasmVM with our doom binary
const wasmRuntime = createWasmVmRuntime({ commandDirs: [buildDir] });
await kernel.mount(wasmRuntime);

if (!kernel.commands.has("doom")) {
	console.error("Doom command not found in kernel. Check build output.");
	await kernel.dispose();
	process.exit(1);
}

console.error("Starting Doom in secure-exec sandbox...");
console.error("Controls: arrows=move, f=fire, space=use, enter=select, esc=menu, q/Ctrl+C=quit");
console.error("");

// Pass terminal dimensions to doom via COLUMNS env var (cap at 80 like native)
const cols = Math.min(process.stdout.columns || 80, 80);

// Spawn doom directly (no PTY — doom writes raw ANSI escapes to stdout)
const proc = kernel.spawn("doom", ["-iwad", "/game/doom1.wad"], {
	cwd: "/game",
	env: { HOME: "/game", COLUMNS: String(cols) },
	onStdout: (data) => {
		process.stdout.write(Buffer.from(data));
	},
	onStderr: (data) => {
		process.stderr.write(Buffer.from(data));
	},
});

// Set terminal to raw mode for keypresses
const stdin = process.stdin;
if (stdin.isTTY) stdin.setRawMode(true);
stdin.resume();

// Clean exit: restore terminal and quit
let exiting = false;
const quit = async (code: number) => {
	if (exiting) return;
	exiting = true;
	if (stdin.isTTY) stdin.setRawMode(false);
	stdin.pause();
	process.stdout.write("\x1b[?25h\x1b[?1049l");
	proc.kill(9);
	await kernel.dispose();
	process.exit(code);
};

// Forward keypresses to doom, intercept quit keys
stdin.on("data", (data: Buffer) => {
	// Ctrl+C (0x03) or q (0x71): quit immediately
	if (data.includes(0x03) || (data.length === 1 && data[0] === 0x71)) {
		void quit(0);
		return;
	}
	proc.writeStdin(new Uint8Array(data));
});

// Also quit if doom exits on its own
proc.wait().then((code) => quit(code));
