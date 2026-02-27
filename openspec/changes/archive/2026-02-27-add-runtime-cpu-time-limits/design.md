## Context

`sandboxed-node` currently has no runtime CPU budget enforcement, so user code can run indefinitely (for example `while(true){}`). This creates a denial-of-service risk and makes execution latency unpredictable for hosts that run untrusted code. The runtime must remain close to Node semantics by default, so any stricter behavior should be explicitly configured rather than silently enabled.

## Goals / Non-Goals

**Goals:**
- Add a configurable CPU limit for Node runtime executions.
- Enforce one shared execution deadline across all isolate execution choke points.
- Define deterministic timeout error behavior that is testable and stable.
- Reset isolate state after timeout to avoid reusing potentially inconsistent runtime state.

**Non-Goals:**
- OS-level sandboxing (seccomp/namespaces).
- Spectre-specific timing mitigations (`Date.now()` freezing, perf counter defenses).
- Browser runtime CPU-limit behavior changes in this change.

## Decisions

### 1. Add `cpuTimeLimitMs` as an opt-in runtime execution control

Decision:
- Extend `NodeProcessOptions` and per-call `ExecOptions` with `cpuTimeLimitMs?: number`.
- Keep limit disabled by default so baseline behavior remains Node-like unless explicitly configured.

Rationale:
- Hosts that run trusted code can preserve current semantics.
- Hosts that run untrusted code can opt in without external watchdog infrastructure.

Alternatives considered:
- Always-on low timeout: rejected because it introduces a broad default compatibility break.
- Separate `runTimeoutMs` and `execTimeoutMs`: rejected as unnecessary complexity for initial rollout.

### 2. Enforce a shared per-execution deadline across all user-code entry points

Decision:
- At execution start, compute a deadline (`start + cpuTimeLimitMs`).
- For each isolate call that can execute or await user-controlled code, compute `remainingMs` and pass it via isolated-vm timeout options.
- Apply this to `script.run`, ESM `module.evaluate`, dynamic import evaluation, and relevant `context.eval` paths.

Rationale:
- Per-call timeouts alone can be bypassed by splitting work across many calls.
- Shared deadline enforces a true end-to-end CPU budget for one execution.

Alternatives considered:
- Timeout only on top-level `script.run`: rejected because async/eval/module paths can exceed budget afterward.
- Host watchdog thread that disposes isolates: deferred for later lifecycle hardening.

### 3. Define deterministic timeout failure and isolate recovery

Decision:
- Timeout failures return a stable contract (`code: 124`, stderr containing `CPU time limit exceeded`).
- On timeout, dispose and recreate the isolate before the next execution.

Rationale:
- Deterministic error contracts simplify tests and compatibility fixtures.
- Isolate recycle minimizes risk of carrying forward inconsistent state after interrupted execution.

Alternatives considered:
- Reuse isolate after timeout: rejected due to unclear post-interrupt invariants.
- Surface raw isolated-vm timeout error text: rejected because it can vary and weakens compatibility assertions.

## Risks / Trade-offs

- [Legitimate workloads can time out] -> Mitigation: keep default unset, allow host-configurable limit, and support per-call override.
- [Missed enforcement path leaves residual DoS gap] -> Mitigation: require tests for CJS, ESM, dynamic import, and active-handle waits.
- [Timeout behavior diverges from Node default runtime behavior] -> Mitigation: document deviation only for configured limit in compatibility/friction docs.

## Migration Plan

1. Add API fields and internal budget helper behind default-disabled behavior.
2. Thread timeout options through all identified runtime execution choke points.
3. Add regression tests for timeout enforcement and deterministic failure contract.
4. Update compatibility/friction docs with the opt-in deviation and failure semantics.

Rollback:
- Revert `cpuTimeLimitMs` option usage and budget helper, restoring previous no-timeout runtime behavior.

## Open Questions

- Should per-call `ExecOptions.cpuTimeLimitMs` override constructor-level `NodeProcessOptions.cpuTimeLimitMs`, or should constructor value be absolute?
- Should future policy include separate wall-time and CPU-time limits, or keep a single runtime budget for now?
