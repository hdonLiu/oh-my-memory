# ADR-0001: Three-Stage Memory Pipeline

Status: Accepted

Date: 2026-06-29

Incorporated by: [oh-my-memory Architecture v2](./oh-my-memory-architecture-v2.md)

## Context

oh-my-memory separates immediate conversation ingestion from semantic memory governance and cross-session knowledge aggregation.

The system must not let the online request path grow into a synchronous chain that rewrites historical Topic memories or rebuilds higher memory layers. L1 and L2 semantic maintenance are model-driven offline processes with different aggregation boundaries.

## Decision

The ingestion and aggregation architecture has exactly three stages:

```text
Stage 1: Online Topic Creation
L0 Turn
  -> Session Sliding Window
  -> Topic Boundary Detection
  -> Append New L1 Topic
  -> End Online Request

Stage 2: Offline L1 Topic Maintenance
Session-scoped L1 Topics
  -> extract and maintain L1 Components
  -> keep / merge / revise / split / delete
  -> Stabilized L1 Snapshot and Checkpoint

Stage 3: Offline L2 Knowledge Aggregation
Stabilized L1 Topics and Components Across Sessions
  -> create / update / merge / split / delete / ignore
  -> Cross-session L2 Knowledge Snapshot and Checkpoint
```

This decision is the foundation for subsequent consistency, storage, scheduling, evaluation, and retrieval design.

## Stage 1: Online Topic Creation

The online path is responsible only for:

- persisting the raw L0 conversation turn;
- maintaining the current session's sliding Topic window;
- detecting when a Topic boundary closes;
- generating and appending a new L1 Topic from the closed window;
- explicitly flushing the final open window when requested.

The mutable sliding window is working state, not a governed L1 knowledge revision.

The online path must not:

- merge completed L1 Topics;
- revise or overwrite completed L1 Topics;
- delete completed L1 Topics;
- split completed L1 Topics;
- deduplicate a new L1 Topic against historical L1 Topics;
- update L2 or L3;
- enqueue or directly trigger an L1 or L2 maintenance run.

In particular, a completed online Topic must be appended without passing through a resolver that can semantically add, update, delete, or merge historical Topic memories.

## Stage 2: Offline L1 Topic Maintenance

L1 is the session-level Topic aggregation layer.

The offline L1 maintenance job:

- runs only through an explicit schedule or manual command;
- operates within a single session boundary;
- reads online-created L1 Topics and their L0 turn evidence;
- extracts and maintains fine-grained Components inside each L1 Topic;
- uses the LLM to decide keep, merge, revise, split, delete, or no-op;
- preserves immutable revisions and evidence provenance;
- records a durable run, snapshot boundary, and successful checkpoint;
- is idempotent when the same input checkpoint is processed again.

L1 maintenance never combines Topics from different sessions. Cross-session synthesis belongs exclusively to L2.

L1 Component is an internal structure of L1, not an additional memory layer. An L1 Topic preserves the complete semantic context of one session Topic, while its Components expose independently reusable knowledge units. Each stabilized Component must have:

- an immutable internal ID;
- self-contained semantic content;
- an explicit link to its owning Topic revision;
- exact L0 turn evidence;
- an independently indexable representation;
- independent lifecycle/revision provenance where the detailed schema requires it.

The Topic summary preserves context; Components provide precise retrieval, evidence tracking, and recomposition. Component classification and content remain LLM-driven. The exact optional labels or taxonomy are a later schema decision and must not become a rule engine.

Writing or changing an L1 Topic does not directly trigger L2 work.

## Stage 3: Offline L2 Knowledge Aggregation

L2 is the cross-session Topic/entity knowledge aggregation layer.

The offline L2 aggregation job:

- runs only through an explicit schedule or manual command;
- consumes only stabilized L1 Topics and Components covered by successful L1 checkpoints;
- aggregates across session, source, and channel;
- never aggregates across `uid`;
- does not aggregate across `agent` by default;
- uses the LLM to decide create, update, merge, split, delete, ignore, or no-op;
- creates structured L2 knowledge aggregates and immutable revisions;
- records exact L1 evidence and the source L1 checkpoint;
- records a durable run, snapshot boundary, and successful L2 checkpoint;
- is idempotent when the same input checkpoint is processed again.

The default L2 aggregation namespace is:

```text
uid + agent
```

Project knowledge is one L2 aggregate type. L2 is not defined as the Project layer.

L2 uses stabilized Components as its primary fine-grained aggregation evidence and retains links back through Component -> Topic revision -> L0 turns. It may also read the owning Topic summary when broader context is needed. An L2 summary must not replace or erase its lower-level evidence.

### Two-phase L2 aggregation

An L2 run must separate structural membership decisions from generated aggregate content.

Phase A produces an explicit LLM-authored membership plan from stabilized Components, existing L2 aggregates, current memberships, and bounded retrieval candidates. Supported semantic operations include:

