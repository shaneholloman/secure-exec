import { builtinModules, createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import { createEaccesError } from "../shared/errors.js";
import type { VirtualDirEntry, VirtualFileSystem, VirtualStat } from "../types.js";

export interface ModuleAccessOptions {
	cwd?: string;
	allowPackages: string[];
}

interface DiscoveredPackage {
	name: string;
	hostRoot: string;
	packageJsonPath: string;
	virtualRoot: string;
	manifest: PackageManifest;
}

interface PackageManifest {
	name?: unknown;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

interface ModuleProjection {
	readonly packageRoots: Map<string, string>;
	readonly syntheticDirChildren: Map<string, Map<string, boolean>>;
	readonly syntheticDirs: Set<string>;
}

interface QueueItem {
	packageName: string;
	fromFile: string;
	fromVirtualDir: string;
	optional: boolean;
}

const MODULE_ACCESS_INVALID_CONFIG = "ERR_MODULE_ACCESS_INVALID_CONFIG";
const MODULE_ACCESS_INVALID_PACKAGE = "ERR_MODULE_ACCESS_INVALID_PACKAGE";
const MODULE_ACCESS_RESOLVE_FAILED = "ERR_MODULE_ACCESS_RESOLVE_FAILED";
const MODULE_ACCESS_OUT_OF_SCOPE = "ERR_MODULE_ACCESS_OUT_OF_SCOPE";
const MODULE_ACCESS_NATIVE_ADDON = "ERR_MODULE_ACCESS_NATIVE_ADDON";

const SANDBOX_APP_ROOT = "/app";
const SANDBOX_NODE_MODULES_ROOT = `${SANDBOX_APP_ROOT}/node_modules`;

const BUILTIN_MODULES = new Set(
	builtinModules.map((name) => name.replace(/^node:/, "")),
);

const VIRTUAL_DIR_MODE = 0o040755;
const VIRTUAL_FILE_MODE = 0o100644;

function toVirtualPath(value: string): string {
	if (!value || value === ".") return "/";
	const normalized = path.posix.normalize(value.startsWith("/") ? value : `/${value}`);
	if (normalized.length > 1 && normalized.endsWith("/")) {
		return normalized.slice(0, -1);
	}
	return normalized;
}

function isWithinPath(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function createEnoentError(syscall: string, targetPath: string): Error {
	const error = new Error(
		`ENOENT: no such file or directory, ${syscall} '${targetPath}'`,
	) as NodeJS.ErrnoException;
	error.code = "ENOENT";
	error.path = targetPath;
	error.syscall = syscall;
	return error;
}

function createModuleAccessError(code: string, message: string): Error {
	const error = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function validateAllowPackageName(name: string): void {
	if (typeof name !== "string" || name.length === 0) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_PACKAGE,
			"moduleAccess.allowPackages entries must be non-empty strings",
		);
	}
	if (name.startsWith("node:")) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_PACKAGE,
			`moduleAccess package '${name}' must not use node: prefix`,
		);
	}
	if (
		name.startsWith(".") ||
		name.startsWith("/") ||
		name.includes("\\") ||
		name.includes(" ")
	) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_PACKAGE,
			`moduleAccess package '${name}' must be a bare package specifier`,
		);
	}
	if (BUILTIN_MODULES.has(name)) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_PACKAGE,
			`moduleAccess package '${name}' is a Node builtin and is not supported`,
		);
	}
	const scopedPattern = /^@[^/]+\/[^/]+$/;
	const regularPattern = /^[^@/][^/]*$/;
	if (!scopedPattern.test(name) && !regularPattern.test(name)) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_PACKAGE,
			`moduleAccess package '${name}' is not a supported package name`,
		);
	}
}

function readPackageManifest(packageJsonPath: string): PackageManifest {
	try {
		const raw = fsSync.readFileSync(packageJsonPath, "utf8");
		return JSON.parse(raw) as PackageManifest;
	} catch {
		throw createModuleAccessError(
			MODULE_ACCESS_RESOLVE_FAILED,
			`failed to read package manifest: ${packageJsonPath}`,
		);
	}
}

