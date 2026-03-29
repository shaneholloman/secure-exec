# Doom in Secure Exec

Run the original 1993 Doom (shareware) inside a secure-exec sandbox, rendered
in your terminal using ANSI true-color and Unicode half-block characters.

The Doom engine ([doomgeneric](https://github.com/ozkl/doomgeneric)) is compiled
from C to WebAssembly using the same `wasi-sdk` toolchain the rest of the project
uses. No WASM-specific code — just a standard POSIX terminal backend.

## Prerequisites

- wasi-sdk built at `native/wasmvm/c/vendor/wasi-sdk/` (`make wasi-sdk` in `native/wasmvm/c/`)
- Patched sysroot at `native/wasmvm/c/sysroot/` (`make sysroot` in `native/wasmvm/c/`)
- `wasm-opt` (binaryen) on PATH
- A terminal with true-color support (most modern terminals)

## Build

```sh
make build
```

This downloads the doomgeneric source and `doom1.wad` (shareware, freely
distributable by id Software), then compiles everything to a ~430KB WASM binary.

## Run

```sh
pnpm tsx src/index.ts
```

## Controls

| Key            | Action         |
|----------------|----------------|
| Arrow keys     | Move / turn    |
| W/A/S/D        | Move / strafe  |
| F              | Fire           |
| Space          | Open / use     |
| R              | Run            |
| , / .          | Strafe L / R   |
| Enter          | Menu select    |
| Esc            | Menu           |
| 1-7            | Switch weapon  |
| Q / Ctrl+C     | Quit           |

## How It Works

1. **C backend** (`c/doomgeneric_terminal.c`) implements 5 callbacks:
   - `DG_DrawFrame()` — converts BGRA framebuffer → ANSI half-block output
   - `DG_GetKey()` — reads keypresses via `poll()` + `read()` on stdin
   - `DG_GetTicksMs()` / `DG_SleepMs()` — `clock_gettime` / `nanosleep`
   - `DG_Init()` — switches to alternate screen buffer

2. **Makefile** compiles doomgeneric + our backend → `build/doom` (WASM)

3. **Node.js runner** (`src/index.ts`) creates a kernel, loads `doom1.wad`
   into the virtual filesystem, mounts the WASM runtime, and spawns doom
   via `kernel.spawn()` with raw stdin/stdout forwarding
