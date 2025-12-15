// Test 18: File-system based IPC polling hack
// WASM writes request to /ipc/request.txt, host polls, executes node, writes response

import { init, Wasmer, Directory } from "@wasmer/sdk/node";
import * as fs from "fs/promises";
import { spawn } from "child_process";

const POLL_INTERVAL_MS = 20;
const MAX_POLLS = 500; // 10 seconds total

async function main(): Promise<void> {
  console.log("Test 18: File-system Based IPC Polling");
  console.log("======================================\n");

  await init();

  // Load our custom node-shim package
  const webcPath = "custom-node-pkg/test-node-shim-0.1.0.webc";
  console.log("Loading:", webcPath);

  const webcBytes = await fs.readFile(webcPath);
  console.log("Package size:", webcBytes.length, "bytes\n");

  const pkg = await Wasmer.fromFile(webcBytes);

  console.log("Commands available:", Object.keys(pkg.commands).length);
  console.log("Has node?", "node" in pkg.commands);
  console.log("Has bash?", "bash" in pkg.commands);
  console.log("");

  // Create IPC directory
  const ipcDir = new Directory();

  // Start the host polling loop
  let hostPollActive = true;
  let hostPollCount = 0;

  const hostPoller = (async () => {
    console.log("[HOST] Starting IPC polling loop...");

    while (hostPollActive && hostPollCount < MAX_POLLS) {
      hostPollCount++;

      try {
        // Check for request file
        const requestContent = await ipcDir.readTextFile("/request.txt");
        console.log(`[HOST] Found request after ${hostPollCount} polls:`, requestContent.trim());

        // Parse request (all lines are node args)
        const args = requestContent.trim().split("\n").filter(Boolean);
        console.log(`[HOST] Executing: node ${args.join(" ")}`);

        // Execute the actual node command
        const result = await executeNode(args);
        console.log(`[HOST] Exit code: ${result.exitCode}`);
        console.log(`[HOST] Stdout: ${result.stdout.substring(0, 200)}`);

        // Write response
        const responseContent = `${result.exitCode}\n${result.stdout}`;
        await ipcDir.writeFile("/response.txt", responseContent);
        console.log("[HOST] Wrote response");

        // Done processing this request
        hostPollActive = false;
        break;
      } catch {
        // Request not found yet, continue polling
        await sleep(POLL_INTERVAL_MS);
      }
    }

    if (hostPollCount >= MAX_POLLS) {
      console.log("[HOST] Polling timed out");
    }
  })();

  // Test 18a: Run our custom node command
  console.log("\n--- Test 18a: Run node command ---\n");
  try {
    const instance = await pkg.commands["node"].run({
      args: ["-e", "console.log('Hello from real Node!')"],
      mount: { "/ipc": ipcDir },
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 10s")), 10000)
      ),
    ]);

    console.log("\n[WASM] Exit code:", result.code);
    console.log("[WASM] Stdout:", result.stdout);
    console.log("[WASM] Stderr:", result.stderr);
  } catch (e: unknown) {
    console.log("[WASM] Error:", (e as Error).message);
  }

  // Wait for host poller to finish
  await hostPoller;

  // Test 18b: Run node with a script via bash
  console.log("\n--- Test 18b: bash calls node ---\n");

  // Reset poller
  hostPollActive = true;
  hostPollCount = 0;
  const ipcDir2 = new Directory();

  const hostPoller2 = (async () => {
    console.log("[HOST] Starting IPC polling loop...");
    while (hostPollActive && hostPollCount < MAX_POLLS) {
      hostPollCount++;
      try {
        const requestContent = await ipcDir2.readTextFile("/request.txt");
        console.log(`[HOST] Found request after ${hostPollCount} polls:`, requestContent.trim());
        const args = requestContent.trim().split("\n").filter(Boolean);
        console.log(`[HOST] Executing: node ${args.join(" ")}`);
        const result = await executeNode(args);
        console.log(`[HOST] Exit code: ${result.exitCode}`);
        console.log(`[HOST] Stdout: ${result.stdout.substring(0, 200)}`);
        const responseContent = `${result.exitCode}\n${result.stdout}`;
        await ipcDir2.writeFile("/response.txt", responseContent);
        console.log("[HOST] Wrote response");
        hostPollActive = false;
        break;
      } catch {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  })();

  try {
    const instance = await pkg.commands["bash"].run({
      args: ["-c", "echo 'Calling node from bash...' && node -e \"console.log(2+2)\" && echo 'Done!'"],
      mount: { "/ipc": ipcDir2 },
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 10s")), 10000)
      ),
    ]);

    console.log("\n[WASM] Exit code:", result.code);
    console.log("[WASM] Stdout:", result.stdout);
    console.log("[WASM] Stderr:", result.stderr);
  } catch (e: unknown) {
    console.log("[WASM] Error:", (e as Error).message);
  }

  await hostPoller2;

  console.log("\n=== Summary ===");
  console.log(`Test 18a host polls: completed`);
  console.log(`Test 18b host polls: ${hostPollCount}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeNode(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    proc.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

main().catch(console.error);