function findPackageRoot(
	resolvedPath: string,
	packageName: string,
	nodeModulesRoot: string,
): { hostRoot: string; packageJsonPath: string; manifest: PackageManifest } {
	let currentDir = path.dirname(resolvedPath);
	while (isWithinPath(currentDir, nodeModulesRoot)) {
		const packageJsonPath = path.join(currentDir, "package.json");
		if (fsSync.existsSync(packageJsonPath)) {
			const manifest = readPackageManifest(packageJsonPath);
			if (manifest.name === packageName) {
				return {
					hostRoot: currentDir,
					packageJsonPath,
					manifest,
				};
			}
		}
		if (currentDir === nodeModulesRoot) {
			break;
		}
		currentDir = path.dirname(currentDir);
	}

	throw createModuleAccessError(
		MODULE_ACCESS_RESOLVE_FAILED,
		`failed to find package root for '${packageName}' from '${resolvedPath}'`,
	);
}

function assertNoNativeAddons(hostRoot: string): void {
	const stack = [hostRoot];
	const visitedDirs = new Set<string>();

	while (stack.length > 0) {
		const dirPath = stack.pop()!;
		if (visitedDirs.has(dirPath)) {
			continue;
		}
		visitedDirs.add(dirPath);

		const entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			const absolutePath = path.join(dirPath, entry.name);
			if (entry.name.endsWith(".node")) {
				throw createModuleAccessError(
					MODULE_ACCESS_NATIVE_ADDON,
					`native addon '${absolutePath}' is not supported for moduleAccess projection`,
				);
			}
			if (entry.isDirectory()) {
				stack.push(absolutePath);
			}
		}
	}
}

function discoverPackage(
	item: QueueItem,
	nodeModulesRoot: string,
): DiscoveredPackage | null {
	const localRequire = createRequire(item.fromFile);
	let resolvedPath: string;

	try {
		resolvedPath = localRequire.resolve(item.packageName);
	} catch {
		if (item.optional) {
			return null;
		}
		throw createModuleAccessError(
			MODULE_ACCESS_RESOLVE_FAILED,
			`failed to resolve package '${item.packageName}' from '${item.fromFile}'`,
		);
	}

	if (!path.isAbsolute(resolvedPath)) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_PACKAGE,
			`resolved package '${item.packageName}' to unsupported target '${resolvedPath}'`,
		);
	}

	let resolvedRealPath: string;
	try {
		resolvedRealPath = fsSync.realpathSync(resolvedPath);
	} catch {
		if (item.optional) {
			return null;
		}
		throw createModuleAccessError(
			MODULE_ACCESS_RESOLVE_FAILED,
			`failed to resolve canonical path for '${resolvedPath}'`,
		);
	}

	if (!isWithinPath(resolvedRealPath, nodeModulesRoot)) {
		throw createModuleAccessError(
			MODULE_ACCESS_OUT_OF_SCOPE,
			`resolved path '${resolvedRealPath}' escapes '${nodeModulesRoot}'`,
		);
	}

	const packageRoot = findPackageRoot(
		resolvedRealPath,
		item.packageName,
		nodeModulesRoot,
	);

	const virtualRoot = toVirtualPath(
		path.posix.join(item.fromVirtualDir, "node_modules", item.packageName),
	);

	return {
		name: item.packageName,
		hostRoot: packageRoot.hostRoot,
		packageJsonPath: packageRoot.packageJsonPath,
		virtualRoot,
		manifest: packageRoot.manifest,
	};
}

