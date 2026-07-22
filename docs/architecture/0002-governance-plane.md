# ADR-0002: Governance Plane for Corrections and Reconciliation

Status: Historical ADR; governance principles retained, terminology partially superseded

Date: 2026-07-08

Current canonical target: [`MEMORY_ARCHITECTURE.md`](../../MEMORY_ARCHITECTURE.md)

The orthogonal Governance Plane and immutable Correction principles remain valid. References to separate L1 entities and `pending_l1` naming describe the current implementation and must be translated to Topic maintenance in the target model.

Incorporated by: [oh-my-memory Architecture v2.1](./oh-my-memory-architecture-v2.1.md)

Spec: [Memory Governance & Reconciliation v1](../superpowers/specs/2026-07-07-memory-governance-reconciliation-design.md)

## Context

oh-my-memory already separates online ingestion, offline L1 maintenance, and offline L2 aggregation. Explicit user corrections add a second concern: governance over already-derived memory. If corrections are encoded as synthetic Turns or synchronous online rewrites, they blur evidence authority, make stale Recall invisible, and violate the three-stage pipeline.

## Decision

Add a Governance Plane orthogonal to L0/L1/L2. The Governance Plane owns:

- immutable Correction Records;
- namespace change sequences;
- correction lifecycle state;
- L2 governance checkpoints;
- Statement lineage audit;
- Recall freshness metadata.

The Governance Plane is not L3 and not a memory layer. It does not create executable instructions. It records user correction evidence and drives eventual offline reconciliation.

## State Ownership

- The Correction API creates immutable Corrections and namespace changes only.
- The L1 job alone moves Turn and L1 Component Corrections from `pending_l1` to `ready_l2`.
- The L2 job alone moves ready Corrections to `applied` and advances the L2 governance checkpoint.
- Recall reads governance freshness but never mutates governance state.

No Correction write invokes L1 or L2 inline. Schedulers rediscover work from durable Correction statuses.

## Consequences

- Memory remains reference-only historical context.
- Explicit correction has stronger evidence authority than ordinary conversation, but it still does not become an instruction.
- Pending reconciliation is visible to Recall consumers.
- Lifecycle sequences are audit positions, not interchangeable watermarks.
- A namespace with only governance work remains schedulable after restart.
