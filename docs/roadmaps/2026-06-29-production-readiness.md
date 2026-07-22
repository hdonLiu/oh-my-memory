# oh-my-memory Production Readiness Backlog

Status: Superseded historical backlog

Current target architecture: [`MEMORY_ARCHITECTURE.md`](../../MEMORY_ARCHITECTURE.md)

Current issue and implementation tracker: [`PROJECT_ISSUES.md`](../../PROJECT_ISSUES.md)

This backlog records the v2 production-readiness plan. Completed items remain implementation history; open work has been re-triaged in the current issue tracker and should not be implemented from this file without reconciling it with the target architecture.

Binding decision: [ADR-0001: Three-Stage Memory Pipeline](../architecture/0001-three-stage-memory-pipeline.md)

This backlog tracks the work required to move oh-my-memory from a functional local prototype to a reliable production service. Items are ordered by dependency and risk, not by implementation difficulty.

Status legend:

- `[ ]` not started
- `[-]` under discussion or in progress
- `[x]` completed and verified

## Target Stages

### Stage 1: Reliable Local Runtime

The service remains a local, single-node SQLite application, but must tolerate retries, partial failures, process restarts, and long-running data growth.

### Stage 2: Operable Small-Scale Service

The service can support real users with authentication, controlled scope access, measurable retrieval quality, repeatable deployment, and operational visibility.

### Stage 3: Multi-Tenant Platform

The service supports horizontal scaling, stronger tenant isolation, distributed background jobs, quotas, compliance, and larger retrieval workloads.

## P0: Data Safety and Runtime Reliability

### PR-000: Implement the v2 memory architecture

- [x] Accept ADR-0001 as the binding three-stage architecture for online Topic creation, offline L1 maintenance, and offline L2 aggregation.
- [x] Consolidate the accepted decisions into the canonical v2 target architecture.
- [-] Adopt the layer model: L0 raw turns, L1 session topics, L2 cross-session knowledge aggregates, and L3 cross-topic global/profile memory. L0-L2 are implemented; L3 remains a future boundary.
- [x] Define the default L2 aggregation namespace as `uid + agent`; L2 crosses session, source, and channel, but never crosses `uid` and does not cross `agent` by default.
- [x] Rename the current `mis` field to `uid` across public Scope types, HTTP/CLI contracts, storage schema, indexes, tests, and current documentation, with an explicit compatibility migration.
- [x] Define the online path as append-only L0 ingestion plus sliding-window L1 Topic creation; online ingestion must not merge, revise, delete, split, or semantically reconcile completed L1 Topics.
- [x] Define L1 merge, revise, delete, split, deduplication, and noise cleanup as a separate offline L1 maintenance job scoped within a session.
- [x] Keep Component as an internal L1 Topic structure rather than adding another memory layer: Topic summary preserves complete context, while Components provide independently identified, evidenced, indexed, and revisable knowledge units.
- [-] Define the L1 Component schema and storage model, including Topic revision ownership, turn-level evidence, indexing, provenance, and lifecycle behavior. Storage, evidence, provenance, and lifecycle are implemented; Component vector indexing remains.
- [ ] Convert or replace current `entities`, `decisions`, `tasks`, and `preferences` string arrays with evidenced Components where appropriate.
- [x] Define L2 aggregation as a separate offline job that consumes the stabilized output/checkpoint of successful L1 maintenance runs and performs cross-session aggregation.
- [x] Define stabilized L1 Components as L2's primary fine-grained evidence while allowing L2 to read the owning Topic summary for broader context.
- [x] Define L2 aggregation as a two-phase offline process: first produce an explicit LLM-authored Component membership plan, then synthesize immutable L2 revisions from the validated members.
- [x] Separate stable L2 aggregate identity, generated aggregate revision content, and revision/run-specific Component membership.
- [x] Define the structured L2 membership-plan schema for attach, create, reassign, merge, split, remove, ignore, and unchanged operations.
- [ ] Define candidate retrieval for the membership planner; embeddings/graph signals bound the candidate set while the LLM makes the final semantic decision.
- [x] Define atomic validation and commit behavior for membership plans and generated revisions.
- [x] Remove the current online Topic Memory resolver behavior from `ingestTurn` and `flushSessionTopic`; completed online Topics are appended without resolving against existing Topics.
- [x] Define L1 maintenance run records, source watermarks, snapshot boundaries, retry behavior, and idempotent commit semantics.
- [x] Define offline orchestration so scheduled/manual L1 maintenance and L2 aggregation use explicit checkpoints without L1 writes directly triggering L2 work.
- [x] Replace the assumption that every L2 memory is a project in the v2 path; retain the project-only builder as a legacy compatibility API.
- [x] Use a system-generated immutable aggregate ID rather than a rule-generated semantic `aggregateKey`; keep LLM-maintained `canonicalTitle`, aliases, and optional external keys as descriptive identity.
- [x] Make L2 resolution LLM-first: retrieval supplies bounded candidates, and the LLM decides attach, create, update, merge, or ignore.
- [x] Restrict deterministic system logic to integrity guardrails: scope isolation, candidate/evidence ID validation, schema validation, transactions, versions, and audit provenance.
- [x] Support open LLM-authored `aggregateType` values rather than a system rule enum, including project, product, workflow, technical topic, research, person, preference, and personal context.
- [x] Define L2 as a level-specific knowledge aggregate model rather than forcing it into a subject/predicate/object triple; its agreed core fields are immutable ID, `aggregateType`, `canonicalTitle`, aliases, optional external keys, `summary`, `facts`, `decisions`, `constraints`, `openQuestions`, evidence IDs, confidence, lifecycle status, scope, and timestamps.
- [x] Keep unified persistence/search possible while representing L0/L1/L2/L3 as distinct TypeScript layer types; promote important L2 identity/query fields out of arbitrary metadata.
- [ ] Preserve `evidenceMemoryIds` and add explicit cross-session evidence/provenance.
- [x] Require L2 facts, decisions, constraints, and open questions to cite supporting Component IDs from the validated Revision Membership.
- [x] Define how new L1 topics add, update, contradict, merge, or leave an L2 aggregate unchanged through the LLM-authored membership plan and immutable revision synthesis.
- [ ] Generalize `ProjectMemoryBuilder` into an L2/knowledge aggregation builder while retaining project aggregation as one strategy.
- [x] Add the two-phase Component-membership and L2-revision pipeline as the canonical v2 path; keep one-shot Topic-to-Project extraction only for compatibility.
- [x] Add generalized L2 APIs without breaking existing project use cases.
- [ ] Define migration and backward compatibility for existing `type=project` L2 memories and `projectKey` metadata.
- [ ] Add evaluation fixtures covering same-topic aggregation across sessions, topic separation, updates, conflicts, and mixed aggregate types.
- [x] Align current code and documentation terminology so L1 consistently means session Topic Memory; historical documents remain explicitly marked.

