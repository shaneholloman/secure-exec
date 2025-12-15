// Test 14: Using `uses` to include packages in bash
// The `uses` option lets you make other Wasmer packages available as commands
// inside the running container.

import { init, Wasmer, Directory } from "@wasmer/sdk/node";

async function main(): Promise<void> {
  console.log("Test 14: Using `uses` to Include Packages");
  console.log("==========================================\n");

  await init();

  // Create a directory with test files
  const dir = new Directory();
  await dir.writeFile("/hello.txt", "Hello from the virtual filesystem!\n");
  await dir.writeFile(
    "/test.sh",
    `#!/bin/bash
echo "=== Running test.sh ==="
echo "Listing /app directory:"
ls -la /app
echo ""
echo "Reading hello.txt:"
cat /app/hello.txt
echo ""
echo "Using cowsay:"
echo "Hello WASM" | cowsay
echo ""
echo "Trying to call node:"
node -e "console.log('from node')" || echo "node: command not found (expected)"
echo "=== Done ==="
`
  );

  console.log("Loading bash from wasmer registry...");
  const bashPkg = await Wasmer.fromRegistry("sharrattj/bash");
  console.log("Bash loaded\n");

  // Test 14a: Run bash WITHOUT uses (ls/cat won't work)
  console.log("--- Test 14a: bash WITHOUT uses ---\n");
  console.log("Running: bash -c 'ls /app'");
  console.log("(Expected: ls command not found)\n");

  try {
    const instance = await bashPkg.entrypoint!.run({
      args: ["-c", "ls /app || echo 'ls not available'"],
      mount: { "/app": dir },
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 5s")), 5000)
      ),
    ]);

    console.log("Exit code:", result.code);
    console.log("Stdout:", result.stdout);
    console.log("Stderr:", result.stderr);
  } catch (e: unknown) {
    const err = e as Error;
    console.log("Result:", err.message);
  }

  // Test 14a2: Check PATH without uses
  console.log("\n--- Test 14a2: Check $PATH without uses ---\n");

  try {
    const instance = await bashPkg.entrypoint!.run({
      args: ["-c", "echo $PATH"],
      mount: { "/app": dir },
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 5s")), 5000)
      ),
    ]);

    console.log("PATH without uses:", result.stdout);
  } catch (e: unknown) {
    const err = e as Error;
    console.log("Result:", err.message);
  }

  // Test 14b: Run bash WITH coreutils
  console.log("\n--- Test 14b: bash WITH uses: ['sharrattj/coreutils'] ---\n");
  console.log("Running: bash -c 'ls /app && cat /app/hello.txt'");
  console.log("(Expected: works because coreutils is included)\n");

  try {
    const instance = await bashPkg.entrypoint!.run({
      args: ["-c", "ls /app && cat /app/hello.txt"],
      mount: { "/app": dir },
      uses: ["sharrattj/coreutils"],
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 5s")), 5000)
      ),
    ]);

    console.log("Exit code:", result.code);
    console.log("Stdout:", result.stdout);
    console.log("Stderr:", result.stderr);
  } catch (e: unknown) {
    const err = e as Error;
    console.log("Result:", err.message);
  }

  // Test 14b2: Check PATH with uses
  console.log("\n--- Test 14b2: Check $PATH WITH uses ---\n");

  try {
    const instance = await bashPkg.entrypoint!.run({
      args: ["-c", "echo $PATH && which ls"],
      mount: { "/app": dir },
      uses: ["sharrattj/coreutils"],
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 5s")), 5000)
      ),
    ]);

    console.log("Stdout:", result.stdout);
    console.log("Stderr:", result.stderr);
  } catch (e: unknown) {
    const err = e as Error;
    console.log("Result:", err.message);
  }

  // Test 14c: Run bash with coreutils AND cowsay
  console.log("\n--- Test 14c: bash WITH uses: ['sharrattj/coreutils', 'cowsay'] ---\n");
  console.log("Running: bash -c 'echo hello | cowsay'");

  try {
    const instance = await bashPkg.entrypoint!.run({
      args: ["-c", "echo hello | cowsay"],
      mount: { "/app": dir },
      uses: ["sharrattj/coreutils", "cowsay"],
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 5s")), 5000)
      ),
    ]);

    console.log("Exit code:", result.code);
    console.log("Stdout:", result.stdout);
    console.log("Stderr:", result.stderr);
  } catch (e: unknown) {
    const err = e as Error;
    console.log("Result:", err.message);
  }

  // Test 14d: Run the full test script
  console.log("\n--- Test 14d: Run test.sh with coreutils + cowsay ---\n");

  try {
    const instance = await bashPkg.entrypoint!.run({
      args: ["/app/test.sh"],
      mount: { "/app": dir },
      uses: ["sharrattj/coreutils", "cowsay"],
    });

    const result = await Promise.race([
      instance.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 10s")), 10000)
      ),
    ]);

    console.log("Exit code:", result.code);
    console.log("Stdout:", result.stdout);
    console.log("Stderr:", result.stderr);
  } catch (e: unknown) {
    const err = e as Error;
    console.log("Result:", err.message);
  }

  // Test 14e: Can we add a custom package with `node`?
  console.log("\n--- Test 14e: Check if there's a node package ---\n");
  console.log("Attempting to use 'wasmer/node' or similar...");

  try {
    // Try to load node package (probably doesn't exist)
    const nodePkg = await Wasmer.fromRegistry("wasmer/node");
    console.log("Found wasmer/node package!");
    console.log("Commands:", Object.keys(nodePkg.commands || {}));
  } catch (e: unknown) {
    const err = e as Error;
    console.log("wasmer/node not found:", err.message);
  }

  try {
    const nodePkg = await Wasmer.fromRegistry("syrusakbary/node");
    console.log("Found syrusakbary/node package!");
    console.log("Commands:", Object.keys(nodePkg.commands || {}));
  } catch (e: unknown) {
    const err = e as Error;
    console.log("syrusakbary/node not found:", err.message);
  }

  console.log("\n=== Summary ===\n");
  console.log("The `uses` option allows including Wasmer packages as commands:");
  console.log("  - uses: ['sharrattj/coreutils'] → ls, cat, etc. available");
  console.log("  - uses: ['cowsay'] → cowsay command available");
  console.log("");
  console.log("However, there's no 'node' package in Wasmer registry,");
  console.log("so we still can't call Node.js from within bash.");
}

main().catch(console.error);
