# Documentation Index

This directory contains architecture history, roadmaps, specifications, and implementation plans. It is not itself the source of truth for the current target architecture.

## Current documents

1. [Canonical target architecture](../MEMORY_ARCHITECTURE.md) — defines the current `Turn -> Topic -> L2 Aggregate -> L3 Profile` model and state ownership.
2. [Issue and implementation tracker](../PROJECT_ISSUES.md) — records discussion status, implementation status, agreed solutions, and acceptance criteria.
3. [Runtime README](../README.md) — describes how to run the current transitional implementation and calls out differences from the target architecture.

If these documents conflict, use the order above.

## Historical architecture records

- [Architecture v2](architecture/oh-my-memory-architecture-v2.md) — implemented Provisional/Canonical L1 model; superseded as a target architecture.
- [Architecture v2.1](architecture/oh-my-memory-architecture-v2.1.md) — governance extension to v2; superseded as a target architecture.
- [ADR-0001](architecture/0001-three-stage-memory-pipeline.md) — historical pipeline decision; its online/offline separation remains useful, but its separate L1 stage entities are superseded.
- [ADR-0002](architecture/0002-governance-plane.md) — historical governance decision; immutable Correction and checkpoint principles remain relevant.

## Historical roadmaps

- [2026-05-28 next steps](roadmaps/2026-05-28-next-steps.md)
- [2026-06-29 production readiness](roadmaps/2026-06-29-production-readiness.md)

Open work from these roadmaps must be reconciled with `PROJECT_ISSUES.md` before implementation.

## Historical specifications and plans

Documents under `superpowers/specs/` and `superpowers/plans/` describe earlier designs or the implementation of the current transitional code. They are retained for traceability and must not override the canonical target architecture.