function createProjection(options: ModuleAccessOptions): ModuleProjection {
	const cwdInput = options.cwd ?? process.cwd();
	if (options.cwd !== undefined && !path.isAbsolute(options.cwd)) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_CONFIG,
			`moduleAccess.cwd must be an absolute path, got '${options.cwd}'`,
		);
	}
	if (!Array.isArray(options.allowPackages) || options.allowPackages.length === 0) {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_CONFIG,
			"moduleAccess.allowPackages must include at least one package",
		);
	}

	for (const packageName of options.allowPackages) {
		validateAllowPackageName(packageName);
	}

	const cwd = path.resolve(cwdInput);
	const nodeModulesPath = path.join(cwd, "node_modules");
	let nodeModulesRoot: string;
	try {
		nodeModulesRoot = fsSync.realpathSync(nodeModulesPath);
	} catch {
		throw createModuleAccessError(
			MODULE_ACCESS_INVALID_CONFIG,
			`moduleAccess.cwd is missing node_modules: ${nodeModulesPath}`,
		);
	}

	const queue: QueueItem[] = options.allowPackages.map((packageName) => ({
		packageName,
		fromFile: path.join(cwd, "package.json"),
		fromVirtualDir: SANDBOX_APP_ROOT,
		optional: false,
	}));
	const packageRoots = new Map<string, string>();
	const visitedVirtualRoots = new Set<string>();
	const scannedHostRoots = new Set<string>();

	while (queue.length > 0) {
		const item = queue.shift()!;
		const discovered = discoverPackage(item, nodeModulesRoot);
		if (!discovered) {
			continue;
		}

		if (!packageRoots.has(discovered.virtualRoot)) {
			packageRoots.set(discovered.virtualRoot, discovered.hostRoot);
		}

		if (!scannedHostRoots.has(discovered.hostRoot)) {
			assertNoNativeAddons(discovered.hostRoot);
			scannedHostRoots.add(discovered.hostRoot);
		}

		if (visitedVirtualRoots.has(discovered.virtualRoot)) {
			continue;
		}
		visitedVirtualRoots.add(discovered.virtualRoot);

		const dependencies = Object.keys(discovered.manifest.dependencies ?? {});
		const optionalDependencies = Object.keys(
			discovered.manifest.optionalDependencies ?? {},
		);
		const peerDependencies = Object.keys(discovered.manifest.peerDependencies ?? {});

		for (const depName of dependencies) {
			validateAllowPackageName(depName);
			queue.push({
				packageName: depName,
				fromFile: discovered.packageJsonPath,
				fromVirtualDir: discovered.virtualRoot,
				optional: false,
			});
		}
		for (const depName of optionalDependencies) {
			validateAllowPackageName(depName);
			queue.push({
				packageName: depName,
				fromFile: discovered.packageJsonPath,
				fromVirtualDir: discovered.virtualRoot,
				optional: true,
			});
		}
		for (const depName of peerDependencies) {
			validateAllowPackageName(depName);
			queue.push({
				packageName: depName,
				fromFile: discovered.packageJsonPath,
				fromVirtualDir: discovered.virtualRoot,
				optional: true,
			});
		}
	}

	const syntheticDirChildren = new Map<string, Map<string, boolean>>();
	const syntheticDirs = new Set<string>(["/", SANDBOX_APP_ROOT, SANDBOX_NODE_MODULES_ROOT]);

	for (const virtualRoot of packageRoots.keys()) {
		const segments = virtualRoot.split("/").filter(Boolean);
		let current = "/";
		for (const segment of segments) {
			const next = current === "/" ? `/${segment}` : `${current}/${segment}`;
			syntheticDirs.add(next);
			const children = syntheticDirChildren.get(current) ?? new Map<string, boolean>();
			children.set(segment, true);
			syntheticDirChildren.set(current, children);
			current = next;
		}
	}

	if (!syntheticDirChildren.has("/")) {
		syntheticDirChildren.set("/", new Map<string, boolean>());
	}
	syntheticDirChildren.get("/")!.set("app", true);
	if (!syntheticDirChildren.has(SANDBOX_APP_ROOT)) {
		syntheticDirChildren.set(SANDBOX_APP_ROOT, new Map<string, boolean>());
	}
	syntheticDirChildren.get(SANDBOX_APP_ROOT)!.set("node_modules", true);

	return {
		packageRoots,
		syntheticDirChildren,
		syntheticDirs,
	};
}