- attach Components to an existing aggregate;
- create an aggregate for unassigned Components;
- reassign Components between aggregates;
- merge aggregates;
- split an aggregate into multiple memberships;
- remove Components that are no longer supported;
- ignore Components that should not enter L2;
- leave an aggregate unchanged.

Embedding similarity or graph signals may retrieve and rank bounded candidates, but they do not make the final semantic membership decision. The LLM does. The system validates that every referenced Component and aggregate belongs to the permitted snapshot and namespace.

Phase B generates a new immutable L2 aggregate revision only after the intended Component membership is known. The LLM synthesizes the canonical title, summary, facts, decisions, constraints, open questions, and other agreed structured fields from those members and their Topic context.

The implementation must persist these concerns separately:

```text
L2 Aggregate
  stable identity and lifecycle

L2 Aggregate Revision
  generated knowledge content and model provenance

L2 Component Membership
  exact Component evidence for a specific revision/run
```

A one-shot prompt that reads Topic summaries and directly emits final L2 documents without an explicit, validated Component membership plan does not conform to this architecture.

L2 jobs discover L1 changes from persisted snapshots, revisions, statuses, and checkpoints. L1 writes do not emit direct L2 aggregation work.

## LLM-First Semantic Policy

Semantic decisions belong to the LLM:

- Topic equivalence;
- merge and split decisions;
- revision content;
- deletion or ignore decisions;
- L2 aggregate membership;
- canonical titles and aliases;
- structured knowledge synthesis.

The deterministic system layer is limited to integrity and operational guardrails:

- immutable internal IDs;
- scope isolation;
- schema validation;
- candidate and evidence ID validation;
- transactions and idempotency;
- revision and checkpoint persistence;
- audit provenance;
- bounded candidate retrieval.

The implementation must not accumulate regexes or hard-coded semantic identity rules as a substitute for model reasoning.

## Orchestration Boundary

The two offline jobs are independently invokable and independently checkpointed.

A scheduler or operator may run them in sequence:

```text
run L1 maintenance
wait for successful L1 checkpoint
run L2 aggregation against that checkpoint
```

This sequencing is orchestration, not an L1 data-write trigger. A failed L1 run does not advance the checkpoint visible to L2.

## Downstream L3

L3 remains a downstream long-term/global synthesis layer. Its exact inputs, schedule, promotion rules, and relationship to L1/L2 are not decided by this ADR.

No L3 behavior may violate the three-stage boundaries above.

## Explicitly Deferred Decisions

This ADR does not yet decide:

- whether newly appended online L1 Topics are searchable before offline L1 maintenance;
- the exact L1 lifecycle status names;
- the L1 and L2 table layout;
- the optional L1 Component label/type taxonomy;
- incremental versus full-reconciliation scheduling frequency;
- L2 aggregate taxonomy;
- L3 lifecycle and promotion policy;
- privacy-erasure propagation behavior.

These decisions must be compatible with this ADR.

## Current Implementation Gaps

The current implementation does not fully conform to this ADR:

- online Topic completion currently passes the generated Topic Memory through `MemoryResolver`, which can mutate historical Topic memories;
- L1 has no separate offline maintenance run, revision model, or checkpoint;
- current Topic metadata arrays are not independently identified, evidenced, indexed L1 Components;
- L2 is currently Project-only;
- L2 reads active Topic memories directly rather than consuming a stabilized L1 checkpoint;
- current L2 extraction directly emits Project memories from Topic inputs instead of planning Component membership before content synthesis;
- existing Project Build run records do not capture an L1 source checkpoint.

These are migration tasks, not exceptions to the architecture.

## Required Verification

Conformance tests must prove that:

- online ingestion only appends L0 turns and newly closed L1 Topics;
- online ingestion cannot revise, merge, split, or delete a completed L1 Topic;
- L1 maintenance cannot combine evidence from different sessions;
- every stabilized L1 Component links to its owning Topic revision and valid L0 turn evidence;
- L1 writes cannot directly invoke L2 aggregation;
- L2 ignores L1 data beyond its selected successful checkpoint;
- L2 can aggregate stabilized L1 Topics across source, channel, and session within the same `uid + agent` namespace;
- L2 evidence can be traced through Component and Topic revisions to original turns;
- each changed L2 revision has an explicit validated Component membership plan;
- rerunning Phase A and Phase B against the same checkpoint cannot create duplicate aggregate identities, revisions, or memberships;
- neither L1 nor L2 crosses its isolation boundary;
- rerunning an offline job for the same checkpoint is idempotent.

## Consequences

Positive consequences:

- online latency is bounded independently of higher-level memory maintenance;
- L1 and L2 quality can be evaluated and rerun independently;
- failures do not synchronously cascade through memory layers;
- historical evidence and model decisions remain auditable;
- cross-session knowledge is built from a stabilized Topic layer.

Tradeoffs:

- L1 and L2 are eventually consistent;
- offline run scheduling and checkpoint management become first-class concerns;
- newly created or corrected Topics may not immediately affect higher layers;
- storage must preserve revisions and run provenance.