Done when: the online path only appends sliding-window Topics, offline L1 maintenance stabilizes Topic knowledge within each session, L2 answers "what is currently known about this topic or entity across sessions," projects are one supported aggregate type rather than the layer definition, semantic grouping is LLM-driven instead of encoded as a growing rule engine, and existing project memories can be migrated without losing evidence.

### PR-001: Define the write consistency and idempotency model

- [-] Decide the lifecycle and atomic boundary for turn ingestion. Turn persistence is idempotent; recoverable Buffer processing state remains.
- [x] Add a caller-supplied idempotency key (`eventId`).
- [x] Add the corresponding `uid + source + eventId` database uniqueness constraint.
- [ ] Define safe retry behavior for failed LLM calls.
- [ ] Prevent duplicate turns, topic transitions, memories, and relations.
- [ ] Define recovery behavior for partially completed ingestion.
- [ ] Add duplicate-request, failure-retry, and process-interruption tests.

Done when: repeating the same logical request produces the same persisted result, and failure at any step cannot leave an unrecoverable memory state.

### PR-002: Add transaction boundaries and concurrency control

- [ ] Wrap related SQLite writes in explicit transactions.
- [ ] Prevent concurrent writes from corrupting one session's open topic.
- [ ] Add optimistic versions or another conflict-detection mechanism where needed.
- [ ] Ensure resolver update operations cannot supersede an old memory without creating its replacement.
- [ ] Coordinate Project Build, Dreaming, ingestion, and manual edits.
- [ ] Add same-session and same-memory concurrency tests.

Done when: concurrent requests have deterministic outcomes and multi-record updates are committed or rolled back as a unit.

### PR-003: Make the vector index consistent and rebuildable

- [ ] Centralize indexing for every memory create, update, supersede, and delete path.
- [ ] Index L3 memories created by Dreaming.
- [ ] Reindex memories after editable text changes.
- [ ] Remove or deactivate vectors for deleted memories.
- [ ] Add full and scoped reindex commands.
- [ ] Persist embedding provider, model, dimensions, and index version metadata.
- [ ] Detect model or dimension changes and require/recommend rebuild.
- [ ] Add consistency checks between `memories` and `memory_vectors`.

Done when: the vector index can be deleted and deterministically rebuilt, and it cannot silently serve stale memory content.

### PR-004: Harden LLM calls

