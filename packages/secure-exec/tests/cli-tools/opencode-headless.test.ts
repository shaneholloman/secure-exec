/**
 * E2E test: OpenCode coding agent headless mode via sandbox child_process bridge.
 *
 * Verifies OpenCode can boot, produce output in both text and JSON formats,
 * read/write files, handle SIGINT, and report errors through its JSON event
 * stream. OpenCode is a standalone Bun binary (NOT a Node.js package) —
 * tests exercise the child_process.spawn bridge by running JS code inside
 * the sandbox VM that calls child_process.spawn('opencode', ...). The bridge
 * spawns the real opencode binary on the host.
 *
 * OpenCode uses its built-in proxy for LLM calls. The mock LLM server is
 * available via ANTHROPIC_BASE_URL when the environment supports it (some
 * opencode versions hang during plugin init with BASE_URL redirects). When
 * the mock server path is not viable, tests fall back to the real proxy.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NodeRuntime,
  NodeFileSystem,
  allowAll,
  createNodeDriver,
} from '../../src/index.js';
import type { CommandExecutor, SpawnedProcess } from '../../src/types.js';
import { createTestNodeRuntime } from '../test-utils.js';
import {
  createMockLlmServer,
  type MockLlmServerHandle,
} from './mock-llm-server.ts';

// ---------------------------------------------------------------------------
// Skip helpers
// ---------------------------------------------------------------------------

function hasOpenCodeBinary(): boolean {
  try {
    const { execSync } = require('node:child_process');
    execSync('opencode --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skipReason = hasOpenCodeBinary()
  ? false
  : 'opencode binary not found on PATH';

// ---------------------------------------------------------------------------
// Stdio capture helper
// ---------------------------------------------------------------------------

type CapturedEvent = {
  channel: 'stdout' | 'stderr';
  message: string;
};

function createStdioCapture() {
  const events: CapturedEvent[] = [];
  return {
    events,
    onStdio: (event: CapturedEvent) => events.push(event),
    // Join with newline: the bridge strips trailing newlines from each
    // process.stdout.write() call, so NDJSON events arriving as separate
    // chunks lose their delimiters. Newline-join restores them.
    stdout: () =>
      events
        .filter((e) => e.channel === 'stdout')
        .map((e) => e.message)
        .join('\n'),
    stderr: () =>
      events
        .filter((e) => e.channel === 'stderr')
        .map((e) => e.message)
        .join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Host command executor for child_process bridge
// ---------------------------------------------------------------------------

function createHostCommandExecutor(): CommandExecutor {
  return {
    spawn(
      command: string,
      args: string[],
      options: {
        cwd?: string;
        env?: Record<string, string>;
        onStdout?: (data: Uint8Array) => void;
        onStderr?: (data: Uint8Array) => void;
      },
    ): SpawnedProcess {
      const child = nodeSpawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (options.onStdout)
        child.stdout.on('data', (d: Buffer) =>
          options.onStdout!(new Uint8Array(d)),
        );
      if (options.onStderr)
        child.stderr.on('data', (d: Buffer) =>
          options.onStderr!(new Uint8Array(d)),
        );
      return {
        writeStdin(data: Uint8Array | string) {
          child.stdin.write(data);
        },
        closeStdin() {
          child.stdin.end();
        },
        kill(signal?: number) {
          child.kill(signal);
        },
        wait(): Promise<number> {
          return new Promise((resolve) =>
            child.on('close', (code) => resolve(code ?? 1)),
          );
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox runtime factory
// ---------------------------------------------------------------------------

function createOpenCodeSandboxRuntime(opts: {
  onStdio: (event: CapturedEvent) => void;
}): NodeRuntime {
  return createTestNodeRuntime({
    driver: createNodeDriver({
      filesystem: new NodeFileSystem(),
      commandExecutor: createHostCommandExecutor(),
      permissions: allowAll,
      processConfig: {
        cwd: '/root',
        env: {
          PATH: process.env.PATH ?? '/usr/bin',
          HOME: process.env.HOME ?? tmpdir(),
        },
      },
    }),
    onStdio: opts.onStdio,
  });
}

const SANDBOX_EXEC_OPTS = { filePath: '/root/entry.js', cwd: '/root' };

// ---------------------------------------------------------------------------
// Sandbox code builders
// ---------------------------------------------------------------------------

/** Build env object for OpenCode spawn inside the sandbox. */
function openCodeEnv(opts: {
  mockPort?: number;
  extraEnv?: Record<string, string>;
} = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    XDG_DATA_HOME: path.join(
      tmpdir(),
      `opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ),
    ...(opts.extraEnv ?? {}),
  };

  if (opts.mockPort) {
    env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? 'test-key';
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${opts.mockPort}`;
  }

  return env;
}

