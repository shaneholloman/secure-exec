# future work

- terminal emulation
- get claude code cli working in this emulator
- emulate npm
- native addon polyfills - npm packages with native C/C++ bindings won't work in isolated-vm. may need a polyfill registry mapping them to pure-JS alternatives (e.g. esbuild→esbuild-wasm, bcrypt→bcryptjs, sharp→sharp-wasm, sqlite3→sql.js)
- pre-build node-stdlib-browser polyfills - bundle all polyfills at build time instead of on-demand via esbuild, reduces runtime overhead and startup latency