- [ ] Add request timeouts and cancellation.
- [ ] Add bounded retries with exponential backoff and jitter.
- [ ] Add concurrency and rate limits.
- [ ] Decide which operations fail closed and which may use a fallback.
- [ ] Add circuit-breaker or temporary provider-disable behavior.
- [ ] Version prompts and response schemas.
- [ ] Record provider, model, latency, token usage, and failure category.
- [ ] Add timeout, malformed response, rate-limit, and provider-outage tests.

Done when: provider failures are bounded, observable, retry-safe, and do not corrupt persisted state.

### PR-005: Clarify mandatory versus optional LLM behavior

- [ ] Decide whether the supported runtime requires an LLM.
- [ ] Align server, CLI, tests, README, and environment configuration with that decision.
- [ ] Validate all required configuration before opening the HTTP port.
- [ ] Add readiness output that distinguishes database, LLM, and embedding availability.
- [ ] Add a checked-in `.env.example` without secrets.

Done when: startup behavior and documentation agree, with no ambiguous fallback claims.

### PR-006: Establish backup, recovery, and migration safety

- [ ] Replace the current imperative migration marker with ordered versioned migrations.
- [ ] Make migrations transactional where SQLite permits it.
- [ ] Test upgrades from every supported schema version.
- [ ] Define database backup and restore commands.
- [ ] Include WAL files correctly in backup behavior.
- [ ] Document and test recovery from a failed migration.

Done when: an operator can upgrade, back up, restore, and recover the database without manual SQL surgery.

## P1: Security, Scale, and Operability

### PR-007: Secure the HTTP boundary

- [ ] Bind to `127.0.0.1` by default.
- [ ] Configure an explicit CORS allowlist.
- [ ] Add authentication for non-local deployment.
- [ ] Derive trusted tenant/scope identity from authentication rather than request fields.
- [ ] Add authorization tests that prevent cross-scope access.
- [ ] Add request-size limits, rate limits, and safe error responses.
- [ ] Upgrade vulnerable production dependencies, including the Fastify dependency chain.

Done when: an untrusted caller cannot read or mutate another caller's memory by changing scope fields.

### PR-008: Move filtering and pagination into storage queries

- [ ] Replace full-table reads with SQL scope/status/session filters.
- [ ] Add cursor or stable pagination to list endpoints.
- [ ] Add appropriate composite indexes based on measured query plans.
- [ ] Make scheduler scope discovery incremental.
- [ ] Define retention or archival behavior for raw turns and old topic segments.
- [ ] Add representative-volume performance tests.

Done when: latency and memory use remain bounded as stored turns and memories grow.

### PR-009: Upgrade vector retrieval for larger datasets

- [ ] Define the dataset size at which brute-force SQLite vector scans are no longer supported.
- [ ] Evaluate `sqlite-vec`/equivalent for local mode.
- [ ] Define a replaceable production ANN backend if multi-node operation is required.
- [ ] Preserve scope filtering and deterministic test implementations.
- [ ] Add index build, restart persistence, and performance benchmarks.

Done when: the vector backend has documented scale limits and meets an explicit latency target.

### PR-010: Add production observability and auditability

- [ ] Add structured logs with request, session, scope, run, and trace IDs.
- [ ] Add latency, error-rate, retry, queue, database, and LLM metrics.
- [ ] Record why a memory was added, updated, deleted, or selected for recall.
- [ ] Record prompt/schema/model version provenance without leaking secrets.
- [ ] Add liveness and dependency-aware readiness endpoints.
- [ ] Define alert thresholds and operator troubleshooting steps.

Done when: an operator can explain a failed request and the provenance of a generated memory from retained telemetry.

### PR-011: Build a layered test and CI pipeline

- [ ] Split the monolithic test file into domain, storage, API, CLI, and workflow suites.
- [ ] Add real-process HTTP tests.
- [ ] Add concurrency and crash-recovery tests.
- [ ] Add migration and restart tests.
- [ ] Add performance smoke tests with realistic data volumes.
- [ ] Run typecheck, tests, dependency audit, and migration checks in CI.
- [ ] Define release-blocking quality gates.

Done when: every change is automatically checked against correctness, compatibility, security, and basic performance regressions.

## P1: Retrieval and Memory Quality

### PR-012: Make hybrid ranking calibrated and explainable

- [ ] Normalize lexical and vector scores before combining them.
- [ ] Define minimum relevance thresholds.
- [ ] Make level, confidence, recency, and stale penalties configurable.
- [ ] Add result score breakdowns for debugging.
- [ ] Add relation expansion with bounded depth and candidate count.
- [ ] Enforce a candidate and prompt-token budget before LLM recall.

