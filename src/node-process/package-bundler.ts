import type { SystemBridge } from "../system-bridge/index.js";

// Path utilities (since we can't use node:path in a way that works in isolate)
function dirname(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  if (lastSlash === -1) return ".";
  if (lastSlash === 0) return "/";
  return p.slice(0, lastSlash);
}

function join(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.startsWith("/")) {
      segments.length = 0;
    }
    for (const seg of part.split("/")) {
      if (seg === "..") {
        segments.pop();
      } else if (seg && seg !== ".") {
        segments.push(seg);
      }
    }
  }
  return "/" + segments.join("/");
}

/**
 * Resolve a module request to an absolute path in the virtual filesystem
 */
export async function resolveModule(
  request: string,
  fromDir: string,
  bridge: SystemBridge
): Promise<string | null> {
  // Absolute paths - resolve directly
  if (request.startsWith("/")) {
    return resolveAbsolute(request, bridge);
  }

  // Relative imports
  if (request.startsWith("./") || request.startsWith("../")) {
    return resolveRelative(request, fromDir, bridge);
  }

  // Bare imports - walk up node_modules
  return resolveNodeModules(request, fromDir, bridge);
}

/**
 * Resolve an absolute path
 */
async function resolveAbsolute(
  request: string,
  bridge: SystemBridge
): Promise<string | null> {
  // First check if the exact path exists and is a file
  try {
    const stat = await bridge.stat(request);
    if (!stat.isDirectory) {
      return request;
    }
    // It's a directory - look for main entry
    const pkgJsonPath = join(request, "package.json");
    if (await bridge.exists(pkgJsonPath)) {
      const pkgJson = JSON.parse(await bridge.readFile(pkgJsonPath));
      const main = pkgJson.main || "index.js";
      const mainPath = join(request, main);
      if (await bridge.exists(mainPath)) {
        return mainPath;
      }
    }
    // Check for index.js
    const indexPath = join(request, "index.js");
    if (await bridge.exists(indexPath)) {
      return indexPath;
    }
    const indexJsonPath = join(request, "index.json");
    if (await bridge.exists(indexJsonPath)) {
      return indexJsonPath;
    }
  } catch {
    // Path doesn't exist - try with extensions
  }

  // Try with extensions
  const extensions = [".js", ".json"];
  for (const ext of extensions) {
    const withExt = request + ext;
    if (await bridge.exists(withExt)) {
      return withExt;
    }
  }

  return null;
}

/**
 * Resolve a relative import
 */
async function resolveRelative(
  request: string,
  fromDir: string,
  bridge: SystemBridge
): Promise<string | null> {
  const basePath = join(fromDir, request);

  // First check if the exact path exists and is a file
  try {
    const stat = await bridge.stat(basePath);
    if (!stat.isDirectory) {
      return basePath;
    }
    // It's a directory - look for main entry
    const pkgJsonPath = join(basePath, "package.json");
    if (await bridge.exists(pkgJsonPath)) {
      const pkgJson = JSON.parse(await bridge.readFile(pkgJsonPath));
      const main = pkgJson.main || "index.js";
      const mainPath = join(basePath, main);
      if (await bridge.exists(mainPath)) {
        return mainPath;
      }
    }
    // Check for index.js
    const indexPath = join(basePath, "index.js");
    if (await bridge.exists(indexPath)) {
      return indexPath;
    }
    const indexJsonPath = join(basePath, "index.json");
    if (await bridge.exists(indexJsonPath)) {
      return indexJsonPath;
    }
  } catch {
    // Path doesn't exist - try with extensions
  }

  // Try with extensions
  const extensions = [".js", ".json"];
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (await bridge.exists(withExt)) {
      return withExt;
    }
  }

  return null;
}

/**
 * Resolve a bare module import by walking up node_modules
 */
async function resolveNodeModules(
  request: string,
  fromDir: string,
  bridge: SystemBridge
): Promise<string | null> {
  // Handle scoped packages: @scope/package
  let packageName: string;
  let subpath: string;

  if (request.startsWith("@")) {
    // Scoped package: @scope/package or @scope/package/subpath
    const parts = request.split("/");
    if (parts.length >= 2) {
      packageName = parts[0] + "/" + parts[1];
      subpath = parts.slice(2).join("/");
    } else {
      return null;
    }
  } else {
    // Regular package: package or package/subpath
    const slashIndex = request.indexOf("/");
    if (slashIndex === -1) {
      packageName = request;
      subpath = "";
    } else {
      packageName = request.slice(0, slashIndex);
      subpath = request.slice(slashIndex + 1);
    }
  }

  let dir = fromDir;
  while (dir !== "/" && dir !== "") {
    const packageDir = join(dir, "node_modules", packageName);
    const pkgJsonPath = join(packageDir, "package.json");

    if (await bridge.exists(pkgJsonPath)) {
      if (subpath) {
        // Direct file reference: require("lodash/get")
        return resolveRelative("./" + subpath, packageDir, bridge);
      }

      // Main entry point
      const pkgJson = JSON.parse(await bridge.readFile(pkgJsonPath));
      const main = pkgJson.main || "index.js";
      const mainPath = main.startsWith("./")
        ? join(packageDir, main.slice(2))
        : join(packageDir, main);

      // Try the main path with extensions
      const mainCandidates = [
        mainPath,
        mainPath + ".js",
        mainPath + "/index.js",
      ];

      for (const candidate of mainCandidates) {
        if (await bridge.exists(candidate)) {
          return candidate;
        }
      }
    }

    dir = dirname(dir);
  }

  // Also check root node_modules
  const rootPackageDir = join("/node_modules", packageName);
  const rootPkgJsonPath = join(rootPackageDir, "package.json");

  if (await bridge.exists(rootPkgJsonPath)) {
    if (subpath) {
      return resolveRelative("./" + subpath, rootPackageDir, bridge);
    }

    const pkgJson = JSON.parse(await bridge.readFile(rootPkgJsonPath));
    const main = pkgJson.main || "index.js";
    const mainPath = main.startsWith("./")
      ? join(rootPackageDir, main.slice(2))
      : join(rootPackageDir, main);

    const mainCandidates = [mainPath, mainPath + ".js", mainPath + "/index.js"];

    for (const candidate of mainCandidates) {
      if (await bridge.exists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Load a file's content from the virtual filesystem
 */
export async function loadFile(
  path: string,
  bridge: SystemBridge
): Promise<string | null> {
  try {
    return await bridge.readFile(path);
  } catch {
    return null;
  }
}

/**
 * Legacy function - bundle a package from node_modules (simple approach)
 * This is kept for backwards compatibility but the new dynamic resolution is preferred
 */
export async function bundlePackage(
  packageName: string,
  bridge: SystemBridge
): Promise<string | null> {
  // Resolve the package entry point
  const entryPath = await resolveNodeModules(packageName, "/", bridge);
  if (!entryPath) {
    return null;
  }

  try {
    const entryCode = await bridge.readFile(entryPath);

    // Wrap the code in an IIFE that sets up module.exports
    const wrappedCode = `(function() {
      var module = { exports: {} };
      var exports = module.exports;
      ${entryCode}
      return module.exports;
    })()`;

    return wrappedCode;
  } catch {
    return null;
  }
}
