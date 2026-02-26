export function getRequireSetupCode(): string {
	return `

      // Path utilities
      function _dirname(p) {
        const lastSlash = p.lastIndexOf('/');
        if (lastSlash === -1) return '.';
        if (lastSlash === 0) return '/';
        return p.slice(0, lastSlash);
      }

      // Patch known polyfill gaps in one place after evaluation.
      function _patchPolyfill(name, result) {
        if ((typeof result !== 'object' && typeof result !== 'function') || result === null) {
          return result;
        }

        if (
          name === 'util' &&
          typeof result.formatWithOptions === 'undefined' &&
          typeof result.format === 'function'
        ) {
          result.formatWithOptions = function formatWithOptions(inspectOptions, ...args) {
            return result.format.apply(null, args);
          };
          return result;
        }

        if (name === 'url') {
          const OriginalURL = result.URL;
          if (typeof OriginalURL !== 'function' || OriginalURL._patched) {
            return result;
          }

          const PatchedURL = function PatchedURL(url, base) {
            if (
              typeof url === 'string' &&
              url.startsWith('file:') &&
              !url.startsWith('file://') &&
              base === undefined
            ) {
              if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
                const cwd = process.cwd();
                if (cwd) {
                  try {
                    return new OriginalURL(url, 'file://' + cwd + '/');
                  } catch (e) {
                    // Fall through to original behavior.
                  }
                }
              }
            }
            return base !== undefined ? new OriginalURL(url, base) : new OriginalURL(url);
          };

          Object.keys(OriginalURL).forEach(function(key) {
            PatchedURL[key] = OriginalURL[key];
          });
          Object.setPrototypeOf(PatchedURL, OriginalURL);
          PatchedURL.prototype = OriginalURL.prototype;
          PatchedURL._patched = true;
          result.URL = PatchedURL;
          return result;
        }

        if (name === 'path') {
          if (result.win32 === null || result.win32 === undefined) {
            result.win32 = result.posix || result;
          }
          if (result.posix === null || result.posix === undefined) {
            result.posix = result;
          }

          const hasAbsoluteSegment = function(args) {
            return args.some(function(arg) {
              return (
                typeof arg === 'string' &&
                arg.length > 0 &&
                arg.charAt(0) === '/'
              );
            });
          };

          const prependCwd = function(args) {
            if (hasAbsoluteSegment(args)) return;
            if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
              const cwd = process.cwd();
              if (cwd && cwd.charAt(0) === '/') {
                args.unshift(cwd);
              }
            }
          };

          const originalResolve = result.resolve;
          if (typeof originalResolve === 'function' && !originalResolve._patchedForCwd) {
            const patchedResolve = function resolve() {
              const args = Array.from(arguments);
              prependCwd(args);
              return originalResolve.apply(this, args);
            };
            patchedResolve._patchedForCwd = true;
            result.resolve = patchedResolve;
          }

          if (
            result.posix &&
            typeof result.posix.resolve === 'function' &&
            !result.posix.resolve._patchedForCwd
          ) {
            const originalPosixResolve = result.posix.resolve;
            const patchedPosixResolve = function resolve() {
              const args = Array.from(arguments);
              prependCwd(args);
              return originalPosixResolve.apply(this, args);
            };
            patchedPosixResolve._patchedForCwd = true;
            result.posix.resolve = patchedPosixResolve;
          }
        }

        return result;
      }

      // Set up support-tier policy for unimplemented core modules
      const _deferredCoreModules = new Set([
        'net',
        'tls',
        'readline',
        'perf_hooks',
        'async_hooks',
        'worker_threads',
      ]);
      const _unsupportedCoreModules = new Set([
        'dgram',
        'cluster',
        'wasi',
        'diagnostics_channel',
        'inspector',
        'repl',
        'trace_events',
        'domain',
      ]);

      // Get deterministic unsupported API errors
      function _unsupportedApiError(moduleName, apiName) {
        return new Error(moduleName + '.' + apiName + ' is not supported in sandbox');
      }

      // Create deferred module stubs that throw on API calls
      function _createDeferredModuleStub(moduleName) {
        const methodCache = {};
        let stub = null;
        stub = new Proxy({}, {
          get(_target, prop) {
            if (prop === '__esModule') return false;
            if (prop === 'default') return stub;
            if (prop === Symbol.toStringTag) return 'Module';
            if (prop === 'then') return undefined;
            if (typeof prop !== 'string') return undefined;
            if (!methodCache[prop]) {
              methodCache[prop] = function deferredApiStub() {
                throw _unsupportedApiError(moduleName, prop);
              };
            }
            return methodCache[prop];
          },
        });
        return stub;
      }

      globalThis.require = function require(moduleName) {
        return _requireFrom(moduleName, _currentModule.dirname);
      };

      function _resolveFrom(moduleName, fromDir) {
        const resolved = _resolveModule.applySyncPromise(undefined, [moduleName, fromDir]);
        if (resolved === null) {
          throw new Error('Cannot find module: ' + moduleName + ' from ' + fromDir);
        }
        return resolved;
      }

      globalThis.require.resolve = function resolve(moduleName) {
        return _resolveFrom(moduleName, _currentModule.dirname);
      };
      globalThis.require.cache = _moduleCache;

      function _requireFrom(moduleName, fromDir) {
        // Strip node: prefix
        const name = moduleName.replace(/^node:/, '');

        // For absolute paths (resolved paths), use as cache key
        // For relative/bare imports, resolve first
        let cacheKey = name;
        let resolved = null;

        // Check if it's a relative import
        const isRelative = name.startsWith('./') || name.startsWith('../');

        // Get cached modules for bare/absolute specifiers up front.
        if (!isRelative && _moduleCache[name]) {
          return _moduleCache[name];
        }

        // Special handling for fs module
        if (name === 'fs') {
          if (_moduleCache['fs']) return _moduleCache['fs'];
          const fsModule = eval(_fsModuleCode);
          _moduleCache['fs'] = fsModule;
          return fsModule;
        }

        // Special handling for fs/promises module
        if (name === 'fs/promises') {
          if (_moduleCache['fs/promises']) return _moduleCache['fs/promises'];
          // Get fs module first, then extract promises
          const fsModule = _requireFrom('fs', fromDir);
          _moduleCache['fs/promises'] = fsModule.promises;
          return fsModule.promises;
        }

        // Special handling for child_process module
        if (name === 'child_process') {
          if (_moduleCache['child_process']) return _moduleCache['child_process'];
          _moduleCache['child_process'] = _childProcessModule;
          return _childProcessModule;
        }

        // Special handling for http module
        if (name === 'http') {
          if (_moduleCache['http']) return _moduleCache['http'];
          _moduleCache['http'] = _httpModule;
          return _httpModule;
        }

        // Special handling for https module
        if (name === 'https') {
          if (_moduleCache['https']) return _moduleCache['https'];
          _moduleCache['https'] = _httpsModule;
          return _httpsModule;
        }

        // Special handling for http2 module
        if (name === 'http2') {
          if (_moduleCache['http2']) return _moduleCache['http2'];
          _moduleCache['http2'] = _http2Module;
          return _http2Module;
        }

        // Special handling for dns module
        if (name === 'dns') {
          if (_moduleCache['dns']) return _moduleCache['dns'];
          _moduleCache['dns'] = _dnsModule;
          return _dnsModule;
        }

        // Special handling for os module
        if (name === 'os') {
          if (_moduleCache['os']) return _moduleCache['os'];
          _moduleCache['os'] = _osModule;
          return _osModule;
        }

        // Special handling for module module
        if (name === 'module') {
          if (_moduleCache['module']) return _moduleCache['module'];
          _moduleCache['module'] = _moduleModule;
          return _moduleModule;
        }

        // Special handling for process module - return our bridge's process object.
        // This prevents node-stdlib-browser's process polyfill from overwriting it.
        if (name === 'process') {
          return globalThis.process;
        }

        // Get deferred module stubs
        if (_deferredCoreModules.has(name)) {
          if (_moduleCache[name]) return _moduleCache[name];
          const deferredStub = _createDeferredModuleStub(name);
          _moduleCache[name] = deferredStub;
          return deferredStub;
        }

        // Wait for unsupported modules to fail fast on require()
        if (_unsupportedCoreModules.has(name)) {
          throw new Error(name + ' is not supported in sandbox');
        }

        // Try to load polyfill first (for built-in modules like path, events, etc.)
        const polyfillCode = _loadPolyfill.applySyncPromise(undefined, [name]);
        if (polyfillCode !== null) {
          if (_moduleCache[name]) return _moduleCache[name];

          const moduleObj = { exports: {} };
          _pendingModules[name] = moduleObj;

          let result = eval(polyfillCode);
          result = _patchPolyfill(name, result);
          if (typeof result === 'object' && result !== null) {
            Object.assign(moduleObj.exports, result);
          } else {
            moduleObj.exports = result;
          }

          _moduleCache[name] = moduleObj.exports;
          delete _pendingModules[name];
          return _moduleCache[name];
        }

        // Resolve module path using host-side resolution
        resolved = _resolveFrom(name, fromDir);

        // Use resolved path as cache key
        cacheKey = resolved;

        // Check cache with resolved path
        if (_moduleCache[cacheKey]) {
          return _moduleCache[cacheKey];
        }

        // Check if we're currently loading this module (circular dep)
        if (_pendingModules[cacheKey]) {
          return _pendingModules[cacheKey].exports;
        }

        // Load file content
        const source = _loadFile.applySyncPromise(undefined, [resolved]);
        if (source === null) {
          throw new Error('Cannot load module: ' + resolved);
        }

        // Handle JSON files
        if (resolved.endsWith('.json')) {
          const parsed = JSON.parse(source);
          _moduleCache[cacheKey] = parsed;
          return parsed;
        }

        // Create module object
        const module = {
          exports: {},
          filename: resolved,
          dirname: _dirname(resolved),
          id: resolved,
          loaded: false,
        };
        _pendingModules[cacheKey] = module;

        // Track current module for nested requires
        const prevModule = _currentModule;
        _currentModule = module;

        try {
          // Wrap and execute the code
          const wrapper = new Function(
            'exports', 'require', 'module', '__filename', '__dirname', '__dynamicImport',
            source
          );

          // Create a require function that resolves from this module's directory
          const moduleRequire = function(request) {
            return _requireFrom(request, module.dirname);
          };
          moduleRequire.resolve = function(request) {
            return _resolveFrom(request, module.dirname);
          };

          // Create a module-local __dynamicImport that resolves from this module's directory.
          const moduleDynamicImport = function(specifier) {
            if (typeof globalThis.__dynamicImport === 'function') {
              return globalThis.__dynamicImport(specifier, module.dirname);
            }
            return Promise.reject(new Error('Dynamic import is not initialized'));
          };

          wrapper(
            module.exports,
            moduleRequire,
            module,
            resolved,
            module.dirname,
            moduleDynamicImport
          );

          module.loaded = true;
        } finally {
          _currentModule = prevModule;
        }

        // Cache with resolved path
        _moduleCache[cacheKey] = module.exports;
        delete _pendingModules[cacheKey];

        return module.exports;
      }

      // Expose _requireFrom globally so module polyfill can access it
      globalThis._requireFrom = _requireFrom;

    `;
}
