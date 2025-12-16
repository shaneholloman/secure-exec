#!/bin/bash
set -e

cd "$(dirname "$0")"

NPM_VERSION="${NPM_VERSION:-11.7.0}"

echo "==> Preparing npm@${NPM_VERSION} for bundling..."

# Clean up previous build artifacts
rm -rf dist

# Download npm tarball (cached by version)
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/nano-sandbox"
NPM_TARBALL="${CACHE_DIR}/npm-${NPM_VERSION}.tgz"

mkdir -p "$CACHE_DIR"

if [ -f "$NPM_TARBALL" ]; then
    echo "    Using cached npm@${NPM_VERSION}"
else
    echo "    Downloading npm@${NPM_VERSION}..."
    curl -sL "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz" -o "$NPM_TARBALL"
fi

tar -xzf "$NPM_TARBALL"

# Prune unnecessary files to reduce package size
echo "    Pruning unnecessary files..."
rm -rf package/man package/docs package/test package/changelogs
find package -name "*.md" -type f -delete 2>/dev/null || true
find package -name "LICENSE*" -type f -delete 2>/dev/null || true
find package -name "CHANGELOG*" -type f -delete 2>/dev/null || true
find package -name "*.txt" -type f -delete 2>/dev/null || true
find package -name ".npmignore" -type f -delete 2>/dev/null || true
find package -name ".eslint*" -type f -delete 2>/dev/null || true

# Create directory structure in dist/
echo "    Setting up filesystem structure..."
mkdir -p dist/usr/lib/node_modules
mkdir -p dist/usr/bin
mkdir -p dist/etc

# Move npm to proper location
mv package dist/usr/lib/node_modules/npm

# Create bin entry scripts
cat > dist/usr/bin/npm << 'EOF'
#!/usr/bin/env node
require('/usr/lib/node_modules/npm/lib/cli.js')(process)
EOF

cat > dist/usr/bin/npx << 'EOF'
#!/usr/bin/env node
require('/usr/lib/node_modules/npm/lib/cli.js')(process, 'npx')
EOF

chmod +x dist/usr/bin/npm dist/usr/bin/npx

# Create default npmrc
cat > dist/etc/npmrc << 'EOF'
; Default npm configuration
prefix=/usr/local
cache=/tmp/.npm
EOF

echo "    npm@${NPM_VERSION} prepared successfully"
echo ""

# Build Rust to WASM
echo "==> Building WASM module..."
cargo build --target wasm32-wasip1 --release

# Package into .webc
echo "==> Packaging .webc..."
rm -f ../assets/runtime.webc
wasmer package build -o ../assets/runtime.webc

echo ""
echo "==> Built runtime.webc with npm@${NPM_VERSION}"