function createVirtualDirStat(): VirtualStat {
	const now = Date.now();
	return {
		mode: VIRTUAL_DIR_MODE,
		size: 4096,
		isDirectory: true,
		atimeMs: now,
		mtimeMs: now,
		ctimeMs: now,
		birthtimeMs: now,
	};
}

function normalizeProjectedPath(pathValue: string): string {
	return toVirtualPath(pathValue);
}

function startsWithPath(value: string, prefix: string): boolean {
	return value === prefix || value.startsWith(`${prefix}/`);
}

export class ModuleAccessFileSystem implements VirtualFileSystem {
	private readonly projection: ModuleProjection;
	private readonly baseFileSystem?: VirtualFileSystem;

	constructor(baseFileSystem: VirtualFileSystem | undefined, options: ModuleAccessOptions) {
		this.baseFileSystem = baseFileSystem;
		this.projection = createProjection(options);
	}

	private getProjectionMapping(virtualPath: string): {
		virtualRoot: string;
		hostRoot: string;
		hostPath: string;
	} | null {
		let selectedVirtualRoot: string | null = null;
		let selectedHostRoot: string | null = null;

		for (const [virtualRoot, hostRoot] of this.projection.packageRoots.entries()) {
			if (!startsWithPath(virtualPath, virtualRoot)) {
				continue;
			}
			if (
				selectedVirtualRoot === null ||
				virtualRoot.length > selectedVirtualRoot.length
			) {
				selectedVirtualRoot = virtualRoot;
				selectedHostRoot = hostRoot;
			}
		}

		if (!selectedVirtualRoot || !selectedHostRoot) {
			return null;
		}

		const relative = virtualPath.slice(selectedVirtualRoot.length).replace(/^\//, "");
		const hostPath = relative
			? path.join(selectedHostRoot, ...relative.split("/"))
			: selectedHostRoot;
		return {
			virtualRoot: selectedVirtualRoot,
			hostRoot: selectedHostRoot,
			hostPath,
		};
	}

	private async resolveHostPath(
		virtualPath: string,
		syscall: string,
	): Promise<string | null> {
		const mapping = this.getProjectionMapping(virtualPath);
		if (!mapping) {
			return null;
		}

		try {
			const canonical = await fs.realpath(mapping.hostPath);
			if (!isWithinPath(canonical, mapping.hostRoot)) {
				throw createEaccesError(syscall, virtualPath);
			}
			return canonical;
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err?.code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}

	private isReadOnlyProjectionPath(virtualPath: string): boolean {
		return startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT);
	}

	private async readSyntheticMergedDir(
		virtualPath: string,
	): Promise<Map<string, boolean>> {
		const entries = new Map<string, boolean>();

		const syntheticEntries = this.projection.syntheticDirChildren.get(virtualPath);
		if (syntheticEntries) {
			for (const [name, isDirectory] of syntheticEntries.entries()) {
				entries.set(name, isDirectory);
			}
		}

		const hostPath = await this.resolveHostPath(virtualPath, "scandir");
		if (hostPath) {
			const hostEntries = await fs.readdir(hostPath, { withFileTypes: true });
			for (const entry of hostEntries) {
				entries.set(entry.name, entry.isDirectory());
			}
		}

		if (
			this.baseFileSystem &&
			!startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT)
		) {
			try {
				const baseEntries = await this.baseFileSystem.readDirWithTypes(virtualPath);
				for (const entry of baseEntries) {
					if (!entries.has(entry.name)) {
						entries.set(entry.name, entry.isDirectory);
					}
				}
			} catch {
				// Ignore base fs misses for synthetic paths.
			}
		}

		if (entries.size === 0) {
			throw createEnoentError("scandir", virtualPath);
		}

		return entries;
	}

	private async fallbackReadFile(pathValue: string): Promise<Uint8Array> {
		if (!this.baseFileSystem) {
			throw createEnoentError("open", pathValue);
		}
		return this.baseFileSystem.readFile(pathValue);
	}

