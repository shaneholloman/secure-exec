## Tooling

- use pnpm, vitest, and tsc for type checks
- use turbo for builds
- keep timeouts under 1 minute and avoid running full test suites unless necessary
- use one-line Conventional Commit messages; never add any co-authors (including agents)
- never mark work complete until typechecks pass and all tests pass in the current turn; if they fail, report the failing command and first concrete error

## Terminology

- use `docs-internal/glossary.md` for canonical definitions of isolate, runtime, bridge, and driver

## Specs Source of Truth

- bridge/runtime/governance requirements are canonical in `openspec/specs/`
- for sandboxed-node runtime behavior, target Node.js semantics as close to 1:1 as practical
- any intentional deviation from Node.js behavior must be explicitly documented in OpenSpec deltas and reflected in compatibility/friction docs
- use `openspec/specs/README.md` for how to reference baseline capabilities in new change proposals
- track development friction in `docs-internal/friction/sandboxed-node.md` (mark resolved items with fix notes)

## Compatibility Project-Matrix Policy

- compatibility fixtures live under `packages/sandboxed-node/tests/projects/` and MUST be black-box Node projects (`package.json` + source entrypoint)
- fixtures MUST stay sandbox-blind: no sandbox-only branches, no sandbox-specific entrypoints, and no runtime tailoring in fixture code
- sandboxed-node runtime MUST stay fixture-opaque: no behavior branches by fixture name/path/test marker
- the matrix runs each fixture in host Node and sandboxed-node and compares normalized `code`, `stdout`, and `stderr`
- no known-mismatch classification is allowed; parity mismatches stay failing until runtime/bridge behavior is fixed

## Comment Pattern

Follow the style in `packages/sandboxed-node/src/index.ts`.

- use short phase comments above logical blocks
- explain intent/why, not obvious mechanics
- keep comments concise and consistent (`Set up`, `Transform`, `Wait for`, `Get`)
- comment tricky ordering/invariants; skip noise

## Skills

- create project skills in `.claude/skills/`
- expose Claude-managed skills to Codex via symlinks in `.codex/skills/`
