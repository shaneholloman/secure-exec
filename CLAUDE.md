## Tooling

- use pnpm, vitest, and tsc for type checks
- use turbo for builds
- keep timeouts under 1 minute and avoid running full test suites unless necessary
- use one-line Conventional Commit messages; never add any co-authors (including agents)

## Specs Source of Truth

- bridge/runtime/governance requirements are canonical in `openspec/specs/`
- use `openspec/specs/README.md` for how to reference baseline capabilities in new change proposals
- track development friction in `docs-internal/friction/sandboxed-node.md` (mark resolved items with fix notes)

## Comment Pattern

Follow the style in `packages/sandboxed-node/src/index.ts`.

- use short phase comments above logical blocks
- explain intent/why, not obvious mechanics
- keep comments concise and consistent (`Set up`, `Transform`, `Wait for`, `Get`)
- comment tricky ordering/invariants; skip noise