	private async fallbackReadTextFile(pathValue: string): Promise<string> {
		if (!this.baseFileSystem) {
			throw createEnoentError("open", pathValue);
		}
		return this.baseFileSystem.readTextFile(pathValue);
	}

	private async fallbackReadDir(pathValue: string): Promise<string[]> {
		if (!this.baseFileSystem) {
			throw createEnoentError("scandir", pathValue);
		}
		return this.baseFileSystem.readDir(pathValue);
	}

	private async fallbackReadDirWithTypes(pathValue: string): Promise<VirtualDirEntry[]> {
		if (!this.baseFileSystem) {
			throw createEnoentError("scandir", pathValue);
		}
		return this.baseFileSystem.readDirWithTypes(pathValue);
	}

	private async fallbackWriteFile(
		pathValue: string,
		content: string | Uint8Array,
	): Promise<void> {
		if (!this.baseFileSystem) {
			throw createEnoentError("write", pathValue);
		}
		return this.baseFileSystem.writeFile(pathValue, content);
	}

	private async fallbackCreateDir(pathValue: string): Promise<void> {
		if (!this.baseFileSystem) {
			throw createEnoentError("mkdir", pathValue);
		}
		return this.baseFileSystem.createDir(pathValue);
	}

	private async fallbackMkdir(pathValue: string): Promise<void> {
		if (!this.baseFileSystem) {
			throw createEnoentError("mkdir", pathValue);
		}
		return this.baseFileSystem.mkdir(pathValue);
	}

	private async fallbackExists(pathValue: string): Promise<boolean> {
		if (!this.baseFileSystem) {
			return false;
		}
		return this.baseFileSystem.exists(pathValue);
	}

	private async fallbackStat(pathValue: string): Promise<VirtualStat> {
		if (!this.baseFileSystem) {
			throw createEnoentError("stat", pathValue);
		}
		return this.baseFileSystem.stat(pathValue);
	}

	private async fallbackRemoveFile(pathValue: string): Promise<void> {
		if (!this.baseFileSystem) {
			throw createEnoentError("unlink", pathValue);
		}
		return this.baseFileSystem.removeFile(pathValue);
	}

	private async fallbackRemoveDir(pathValue: string): Promise<void> {
		if (!this.baseFileSystem) {
			throw createEnoentError("rmdir", pathValue);
		}
		return this.baseFileSystem.removeDir(pathValue);
	}

	private async fallbackRename(oldPath: string, newPath: string): Promise<void> {
		if (!this.baseFileSystem) {
			throw createEnoentError("rename", `${oldPath} -> ${newPath}`);
		}
		return this.baseFileSystem.rename(oldPath, newPath);
	}

