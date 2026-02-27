## ADDED Requirements

### Requirement: CPU Limit Compatibility and Friction Documentation Stays Aligned
Any change that introduces or modifies the sandboxed-node CPU time limit contract MUST update compatibility/friction documentation in the same change.

#### Scenario: CPU timeout contract is introduced or changed
- **WHEN** runtime behavior for configured CPU limits changes (including option names, failure codes, or timeout stderr contract)
- **THEN** `docs-internal/friction/sandboxed-node.md` MUST be updated with the behavior change and resolution notes

#### Scenario: Research guidance reflects current CPU limit design
- **WHEN** CPU limit implementation guidance is revised
- **THEN** `docs-internal/research/comparison/cloudflare-workers-isolates.md` MUST be updated so recommendations match the active runtime contract and OpenSpec deltas
