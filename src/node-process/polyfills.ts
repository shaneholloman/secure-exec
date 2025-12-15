import * as esbuild from "esbuild";
import stdLibBrowser from "node-stdlib-browser";

// Cache bundled polyfills
const polyfillCache: Map<string, string> = new Map();

// node-stdlib-browser provides the mapping from Node.js stdlib to polyfill paths
// e.g., { path: "/path/to/path-browserify/index.js", fs: null, ... }
// We use this mapping instead of maintaining our own

/**
 * Bundle a stdlib polyfill module using esbuild
 */
export async function bundlePolyfill(moduleName: string): Promise<string> {
  const cached = polyfillCache.get(moduleName);
  if (cached) return cached;

  // Get the polyfill entry point from node-stdlib-browser
  const entryPoint = stdLibBrowser[moduleName as keyof typeof stdLibBrowser];
  if (!entryPoint) {
    throw new Error(`No polyfill available for module: ${moduleName}`);
  }

  // Bundle using esbuild with the direct path from node-stdlib-browser
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__polyfill__",
    platform: "browser",
    target: "es2020",
    minify: false,
    define: {
      "process.env.NODE_ENV": '"production"',
      global: "globalThis",
    },
  });

  const code = result.outputFiles[0].text;
  // Extract the module from the IIFE wrapper
  const wrappedCode = `(function() {
    ${code}
    return __polyfill__;
  })()`;

  polyfillCache.set(moduleName, wrappedCode);
  return wrappedCode;
}

/**
 * Get all available stdlib modules (those with non-null polyfills)
 */
export function getAvailableStdlib(): string[] {
  return Object.keys(stdLibBrowser).filter(
    (key) => stdLibBrowser[key as keyof typeof stdLibBrowser] !== null
  );
}

/**
 * Check if a module has a polyfill available
 * Note: fs returns null from node-stdlib-browser since we provide our own implementation
 */
export function hasPolyfill(moduleName: string): boolean {
  // Strip node: prefix
  const name = moduleName.replace(/^node:/, "");
  const polyfill = stdLibBrowser[name as keyof typeof stdLibBrowser];
  return polyfill !== undefined && polyfill !== null;
}

/**
 * Pre-bundle all polyfills (for faster startup)
 */
export async function prebundleAllPolyfills(): Promise<Map<string, string>> {
  const modules = getAvailableStdlib();
  await Promise.all(modules.map((m) => bundlePolyfill(m)));
  return new Map(polyfillCache);
}
