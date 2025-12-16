import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { init, Directory } from "@wasmer/sdk/node";
import { NodeProcess } from "./index";
import { SystemBridge } from "../system-bridge/index";
import * as fs from "fs";
import * as path from "path";

// Find npm installation path
const NPM_BIN = "/opt/homebrew/opt/node@22/bin/npm";
const NPM_PATH = fs.realpathSync(NPM_BIN).replace(/\/bin\/npm-cli\.js$/, "");

/**
 * Recursively copy a directory from host filesystem to virtual filesystem
 */
function copyDirToVirtual(
  hostPath: string,
  virtualPath: string,
  systemBridge: SystemBridge,
  options: { maxFiles?: number; skipPatterns?: RegExp[] } = {}
): number {
  const { maxFiles = Infinity, skipPatterns = [] } = options;
  let fileCount = 0;

  function shouldSkip(relativePath: string): boolean {
    return skipPatterns.some((pattern) => pattern.test(relativePath));
  }

  function copyRecursive(srcDir: string, destDir: string): void {
    if (fileCount >= maxFiles) return;

    // Ensure destination directory exists
    try {
      systemBridge.mkdir(destDir);
    } catch {
      // Directory may already exist
    }

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      if (fileCount >= maxFiles) return;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.posix.join(destDir, entry.name);
      const relativePath = path.relative(hostPath, srcPath);

      if (shouldSkip(relativePath)) continue;

      if (entry.isDirectory()) {
        copyRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(srcPath, "utf8");
        systemBridge.writeFile(destPath, content);
        fileCount++;
      }
    }
  }

  copyRecursive(hostPath, virtualPath);
  return fileCount;
}

describe("NPM CLI Integration", () => {
  let proc: NodeProcess;

  beforeAll(async () => {
    await init();
  });

  afterEach(() => {
    proc?.dispose();
  });

  describe("Step 1: npm --version", () => {
    it(
      "should run npm --version and return version string",
      async () => {
        const dir = new Directory();
        const systemBridge = new SystemBridge(dir);

        // Set up directory structure
        systemBridge.mkdir("/usr");
        systemBridge.mkdir("/usr/lib");
        systemBridge.mkdir("/usr/lib/node_modules");
        systemBridge.mkdir("/app");

        // Copy npm package
        console.log(`Copying npm from ${NPM_PATH}...`);
        const fileCount = copyDirToVirtual(
          NPM_PATH,
          "/usr/lib/node_modules/npm",
          systemBridge,
          {
            skipPatterns: [
              /\.md$/i, // Skip markdown files
              /\.txt$/i, // Skip text files
              /LICENSE/i, // Skip license files
              /CHANGELOG/i, // Skip changelogs
              /test\//i, // Skip test directories
              /docs\//i, // Skip docs
              /man\//i, // Skip man pages
            ],
          }
        );
        console.log(`Copied ${fileCount} files`);

        // Create a minimal package.json in /app and root
        systemBridge.writeFile(
          "/app/package.json",
          JSON.stringify({ name: "test-app", version: "1.0.0" })
        );
        systemBridge.writeFile(
          "/package.json",
          JSON.stringify({ name: "root", version: "1.0.0" })
        );

        // Create home directory structure for npm
        systemBridge.mkdir("/app/.npm");

        // Create npmrc config file (empty)
        systemBridge.writeFile("/app/.npmrc", "");
        systemBridge.writeFile("/.npmrc", "");

        // Create additional directories npm might need
        systemBridge.mkdir("/etc");
        systemBridge.writeFile("/etc/npmrc", "");
        systemBridge.mkdir("/usr/etc");
        systemBridge.writeFile("/usr/etc/npmrc", "");
        systemBridge.mkdir("/usr/local");
        systemBridge.mkdir("/usr/local/etc");
        systemBridge.writeFile("/usr/local/etc/npmrc", "");
        systemBridge.mkdir("/usr/bin");
        // Create a fake node executable marker
        systemBridge.writeFile("/usr/bin/node", "");
        // Also in npm's bin directory
        systemBridge.mkdir("/usr/lib/node_modules/npm/bin");
        systemBridge.writeFile("/usr/lib/node_modules/npm/bin/node", "");

        // Create /opt/homebrew/etc directory for global npm config
        systemBridge.mkdir("/opt");
        systemBridge.mkdir("/opt/homebrew");
        systemBridge.mkdir("/opt/homebrew/etc");
        systemBridge.writeFile("/opt/homebrew/etc/npmrc", "");

        proc = new NodeProcess({
          systemBridge,
          processConfig: {
            cwd: "/app",
            env: {
              PATH: "/usr/bin:/usr/lib/node_modules/npm/bin",
              HOME: "/app",
              npm_config_cache: "/app/.npm",
            },
            argv: ["node", "npm", "--version"],
          },
        });

        // Try to load and run npm CLI - use async IIFE that returns a Promise
        const result = await proc.exec(`
          (async function() {
            try {
              // npm uses proc-log which emits 'output' events on process
              // We need to listen for these and write to stdout
              process.on('output', (type, ...args) => {
                if (type === 'standard') {
                  process.stdout.write(args.join(' ') + '\\n');
                } else if (type === 'error') {
                  process.stderr.write(args.join(' ') + '\\n');
                }
              });

              // Load npm's CLI entry point
              const npmCli = require('/usr/lib/node_modules/npm/lib/cli.js');

              // npm cli expects to be called with process and is async
              await npmCli(process);
            } catch (e) {
              // Some npm errors are expected (like formatWithOptions not being a function)
              // but we should still be able to get the version output before the error
              if (!e.message.includes('formatWithOptions')) {
                console.error('Error:', e.message);
                process.exitCode = 1;
              }
            }
          })();
        `);

        console.log("stdout:", result.stdout);
        console.log("stderr:", result.stderr);
        console.log("code:", result.code);

        // Should output version number
        expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
      },
      { timeout: 60000 }
    );
  });
});
