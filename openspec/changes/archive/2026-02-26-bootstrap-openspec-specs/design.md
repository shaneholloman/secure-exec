## Context

libsandbox currently documents behavior across `README.md`, internal compatibility/friction notes, and research comparison docs. Those sources describe real constraints (driver-based runtime, strict bridge boundary, compatibility gaps), but they are not yet represented as OpenSpec capabilities that can govern future changes.

This change bootstraps an initial OpenSpec baseline for current requirements, centered on `packages/sandboxed-node` and its surrounding governance docs. The design goal is to turn existing project intent into stable, testable requirement statements without changing runtime code.

## Goals / Non-Goals

**Goals:**
- Define capability-level requirements for runtime behavior across Node and browser execution paths.
- Codify bridge policy constraints, especially the Node built-in-only boundary and third-party module resolution rules.
- Establish documentation governance requirements so compatibility docs, OpenSpec tracking, and friction artifacts stay synchronized with runtime evolution.

**Non-Goals:**
- Introducing new sandbox runtime functionality or exposing new host capabilities.
- Resolving all currently known compatibility gaps listed in existing backlog items and compatibility docs.
- Refactoring implementation code in `packages/sandboxed-node` as part of this proposal.

## Decisions

### 1. Split baseline into three focused capabilities

Decision:
- Create `runtime-execution-model`, `bridge-boundary-policy`, and `compatibility-governance` as separate new capabilities.

Rationale:
- The project has three distinct requirement classes: runtime behavior, security boundary rules, and maintenance process obligations.
- Separate specs reduce coupling and make future deltas smaller and easier to review.

Alternatives considered:
- Single monolithic "sandboxed-node" spec: rejected because it would combine runtime contracts, security policy, and governance into one large file with high merge churn.

### 2. Specify current-state requirements, not aspirational future-state behavior

Decision:
- Requirements are derived from current docs and observed architecture, including explicit unsupported or constrained behavior.

Rationale:
- A bootstrap spec should reflect the current contract so future changes are explicit deltas.
- Writing idealized requirements now would force immediate implementation work unrelated to this documentation change.

Alternatives considered:
- Write target/future behavior now and backfill implementation later: rejected because this would blur specification and roadmap planning.

### 3. Treat internal docs as first-class requirement inputs

Decision:
- Use README, `docs-internal/node/stdlib-compat.md`, `docs-internal/friction/sandboxed-node.md`, and existing OpenSpec change artifacts as authoritative inputs for this baseline.

Rationale:
- These files already encode project constraints and unresolved decisions.
- Encoding them in OpenSpec makes those constraints enforceable in change workflows.

Alternatives considered:
- Derive requirements only from code audit: rejected for this bootstrap due to higher effort and lower short-term momentum.

### 4. Encode governance requirements as normative spec requirements

Decision:
- Include mandatory requirements for updating compatibility docs, OpenSpec tracking, and friction logging when relevant changes occur.

Rationale:
- The project already relies on these practices; formalizing them improves consistency and reviewer expectations.

Alternatives considered:
- Keep governance only in AGENTS/CLAUDE instructions: rejected because it keeps requirements outside OpenSpec’s change lifecycle.

## Risks / Trade-offs

- [Risk] Spec statements may drift from actual runtime behavior in edge cases.
  -> Mitigation: Keep requirements scoped to clearly documented behavior and follow up with delta changes when mismatches are found.

- [Risk] Governance requirements may feel process-heavy for small changes.
  -> Mitigation: Scope updates to changes that materially affect bridge surface, compatibility status, or known friction.

- [Risk] Initial capability boundaries may not match long-term ownership structure.
  -> Mitigation: Start with clear boundaries now and evolve through later renamed/modified capability changes if needed.

## Migration Plan

1. Land this change as the OpenSpec baseline for sandboxed-node-centric requirements.
2. Use these capabilities as the reference point for all subsequent runtime and bridge change proposals.
3. Track newly discovered gaps as follow-up OpenSpec changes rather than expanding this bootstrap change indefinitely.

No runtime deployment or rollback mechanics are required because this change introduces specification artifacts only.

## Open Questions

- Should compatibility requirements eventually include a machine-readable module/API matrix in addition to markdown docs?
- Should permission model behavior (allow-by-default vs deny-by-default) be split into its own capability once finalized?
- Should browser-runtime-specific constraints be promoted into a separate capability as coverage expands?