	async readFile(pathValue: string): Promise<Uint8Array> {
		const virtualPath = normalizeProjectedPath(pathValue);
		const hostPath = await this.resolveHostPath(virtualPath, "open");
		if (hostPath) {
			return fs.readFile(hostPath);
		}
		if (startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT)) {
			throw createEnoentError("open", virtualPath);
		}
		return this.fallbackReadFile(virtualPath);
	}

	async readTextFile(pathValue: string): Promise<string> {
		const virtualPath = normalizeProjectedPath(pathValue);
		const hostPath = await this.resolveHostPath(virtualPath, "open");
		if (hostPath) {
			return fs.readFile(hostPath, "utf8");
		}
		if (startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT)) {
			throw createEnoentError("open", virtualPath);
		}
		return this.fallbackReadTextFile(virtualPath);
	}

	async readDir(pathValue: string): Promise<string[]> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.projection.syntheticDirs.has(virtualPath)) {
			const entries = await this.readSyntheticMergedDir(virtualPath);
			return Array.from(entries.keys()).sort((left, right) =>
				left.localeCompare(right),
			);
		}

		const hostPath = await this.resolveHostPath(virtualPath, "scandir");
		if (hostPath) {
			return fs.readdir(hostPath);
		}
		if (startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT)) {
			throw createEnoentError("scandir", virtualPath);
		}
		return this.fallbackReadDir(virtualPath);
	}

	async readDirWithTypes(pathValue: string): Promise<VirtualDirEntry[]> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.projection.syntheticDirs.has(virtualPath)) {
			const entries = await this.readSyntheticMergedDir(virtualPath);
			return Array.from(entries.entries())
				.map(([name, isDirectory]) => ({ name, isDirectory }))
				.sort((left, right) => left.name.localeCompare(right.name));
		}

		const hostPath = await this.resolveHostPath(virtualPath, "scandir");
		if (hostPath) {
			const entries = await fs.readdir(hostPath, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				isDirectory: entry.isDirectory(),
			}));
		}
		if (startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT)) {
			throw createEnoentError("scandir", virtualPath);
		}
		return this.fallbackReadDirWithTypes(virtualPath);
	}

	async writeFile(pathValue: string, content: string | Uint8Array): Promise<void> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.isReadOnlyProjectionPath(virtualPath)) {
			throw createEaccesError("write", virtualPath);
		}
		return this.fallbackWriteFile(virtualPath, content);
	}

	async createDir(pathValue: string): Promise<void> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.isReadOnlyProjectionPath(virtualPath)) {
			throw createEaccesError("mkdir", virtualPath);
		}
		return this.fallbackCreateDir(virtualPath);
	}

	async mkdir(pathValue: string): Promise<void> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.isReadOnlyProjectionPath(virtualPath)) {
			throw createEaccesError("mkdir", virtualPath);
		}
		return this.fallbackMkdir(virtualPath);
	}

	async exists(pathValue: string): Promise<boolean> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.projection.syntheticDirs.has(virtualPath)) {
			return true;
		}

		const hostPath = await this.resolveHostPath(virtualPath, "access");
		if (hostPath) {
			return true;
		}
		if (startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT)) {
			return false;
		}
		return this.fallbackExists(virtualPath);
	}

	async stat(pathValue: string): Promise<VirtualStat> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.projection.syntheticDirs.has(virtualPath)) {
			const hostPath = await this.resolveHostPath(virtualPath, "stat");
			if (!hostPath) {
				return createVirtualDirStat();
			}
		}

		const hostPath = await this.resolveHostPath(virtualPath, "stat");
		if (hostPath) {
			const info = await fs.stat(hostPath);
			return {
				mode: info.mode,
				size: info.size,
				isDirectory: info.isDirectory(),
				atimeMs: info.atimeMs,
				mtimeMs: info.mtimeMs,
				ctimeMs: info.ctimeMs,
				birthtimeMs: info.birthtimeMs,
			};
		}
		if (startsWithPath(virtualPath, SANDBOX_NODE_MODULES_ROOT)) {
			throw createEnoentError("stat", virtualPath);
		}
		return this.fallbackStat(virtualPath);
	}

	async removeFile(pathValue: string): Promise<void> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.isReadOnlyProjectionPath(virtualPath)) {
			throw createEaccesError("unlink", virtualPath);
		}
		return this.fallbackRemoveFile(virtualPath);
	}

	async removeDir(pathValue: string): Promise<void> {
		const virtualPath = normalizeProjectedPath(pathValue);
		if (this.isReadOnlyProjectionPath(virtualPath)) {
			throw createEaccesError("rmdir", virtualPath);
		}
		return this.fallbackRemoveDir(virtualPath);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const oldVirtualPath = normalizeProjectedPath(oldPath);
		const newVirtualPath = normalizeProjectedPath(newPath);
		if (
			this.isReadOnlyProjectionPath(oldVirtualPath) ||
			this.isReadOnlyProjectionPath(newVirtualPath)
		) {
			throw createEaccesError("rename", `${oldVirtualPath} -> ${newVirtualPath}`);
		}
		return this.fallbackRename(oldVirtualPath, newVirtualPath);
	}
}
