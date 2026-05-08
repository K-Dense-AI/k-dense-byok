# ADR-0001: Defer decomposition of `runtime.py` and `projects.py`

**Status:** Accepted
**Date:** 2026-05-07

## Context

`/improve-codebase-architecture` flagged that `kady_agent/runtime.py` (1239 lines) and `kady_agent/projects.py` (1051 lines) are bundles, not modules — likely containers of unrelated implementations sharing a file. Applying the deletion test, knowledge of session lifecycle, cost ledger, turn orchestration, project lifecycle, paths, and registry I/O would *concentrate* across multiple modules if these files were decomposed correctly. So decomposition is justified in principle.

The same review surfaced four other deepening opportunities:

1. Duplicated tracking-tag plumbing across `runtime.py` ↔ `litellm_callbacks.py`.
2. `ProjectPaths` exposing raw `Path` fields with operations scattered across nine sites.
3. `write_merged_settings` as a forgettable side effect with four redundant callers.
4. `sandbox_visibility.py` as a one-caller shallow module.

Items 1–4 each carve well-bounded slices off `runtime.py` / `projects.py` and ship as separate, reviewable PRs (see `.omc/plans/architecture-deepening.md`).

## Decision

Defer full decomposition of `runtime.py` and `projects.py`. Land items 1–4 first.

## Consequences

- `runtime.py` shrinks by ~140 lines once tracking tags move to `kady_agent/tracking.py` (item 1).
- `projects.py` gains methods (item 2) but the operations migrating *into* it (citation cache I/O, MCP materialization, visibility traversal) make the file slightly longer in absolute terms while consolidating what was previously scattered. This is the right trade-off — locality before length.
- Both files remain >1000 lines after items 1–4 land. That is accepted.
- Future feature work touching either file may be a natural decomposition trigger; revisit this ADR when that happens.

## Re-evaluation trigger

Reopen this decision when either file gains a substantive new feature, or when a third deepening pass surfaces structural friction that items 1–4 did not resolve.

## Alternatives considered

- **Decompose now, in the same PR series.** Rejected: balloons scope, doubles blast radius, and items 1–4 are already useful on their own. Sequential delivery dominates.
- **Decompose first, then do items 1–4.** Rejected: the deepenings (especially `ProjectPaths`) clarify what the right module boundaries even *are*. Decomposing first risks redoing the boundaries after.