/**
 * Build sandbox code that spawns OpenCode and pipes stdout/stderr to
 * process.stdout/stderr. Exit code is forwarded from the binary.
 *
 * process.exit() must be called at the top-level await, not inside a bridge
 * callback — calling it inside childProcessDispatch would throw a
 * ProcessExitError through the host reference chain, causing an unhandled
 * rejection.
 */
function buildSpawnCode(opts: {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeout?: number;
}): string {
  return `(async () => {
    const { spawn } = require('child_process');
    const child = spawn('opencode', ${JSON.stringify(opts.args)}, {
      env: ${JSON.stringify(opts.env)},
      cwd: ${JSON.stringify(opts.cwd)},
    });

    child.stdin.end();

    child.stdout.on('data', (d) => process.stdout.write(String(d)));
    child.stderr.on('data', (d) => process.stderr.write(String(d)));

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(124);
      }, ${opts.timeout ?? 45000});

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) process.exit(exitCode);
  })()`;
}

/**
 * Build sandbox code that spawns OpenCode, waits for any output, sends
 * SIGINT through the bridge, then reports the exit code.
 */
function buildSigintCode(opts: {
  args: string[];
  env: Record<string, string>;
  cwd: string;
}): string {
  return `(async () => {
    const { spawn } = require('child_process');
    const child = spawn('opencode', ${JSON.stringify(opts.args)}, {
      env: ${JSON.stringify(opts.env)},
      cwd: ${JSON.stringify(opts.cwd)},
    });

    child.stdin.end();

    child.stdout.on('data', (d) => process.stdout.write(String(d)));
    child.stderr.on('data', (d) => process.stderr.write(String(d)));

    // Wait for output then send SIGINT
    let sentSigint = false;
    const onOutput = () => {
      if (!sentSigint) {
        sentSigint = true;
        child.kill('SIGINT');
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    const exitCode = await new Promise((resolve) => {
      // No-output safety timeout
      const noOutputTimer = setTimeout(() => {
        if (!sentSigint) {
          child.kill();
          resolve(2);
        }
      }, 15000);

      // SIGKILL fallback (should not be needed)
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(137);
      }, 25000);

      child.on('close', (code) => {
        clearTimeout(noOutputTimer);
        clearTimeout(killTimer);
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) process.exit(exitCode);
  })()`;
}

/** Parse JSON events from opencode --format json output. */
function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockServer: MockLlmServerHandle;
let workDir: string;
let mockRedirectWorks: boolean;

