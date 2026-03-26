import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { allowAllFs, allowAllNetwork, createKernel } from '../../../core/src/index.ts';
import { InMemoryFileSystem } from '../../../browser/src/os-filesystem.ts';
import {
	HostNodeFileSystem,
	createNodeHostNetworkAdapter,
	createNodeRuntime,
} from '../../../nodejs/src/index.ts';

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 30_000;
const FIXTURE_TIMEOUT_MS = 55_000;
const textDecoder = new TextDecoder();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.resolve(__dirname, '..', 'projects');

const clientScript = (port: number) => `
	const http = require('node:http');

	const req = http.request({
		hostname: '127.0.0.1',
		port: ${port},
		path: '/wire',
		method: 'POST',
		headers: {
			'content-type': 'text/plain',
			'content-length': '5',
			'x-test': 'kernel-wire',
			'connection': 'close',
		},
	}, (res) => {
		let body = '';
		res.setEncoding('utf8');
		res.on('data', (chunk) => body += chunk);
		res.on('end', () => {
			console.log('STATUS:' + res.statusCode);
			console.log('BODY:' + body);
		});
	});

	req.on('error', (err) => {
		console.error(err.stack || err.message);
		process.exit(1);
	});

	req.end('hello');
`;

const serverScript = `
	const http = require('node:http');

	const server = http.createServer((req, res) => {
		res.sendDate = false;
		res.statusCode = 201;
		res.setHeader('content-type', 'text/plain');
		res.setHeader('x-bridge', 'kernel');
		res.end('hello');
		server.close();
	});

	server.listen(0, '127.0.0.1', () => {
		console.log('PORT:' + server.address().port);
	});
`;

function isCompleteHttpMessage(buffer: Buffer): boolean {
	const headerEnd = buffer.indexOf('\r\n\r\n');
	if (headerEnd === -1) return false;

	const headers = buffer.subarray(0, headerEnd).toString('latin1');
	const contentLengthMatch = headers.match(/(?:^|\r\n)content-length:\s*(\d+)/i);
	const contentLength = contentLengthMatch ? Number.parseInt(contentLengthMatch[1] ?? '0', 10) : 0;
	return buffer.length >= headerEnd + 4 + contentLength;
}

async function captureRawRequests(
	runClient: (port: number) => Promise<void>,
): Promise<string[]> {
	const requests: string[] = [];

	const server = net.createServer((socket) => {
		let buffered = Buffer.alloc(0);

		socket.on('data', (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (!isCompleteHttpMessage(buffered)) return;

			requests.push(buffered.toString('latin1'));
			socket.write(
				[
					'HTTP/1.1 201 Created',
					'Content-Length: 2',
					'Connection: close',
					'',
					'ok',
				].join('\r\n'),
			);
			socket.end();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('expected inet listener address');
	}

	try {
		await runClient(address.port);
		return requests;
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}
}

async function runHostClient(port: number): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const result = await execFileAsync(process.execPath, ['-e', clientScript(port)], {
			timeout: TEST_TIMEOUT_MS,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error: unknown) {
		if (error && typeof error === 'object' && 'stdout' in error) {
			const execError = error as { code?: number; stdout?: string; stderr?: string };
			return {
				code: typeof execError.code === 'number' ? execError.code : 1,
				stdout: typeof execError.stdout === 'string' ? execError.stdout : '',
				stderr: typeof execError.stderr === 'string' ? execError.stderr : '',
			};
		}
		throw error;
	}
}

async function runKernelClient(port: number): Promise<{ code: number; stdout: string; stderr: string }> {
	const { kernel, dispose } = await createNetworkedKernel();
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];

	try {
		const proc = kernel.spawn('node', ['-e', clientScript(port)], {
			onStdout: (chunk) => stdoutChunks.push(chunk),
			onStderr: (chunk) => stderrChunks.push(chunk),
		});
		const code = await proc.wait();
		return {
			code,
			stdout: stdoutChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
			stderr: stderrChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
		};
	} finally {
		await dispose();
	}
}

async function captureHostServerResponse(): Promise<string> {
	const server = http.createServer((_req, res) => {
		res.sendDate = false;
		res.statusCode = 201;
		res.setHeader('content-type', 'text/plain');
		res.setHeader('x-bridge', 'kernel');
		res.end('hello');
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('expected inet listener address');
	}

	try {
		return await sendRawRequest(address.port);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}
}

async function captureKernelServerResponse(): Promise<{ code: number; stdout: string; stderr: string; response: string }> {
	const { kernel, dispose } = await createNetworkedKernel();
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];

	try {
		let resolvePort: ((port: number) => void) | undefined;
		const portPromise = new Promise<number>((resolve) => {
			resolvePort = resolve;
		});

		const proc = kernel.spawn('node', ['-e', serverScript], {
			onStdout: (chunk) => {
				stdoutChunks.push(chunk);
				const stdout = stdoutChunks.map((item) => textDecoder.decode(item)).join('');
				const match = stdout.match(/PORT:(\d+)/);
				if (match) resolvePort?.(Number.parseInt(match[1] ?? '0', 10));
			},
			onStderr: (chunk) => stderrChunks.push(chunk),
		});

		const port = await Promise.race([
			portPromise,
			new Promise<number>((_, reject) =>
				setTimeout(() => reject(new Error('timed out waiting for kernel server port')), 5_000),
			),
		]).catch((error: unknown) => {
			proc.kill(15);
			throw error;
		});

		const response = await sendRawRequest(port);
		const code = await proc.wait();

		return {
			code,
			stdout: stdoutChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
			stderr: stderrChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
			response,
		};
	} finally {
		await dispose();
	}
}

async function createNetworkedKernel(
	filesystem: InMemoryFileSystem | HostNodeFileSystem = new InMemoryFileSystem(),
): Promise<{
	kernel: ReturnType<typeof createKernel>;
	dispose: () => Promise<void>;
}> {
	const kernel = createKernel({
		filesystem,
		hostNetworkAdapter: createNodeHostNetworkAdapter(),
		permissions: { ...allowAllFs, ...allowAllNetwork },
	});

	await kernel.mount(
		createNodeRuntime({ permissions: { ...allowAllFs, ...allowAllNetwork } }),
	);

	return {
		kernel,
		dispose: () => kernel.dispose(),
	};
}

async function sendRawRequest(port: number): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		const chunks: Buffer[] = [];

		socket.once('error', reject);
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
		socket.on('connect', () => {
			socket.write(
				[
					'GET /wire HTTP/1.1',
					'Host: 127.0.0.1',
					'Connection: close',
					'',
					'',
				].join('\r\n'),
			);
		});
	});
}

