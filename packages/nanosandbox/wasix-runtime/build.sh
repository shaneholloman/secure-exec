#!/bin/bash
set -e

cd "$(dirname "$0")"

# Build Rust to WASM
# NOTE: Currently using wasm32-wasip1 because wasmer-js doesn't implement the
# WASIX-specific syscalls (proc_spawn2, fd_dup2, etc.) needed for native subprocess
# spawning. Once wasmer-js is upgraded to support these syscalls, switch to:
#   cargo wasix build --release
# and update wasmer.toml source to: target/wasm32-wasmer-wasi/release/wasix-runtime.wasm
echo "==> Building WASM module..."
cargo build --target wasm32-wasip1 --release

# Package into .webc
echo "==> Packaging .webc..."
rm -f ../assets/runtime.webc
wasmer package build -o ../assets/runtime.webc

echo ""
echo "==> Built runtime.webc"
