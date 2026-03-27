/**
 * E2E test: OpenCode headless mode through the secure-exec sandbox.
 *
 * Runs `opencode run` from sandboxed Node code via the child_process bridge
 * and asserts the real-provider NDJSON output stream includes filesystem and
 * command tool activity plus the final assistant response.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createKernel,
  allowAllChildProcess,
  allowAllEnv,
} from '../../../core/src/kernel/index.ts';
import type {
  DriverProcess,
  Kernel,
  KernelInterface,
  ProcessContext,
  RuntimeDriver,
} from '../../../core/src/kernel/index.ts';
import type { VirtualFileSystem } from '../../../core/src/kernel/vfs.ts';
import { InMemoryFileSystem } from '../../../browser/src/os-filesystem.ts';
import { createNodeRuntime } from '../../../nodejs/src/kernel-runtime.ts';
import { loadRealProviderEnv } from './real-provider-env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const OPENCODE_BIN = path.join(PACKAGE_ROOT, 'node_modules/.bin/opencode');
const REAL_PROVIDER_FLAG = 'SECURE_EXEC_OPENCODE_REAL_PROVIDER_E2E';
const OPENCODE_MODEL = 'anthropic/claude-sonnet-4-6';

class HostBinaryDriver implements RuntimeDriver {
  readonly name = 'host-binary';
  readonly commands: string[];

  constructor(commands: string[]) {
    this.commands = commands;
  }

  async init(_kernel: KernelInterface): Promise<void> {}

  spawn(command: string, args: string[], ctx: ProcessContext): DriverProcess {
    const child = nodeSpawn(command, args, {
      cwd: ctx.cwd,
      env: ctx.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolveExit!: (code: number) => void;
    let exitResolved = false;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = (code: number) => {
        if (exitResolved) return;
        exitResolved = true;
        resolve(code);
      };
    });

    const proc: DriverProcess = {
      onStdout: null,
      onStderr: null,
      onExit: null,
      writeStdin: (data) => {
        try {
          child.stdin.write(data);
        } catch {
          // stdin may already be closed
        }
      },
      closeStdin: () => {
        try {
          child.stdin.end();
        } catch {
          // stdin may already be closed
        }
      },
      kill: (signal) => {
        try {
          child.kill(signal);
        } catch {
          // process may already be dead
        }
      },
      wait: () => exitPromise,
    };

    child.on('error', (error) => {
      const message = `${command}: ${error.message}\n`;
      const bytes = new TextEncoder().encode(message);
      ctx.onStderr?.(bytes);
      proc.onStderr?.(bytes);
      resolveExit(127);
      proc.onExit?.(127);
    });

    child.stdout.on('data', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      ctx.onStdout?.(bytes);
      proc.onStdout?.(bytes);
    });

    child.stderr.on('data', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      ctx.onStderr?.(bytes);
      proc.onStderr?.(bytes);
    });

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      resolveExit(exitCode);
      proc.onExit?.(exitCode);
    });

    return proc;
  }

  async dispose(): Promise<void> {}
}

function createOverlayVfs(): VirtualFileSystem {
  const memfs = new InMemoryFileSystem();
  return {
    readFile: async (filePath) => {
      try {
        return await memfs.readFile(filePath);
      } catch {
        return new Uint8Array(await fsPromises.readFile(filePath));
      }
    },
    readTextFile: async (filePath) => {
      try {
        return await memfs.readTextFile(filePath);
      } catch {
        return await fsPromises.readFile(filePath, 'utf8');
      }
    },
    readDir: async (filePath) => {
      try {
        return await memfs.readDir(filePath);
      } catch {
        return await fsPromises.readdir(filePath);
      }
    },
    readDirWithTypes: async (filePath) => {
      try {
        return await memfs.readDirWithTypes(filePath);
      } catch {
        const entries = await fsPromises.readdir(filePath, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      }
    },
    exists: async (filePath) => {
      if (await memfs.exists(filePath)) return true;
      try {
        await fsPromises.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => {
      try {
        return await memfs.stat(filePath);
      } catch {
        const stat = await fsPromises.stat(filePath);
        return {
          mode: stat.mode,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isSymbolicLink: false,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          birthtimeMs: stat.birthtimeMs,
        };
      }
    },
    lstat: async (filePath) => {
      try {
        return await memfs.lstat(filePath);
      } catch {
        const stat = await fsPromises.lstat(filePath);
        return {
          mode: stat.mode,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isSymbolicLink: stat.isSymbolicLink(),
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          birthtimeMs: stat.birthtimeMs,
        };
      }
    },
    realpath: async (filePath) => {
      try {
        return await memfs.realpath(filePath);
      } catch {
        return await fsPromises.realpath(filePath);
      }
    },
    readlink: async (filePath) => {
      try {
        return await memfs.readlink(filePath);
      } catch {
        return await fsPromises.readlink(filePath);
      }
    },
    pread: async (filePath, offset, length) => {
      try {
        return await memfs.pread(filePath, offset, length);
      } catch {
        const fd = await fsPromises.open(filePath, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await fd.read(buffer, 0, length, offset);
          return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        } finally {
          await fd.close();
        }
      }
    },
    writeFile: (filePath, content) => memfs.writeFile(filePath, content),
    createDir: (filePath) => memfs.createDir(filePath),
    mkdir: (filePath, options) => memfs.mkdir(filePath, options),
    removeFile: (filePath) => memfs.removeFile(filePath),
    removeDir: (filePath) => memfs.removeDir(filePath),
    rename: (oldPath, newPath) => memfs.rename(oldPath, newPath),
    symlink: (target, filePath) => memfs.symlink(target, filePath),
    link: (oldPath, newPath) => memfs.link(oldPath, newPath),
    chmod: (filePath, mode) => memfs.chmod(filePath, mode),
    chown: (filePath, uid, gid) => memfs.chown(filePath, uid, gid),
    utimes: (filePath, atime, mtime) => memfs.utimes(filePath, atime, mtime),
    truncate: (filePath, length) => memfs.truncate(filePath, length),
  };
}

function skipUnlessOpenCodeInstalled(): string | false {
  if (!existsSync(OPENCODE_BIN)) {
    return 'opencode-ai test dependency not installed';
  }

  const probe = spawnSync(OPENCODE_BIN, ['--version'], { stdio: 'ignore' });
  return probe.status === 0
    ? false
    : `opencode binary probe failed with status ${probe.status ?? 'unknown'}`;
}

function getSkipReason(): string | false {
  const opencodeSkip = skipUnlessOpenCodeInstalled();
  if (opencodeSkip) return opencodeSkip;

  if (process.env[REAL_PROVIDER_FLAG] !== '1') {
    return `${REAL_PROVIDER_FLAG}=1 required for real provider E2E`;
  }

  return loadRealProviderEnv(['ANTHROPIC_API_KEY']).skipReason ?? false;
}

function buildHeadlessScript(): string {
  return [
    'const { spawn } = require("node:child_process");',
    'const child = spawn("opencode", [',
    '  "run",',
    '  "-m",',
    '  process.env.OPENCODE_MODEL,',
    '  "--format",',
    '  "json",',
    '  process.env.OPENCODE_PROMPT,',
    '], {',
    '  cwd: process.env.OPENCODE_WORKDIR,',
    '  env: process.env,',
    '  stdio: ["pipe", "pipe", "pipe"],',
    '});',
    'try { child.stdin.end(); } catch {}',
    'child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));',
    'child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));',
    'child.on("error", (error) => {',
    '  process.stderr.write("CHILD_ERROR:" + error.message + "\\n");',
    '  process.exitCode = 127;',
    '});',
    'child.on("close", (code) => {',
    '  process.exitCode = code ?? 1;',
    '});',
  ].join('\n');
}

async function createNodeKernel(): Promise<Kernel> {
  const kernel = createKernel({ filesystem: createOverlayVfs() });
  await kernel.mount(createNodeRuntime({
    permissions: { ...allowAllChildProcess, ...allowAllEnv },
  }));
  await kernel.mount(new HostBinaryDriver(['opencode']));
  return kernel;
}

async function runKernelCommand(
  kernel: Kernel,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const proc = kernel.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    onStdout: (data) => stdout.push(new TextDecoder().decode(data)),
    onStderr: (data) => stderr.push(new TextDecoder().decode(data)),
  });

  const timeoutMs = options.timeoutMs ?? 45_000;
  const timeout = new Promise<number>((resolve) => {
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // process may already be closed
      }
      resolve(124);
    }, timeoutMs).unref();
  });

  const exitCode = await Promise.race([proc.wait(), timeout]);
  return {
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => event !== null);
}

function getTextEventText(events: Array<Record<string, unknown>>): string {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => {
      const part = event.part;
      if (!part || typeof part !== 'object') return '';
      return typeof (part as { text?: unknown }).text === 'string'
        ? String((part as { text: string }).text)
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractJsonBlock(text: string): Record<string, string> | null {
  const match = text.match(/```json\s*([\s\S]*?)```/i);
  if (!match) return null;

  try {
    return JSON.parse(match[1]) as Record<string, string>;
  } catch {
    return null;
  }
}

const skipReason = getSkipReason();

describe.skipIf(skipReason)('OpenCode headless real-provider E2E (sandbox path)', () => {
  let kernel: Kernel | undefined;
  let workDir: string | undefined;
  let xdgDataHome: string | undefined;

  afterEach(async () => {
    await kernel?.dispose();
    kernel = undefined;

    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }

    if (xdgDataHome) {
      await rm(xdgDataHome, { recursive: true, force: true });
      xdgDataHome = undefined;
    }
  });

  it(
    'runs sandboxed opencode headless mode with real provider and records read/bash tool events',
    async () => {
      const providerEnv = loadRealProviderEnv(['ANTHROPIC_API_KEY']);
      expect(providerEnv.skipReason).toBeUndefined();

      workDir = await mkdtemp(path.join(tmpdir(), 'opencode-headless-real-provider-'));
      xdgDataHome = await mkdtemp(path.join(tmpdir(), 'opencode-headless-real-provider-xdg-'));

      spawnSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
      await writeFile(
        path.join(workDir, 'package.json'),
        '{"name":"opencode-headless-real-provider","private":true}\n',
      );

      const canary = `OPENCODE_HEADLESS_REAL_PROVIDER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await writeFile(path.join(workDir, 'note.txt'), `${canary}\n`);

      kernel = await createNodeKernel();
      const sandboxEnv = {
        ...providerEnv.env!,
        PATH: `${path.join(PACKAGE_ROOT, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
        HOME: workDir,
        NO_COLOR: '1',
        XDG_DATA_HOME: xdgDataHome,
        OPENCODE_MODEL,
        OPENCODE_PROMPT: 'Read note.txt, run pwd, then reply with a JSON object containing note and pwd only.',
        OPENCODE_WORKDIR: workDir,
      };

      const result = await runKernelCommand(
        kernel,
        'node',
        ['-e', buildHeadlessScript()],
        {
          cwd: workDir,
          env: sandboxEnv,
          timeoutMs: 50_000,
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);

      const events = parseJsonEvents(result.stdout);
      expect(events.length, result.stdout).toBeGreaterThan(0);

      const toolEvents = events.filter((event) => event.type === 'tool_use');
      const readEvent = toolEvents.find((event) => {
        const part = event.part;
        return Boolean(
          part &&
          typeof part === 'object' &&
          (part as { tool?: unknown }).tool === 'read',
        );
      });
      const bashEvent = toolEvents.find((event) => {
        const part = event.part;
        return Boolean(
          part &&
          typeof part === 'object' &&
          (part as { tool?: unknown }).tool === 'bash',
        );
      });

      expect(readEvent, JSON.stringify(toolEvents)).toBeTruthy();
      expect(bashEvent, JSON.stringify(toolEvents)).toBeTruthy();

      const readOutput = String(
        ((readEvent?.part as { state?: { output?: unknown } } | undefined)?.state?.output) ?? '',
      );
      expect(readOutput).toContain(canary);
      expect(readOutput).toContain('note.txt');

      const bashState = (bashEvent?.part as {
        state?: {
          input?: { command?: unknown };
          metadata?: { exit?: unknown; output?: unknown };
        };
      } | undefined)?.state;
      expect(String(bashState?.input?.command ?? '')).toBe('pwd');
      expect(bashState?.metadata?.exit).toBe(0);
      expect(String(bashState?.metadata?.output ?? '')).toContain(workDir);

      const assistantText = getTextEventText(events);
      expect(assistantText).toContain(canary);
      expect(assistantText).toContain(workDir);

      const parsedAnswer = extractJsonBlock(assistantText);
      expect(parsedAnswer).toBeTruthy();
      expect(parsedAnswer?.note).toBe(canary);
      expect(parsedAnswer?.pwd).toBe(workDir);
    },
    55_000,
  );
});