async function prepareFixtureProject(name: string): Promise<{ entry: string; projectDir: string }> {
	const sourceDir = path.join(FIXTURES_ROOT, name);
	const metadata = JSON.parse(
		await readFile(path.join(sourceDir, 'fixture.json'), 'utf8'),
	) as { entry: string };
	const projectDir = await mkdtemp(path.join(tmpdir(), `secure-exec-${name}-`));

	await cp(sourceDir, projectDir, {
		recursive: true,
		filter: (source) => !source.split(path.sep).includes('node_modules'),
	});

	await execFileAsync('pnpm', ['install', '--ignore-workspace', '--prefer-offline'], {
		cwd: projectDir,
		timeout: 45_000,
		maxBuffer: 10 * 1024 * 1024,
	});

	return { entry: metadata.entry, projectDir };
}

async function runHostProject(
	projectDir: string,
	entryRel: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const result = await execFileAsync(process.execPath, [path.join(projectDir, entryRel)], {
			cwd: projectDir,
			timeout: TEST_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error: unknown) {
		if (error && typeof error === 'object' && 'stdout' in error) {
			const execError = error as { code?: number; stdout?: string; stderr?: string };
			return {
				code: typeof execError.code === 'number' ? execError.code : 1,
				stdout: typeof execError.stdout === 'string' ? execError.stdout : '',
				stderr: typeof execError.stderr === 'string' ? execError.stderr : '',
			};
		}
		throw error;
	}
}

async function runKernelProject(
	projectDir: string,
	entryRel: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const { kernel, dispose } = await createNetworkedKernel(
		new HostNodeFileSystem({ root: projectDir }),
	);
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];

	try {
		const proc = kernel.spawn('node', [`/${entryRel.replace(/\\/g, '/')}`], {
			cwd: '/',
			onStdout: (chunk) => stdoutChunks.push(chunk),
			onStderr: (chunk) => stderrChunks.push(chunk),
		});
		const code = await proc.wait();
		return {
			code,
			stdout: stdoutChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
			stderr: stderrChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
		};
	} finally {
		await dispose();
	}
}

function normalizeRawHttp(value: string): string {
	return value.replace(/^Date: .*\r\n/gim, '');
}

describe('kernel network cross-validation', () => {
	it(
		'proves the real host-server control path distinguishes host Node from the kernel external-client gap',
		async () => {
			const hostRequests = await captureRawRequests(async (port) => {
				const result = await runHostClient(port);
				expect(result.code).toBe(0);
				expect(result.stdout).toContain('STATUS:201');
				expect(result.stdout).toContain('BODY:ok');
			});
			const kernelRequests = await captureRawRequests(async (port) => {
				const result = await runKernelClient(port);
				expect(result.code).toBe(0);
				expect(result.stderr).toContain(
					`ENOSYS: function not implemented, connect 'http://127.0.0.1:${port}/wire'`,
				);
			});

			expect(hostRequests).toHaveLength(1);
			expect(kernelRequests).toHaveLength(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'emits the same raw HTTP response bytes as host Node for a fixed loopback server response',
		async () => {
			const hostResponse = await captureHostServerResponse();
			const kernelResponse = await captureKernelServerResponse();

			expect(kernelResponse.code).toBe(0);
			expect(kernelResponse.stdout).toContain('PORT:');
			expect(kernelResponse.stderr).toBe('');
			expect(normalizeRawHttp(kernelResponse.response)).toBe(
				normalizeRawHttp(hostResponse),
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'captures the current express black-box mismatch between host Node and the network-enabled kernel',
		async () => {
			const fixture = await prepareFixtureProject('express-pass');

			try {
				const host = await runHostProject(fixture.projectDir, fixture.entry);
				const kernel = await runKernelProject(fixture.projectDir, fixture.entry);

				expect(host.code).toBe(0);
				expect(host.stderr).toBe('');
				expect(host.stdout).toContain('GET /hello');
				expect(kernel.code).toBe(1);
				expect(kernel.stdout).toBe('');
				expect(kernel.stderr).toContain('TypeError: pathRegexp is not a function');
			} finally {
				await rm(fixture.projectDir, { recursive: true, force: true });
			}
		},
		FIXTURE_TIMEOUT_MS,
	);
});