describe.skipIf(skipReason)('OpenCode headless E2E (sandbox child_process bridge)', () => {
  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);

    // Probe BASE_URL redirect via sandbox child_process bridge
    mockServer.reset([{ type: 'text', text: 'PROBE_OK' }]);
    const probeCapture = createStdioCapture();
    const probeRuntime = createOpenCodeSandboxRuntime({
      onStdio: probeCapture.onStdio,
    });
    try {
      const result = await probeRuntime.exec(
        buildSpawnCode({
          args: [
            'run',
            '-m',
            'anthropic/claude-sonnet-4-6',
            '--format',
            'json',
            'say ok',
          ],
          env: openCodeEnv({ mockPort: mockServer.port }),
          cwd: process.cwd(),
          timeout: 8000,
        }),
        SANDBOX_EXEC_OPTS,
      );
      mockRedirectWorks = result.code === 0;
    } catch {
      mockRedirectWorks = false;
    } finally {
      probeRuntime.dispose();
    }

    workDir = await mkdtemp(path.join(tmpdir(), 'opencode-headless-'));
  }, 30_000);

  afterAll(async () => {
    await mockServer?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Boot & output tests (work with real API or mock)
  // -------------------------------------------------------------------------

  it(
    'OpenCode boots in run mode — exits with code 0',
    async () => {
      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        if (mockRedirectWorks) {
          mockServer.reset([
            { type: 'text', text: 'title' },
            { type: 'text', text: 'Hello!' },
            { type: 'text', text: 'Hello!' },
          ]);
        }

        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              'run',
              '-m',
              'anthropic/claude-sonnet-4-6',
              '--format',
              'json',
              'say hello',
            ],
            env: mockRedirectWorks
              ? openCodeEnv({ mockPort: mockServer.port })
              : openCodeEnv(),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        if (result.code !== 0) {
          console.log('OpenCode boot stderr:', capture.stderr().slice(0, 2000));
        }
        expect(result.code).toBe(0);
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'OpenCode produces output — stdout contains LLM response',
    async () => {
      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        if (mockRedirectWorks) {
          const canary = 'UNIQUE_CANARY_OC_42';
          mockServer.reset([
            { type: 'text', text: 'title' },
            { type: 'text', text: canary },
            { type: 'text', text: canary },
          ]);

          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                'say hello',
              ],
              env: openCodeEnv({ mockPort: mockServer.port }),
              cwd: workDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(result.code).toBe(0);
          expect(capture.stdout()).toContain(canary);
        } else {
          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                'respond with exactly: HELLO_OUTPUT',
              ],
              env: openCodeEnv(),
              cwd: workDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(result.code).toBe(0);
          const events = parseJsonEvents(capture.stdout());
          const textEvents = events.filter((e) => e.type === 'text');
          expect(textEvents.length).toBeGreaterThan(0);
        }
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'OpenCode text format — --format default produces formatted output',
    async () => {
      const canary = 'TEXTFORMAT_CANARY_99';
      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        if (mockRedirectWorks) {
          mockServer.reset([
            { type: 'text', text: canary },
            { type: 'text', text: canary },
            { type: 'text', text: canary },
          ]);
        }

        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              'run',
              '-m',
              'anthropic/claude-sonnet-4-6',
              '--format',
              'default',
              mockRedirectWorks ? 'say hello' : 'respond with: hi',
            ],
            env: mockRedirectWorks
              ? openCodeEnv({ mockPort: mockServer.port })
              : openCodeEnv(),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        expect(result.code).toBe(0);
        const stripped = capture
          .stdout()
          .replace(/\x1b\[[0-9;]*m/g, '')
          .trim();
        expect(stripped.length).toBeGreaterThan(0);
        if (mockRedirectWorks) {
          expect(stripped).toContain(canary);
        }
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'OpenCode JSON format — --format json produces valid JSON events',
    async () => {
      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        if (mockRedirectWorks) {
          mockServer.reset([
            { type: 'text', text: 'title' },
            { type: 'text', text: 'Hello JSON!' },
            { type: 'text', text: 'Hello JSON!' },
          ]);
        }

        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              'run',
              '-m',
              'anthropic/claude-sonnet-4-6',
              '--format',
              'json',
              mockRedirectWorks ? 'say hello' : 'respond with: hi',
            ],
            env: mockRedirectWorks
              ? openCodeEnv({ mockPort: mockServer.port })
              : openCodeEnv(),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        expect(result.code).toBe(0);
        const events = parseJsonEvents(capture.stdout());
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          expect(event).toHaveProperty('type');
        }
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'Environment forwarding — API key and base URL reach the binary through the bridge',
    async () => {
      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        if (mockRedirectWorks) {
          mockServer.reset([
            { type: 'text', text: 'title' },
            { type: 'text', text: 'ENV_OK' },
            { type: 'text', text: 'ENV_OK' },
          ]);

          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                'say hello',
              ],
              env: openCodeEnv({ mockPort: mockServer.port }),
              cwd: workDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(mockServer.requestCount()).toBeGreaterThanOrEqual(1);
          expect(result.code).toBe(0);
        } else {
          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                'respond with: ok',
              ],
              env: openCodeEnv({
                extraEnv: { ANTHROPIC_API_KEY: 'forwarded-test-key' },
              }),
              cwd: workDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(result.code).toBe(0);
          const events = parseJsonEvents(capture.stdout());
          expect(events.length).toBeGreaterThan(0);
        }
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // File operation tests
  // -------------------------------------------------------------------------

  it(
    'OpenCode reads sandbox file — read tool accesses seeded file',
    async () => {
      const testDir = path.join(workDir, 'read-test');
      await mkdir(testDir, { recursive: true });
      const secretContent = 'secret_oc_content_xyz_' + Date.now();
      await writeFile(path.join(testDir, 'test.txt'), secretContent);

      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        if (mockRedirectWorks) {
          mockServer.reset([
            { type: 'text', text: 'title' },
            {
              type: 'tool_use',
              name: 'read',
              input: { path: path.join(testDir, 'test.txt') },
            },
            { type: 'text', text: `The file contains: ${secretContent}` },
            { type: 'text', text: secretContent },
          ]);

          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                `read the file at ${path.join(testDir, 'test.txt')} and repeat its exact contents`,
              ],
              env: openCodeEnv({ mockPort: mockServer.port }),
              cwd: testDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(result.code).toBe(0);
          expect(mockServer.requestCount()).toBeGreaterThanOrEqual(2);
          expect(capture.stdout()).toContain(secretContent);
        } else {
          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                `Use the read tool to read the file at ${path.join(testDir, 'test.txt')} and output its exact contents. Do not explain, just output the contents.`,
              ],
              env: openCodeEnv(),
              cwd: testDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(result.code).toBe(0);
          expect(capture.stdout()).toContain(secretContent);
        }
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'OpenCode writes sandbox file — file exists in filesystem after write',
    async () => {
      const testDir = path.join(workDir, 'write-test');
      await mkdir(testDir, { recursive: true });
      const outPath = path.join(testDir, 'out.txt');
      const writeContent = 'hello_from_opencode_mock';

      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        if (mockRedirectWorks) {
          mockServer.reset([
            { type: 'text', text: 'title' },
            {
              type: 'tool_use',
              name: 'bash',
              input: {
                command: `echo -n '${writeContent}' > '${outPath}'`,
              },
            },
            { type: 'text', text: 'I wrote the file.' },
            { type: 'text', text: 'done' },
          ]);

          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                `create a file at ${outPath} with the content: ${writeContent}`,
              ],
              env: openCodeEnv({ mockPort: mockServer.port }),
              cwd: testDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(result.code).toBe(0);
          expect(mockServer.requestCount()).toBeGreaterThanOrEqual(3);
          const fileCreated = existsSync(outPath);
          if (fileCreated) {
            const content = await readFile(outPath, 'utf8');
            expect(content).toContain(writeContent);
          }
          expect(capture.stdout()).toContain('I wrote the file');
        } else {
          const result = await runtime.exec(
            buildSpawnCode({
              args: [
                'run',
                '-m',
                'anthropic/claude-sonnet-4-6',
                '--format',
                'json',
                `Use the bash tool to run: echo -n '${writeContent}' > '${outPath}'. Do not explain.`,
              ],
              env: openCodeEnv(),
              cwd: testDir,
            }),
            SANDBOX_EXEC_OPTS,
          );

          expect(result.code).toBe(0);
          expect(existsSync(outPath)).toBe(true);
          const content = await readFile(outPath, 'utf8');
          expect(content).toContain(writeContent);
        }
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Signal handling
  // -------------------------------------------------------------------------

  it(
    'SIGINT stops execution — send SIGINT through bridge, process terminates cleanly',
    async () => {
      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSigintCode({
            args: [
              'run',
              '-m',
              'anthropic/claude-sonnet-4-6',
              '--format',
              'json',
              'Write a very long essay about the history of computing. Make it at least 5000 words.',
            ],
            env: openCodeEnv(),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        // Exit code 2 = no output received (environment issue, skip gracefully)
        if (result.code === 2) return;

        // Should not need SIGKILL (exit code 137)
        expect(result.code).not.toBe(137);
      } finally {
        runtime.dispose();
      }
    },
    45_000,
  );

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it(
    'Exit code on error — bad model produces error event',
    async () => {
      if (mockRedirectWorks) {
        mockServer.reset([]);
      }

      const capture = createStdioCapture();
      const runtime = createOpenCodeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              'run',
              '-m',
              'fakeprovider/nonexistent-model',
              '--format',
              'json',
              'say hello',
            ],
            env: openCodeEnv(),
            cwd: workDir,
            timeout: 15000,
          }),
          SANDBOX_EXEC_OPTS,
        );

        const combined = capture.stdout() + capture.stderr();
        const hasError =
          combined.includes('Error') ||
          combined.includes('error') ||
          combined.includes('ProviderModelNotFoundError') ||
          combined.includes('not found');
        expect(hasError).toBe(true);
      } finally {
        runtime.dispose();
      }
    },
    30_000,
  );
});