Done when: ranking behavior is measurable, tunable, and explainable for a returned result.

### PR-013: Turn evaluation fixtures into a quality gate

- [ ] Add `eval:recall`, `eval:project`, and later `eval:topic` commands.
- [ ] Track Recall@K, Precision@K, stale-memory rate, and no-memory-needed accuracy.
- [ ] Track LLM latency, token usage, and estimated cost.
- [ ] Version datasets and expected outputs.
- [ ] Add regression thresholds to CI or release checks.
- [ ] Keep live-provider evaluation separate from deterministic unit tests.

Done when: model, prompt, and ranking changes cannot be released without a visible quality comparison.

### PR-014: Define memory lifecycle and long-term quality rules

- [ ] Define promotion criteria for Topic to L2 and L2/Topic to L3.
- [ ] Model stability, frequency, cross-session evidence, and future usefulness explicitly.
- [ ] Define confidence decay, expiration, and archival behavior.
- [ ] Prevent temporary task chatter from becoming durable profile memory.
- [ ] Add contradiction and supersede-chain repair checks.
- [ ] Add human correction provenance and protected/manual memory behavior.

Done when: long-running data does not accumulate unbounded stale, duplicate, or unjustified durable memories.

## P1: Release and Product Contract

### PR-015: Define API, schema, and release compatibility

- [ ] Introduce an API versioning policy.
- [ ] Define compatibility rules for stored data, prompts, and response payloads.
- [ ] Add changelog and release notes.
- [ ] Add Docker or another repeatable deployment artifact if server deployment is supported.
- [ ] Define configuration precedence and validation.
- [ ] Publish supported Node.js and SQLite versions.

Done when: operators can upgrade with a documented compatibility and rollback expectation.

### PR-016: Reconcile documentation with the implementation

- [x] Update README to reflect mandatory/optional LLM behavior.
- [x] Document the v2 `/recall` endpoint and current runtime behavior.
- [x] Replace the obsolete L1 terminology with the current Topic layer model where appropriate.
- [x] Correct the documented storage technology and vector implementation.
- [x] Mark historical plans as superseded references.
- [x] Replace the old next-steps roadmap with this backlog.

Done when: a new contributor can predict actual runtime behavior from the documentation.

## P2: Platform Expansion

### PR-017: Add supported SDK and MCP transports

- [ ] Define a stable SDK API over `MemoryService` or HTTP.
- [ ] Add MCP tools for ingestion, recall, correction, and inspection.
- [ ] Preserve a single validation and authorization path across transports.

### PR-018: Add a memory inspection and correction UI

- [ ] Search and inspect memories, evidence, relations, and versions.
- [ ] Correct, protect, delete, or merge memories with audit provenance.
- [ ] Inspect Topic, Project Build, Dreaming, and Recall runs.

### PR-019: Evaluate Time Memory

- [ ] Define temporal query use cases before adding a new memory type.
- [ ] Decide how valid time, observed time, and supersede history interact.
- [ ] Add Time Memory only after lifecycle and evaluation foundations are stable.

### PR-020: Design multi-tenant and multi-node operation

- [ ] Decide between tenant-local SQLite and a shared transactional database.
- [ ] Add a durable job queue and worker model.
- [ ] Add distributed locking or partitioned ownership.
- [ ] Add quotas, retention, deletion/export, audit, and compliance controls.
- [ ] Define horizontal scaling and disaster recovery targets.

## Recommended Discussion and Delivery Order

Discuss and implement in this order:

1. PR-000 L2 cross-session knowledge aggregation model
2. PR-001 write consistency and idempotency
3. PR-002 transactions and concurrency
4. PR-003 vector consistency
5. PR-004 LLM reliability
6. PR-005 LLM product contract
7. PR-006 migrations and recovery
8. PR-007 security and dependency upgrades
9. PR-008 storage scale
10. PR-010 observability
11. PR-011 CI and layered tests
12. PR-012 through PR-016 retrieval quality and release contract
13. PR-017 through PR-020 platform expansion

## Decision Log

Record each discussion outcome here before implementation begins.

| Item | Decision | Status |
| --- | --- | --- |
| PR-000 | ADR-0001 accepted: online appends Topics; offline L1 maintains Topic context plus internal fine-grained Components; offline L2 aggregates stabilized Components across sessions with traceability to Topic and Turn evidence | v2 Core implemented; indexing, migration tooling, and production hardening pending |
| PR-001 | Use `uid + source + eventId` for Turn idempotency; retain raw Turn on later semantic failure | Turn deduplication implemented; recoverable Buffer lifecycle pending |
