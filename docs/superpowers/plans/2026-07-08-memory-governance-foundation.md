# Memory Governance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first independently testable governance foundation from the memory governance spec: schema, correction records, correction API, durable discovery, and Recall freshness.

**Architecture:** Add a governance domain model and repository methods beside the existing layered repository, without changing L1/L2 semantic synthesis yet. Corrections are immutable evidence roots with explicit lifecycle sequence fields; schedulers and Recall derive work/freshness from durable statuses, not cross-lifecycle sequence comparisons.

**Tech Stack:** TypeScript, Fastify, Zod, better-sqlite3, Vitest.

---

## Scope

This plan implements Phase 1 of `docs/superpowers/specs/2026-07-07-memory-governance-reconciliation-design.md`.

Included:

- Governance types and SQLite schema.
- Idempotent Correction create/list/inspect.
- Target validation for Turn and L1 Component Corrections.
- L2 Statement target validation only for migrated Statement IDs once Task 2 adds legacy IDs.
- NamespaceChange rows and lifecycle sequence fields.
- Recall freshness metadata based on non-applied Corrections.
- Scheduler discovery queries for pending L1 and ready L2 work.

Deferred to a later plan:

- L1 Planner semantic handling of Corrections.
- L2 StatementOperation lineage synthesis and conflict validation.
- Bounded retrieval/context expansion.
- Cost telemetry.
- Full backup/restore migration tooling beyond additive in-process migration.

## File Structure

- Modify `src/domain/types.ts`: add governance types and extend L2 Statement shape compatibly.
- Modify `src/storage/database.ts`: additive schema/migration for governance tables, L1 component correction columns, L2 statement JSON defaults.
- Modify `src/storage/layered-repository.ts`: add correction CRUD, target lookup, namespace changes, freshness queries, scheduler discovery helpers.
- Modify `src/application/layered-memory-service.ts`: expose correction create/list/inspect and governance freshness in `recall()`.
- Modify `src/application/memory-service.ts`: add service interface wrappers for correction methods.
- Modify `src/server.ts`: add `/v1/corrections` endpoints and response/error mapping.
- Modify `src/application/layered-scheduler.ts`: discover pending/ready governance work through repository/service helpers.
- Modify `tests/v2-memory.test.ts`: add focused governance foundation tests.

---

### Task 1: Governance Types and API Shapes

**Files:**
- Modify: `src/domain/types.ts`
- Test: `tests/v2-memory.test.ts`

- [ ] **Step 1: Write the failing type-level behavior test**

Add this test near the top of `tests/v2-memory.test.ts`, after the `scope` constant:

```ts
it("exposes correction lifecycle sequence fields without cross-lifecycle watermarks", () => {
  const record = {
    id: "correction-1",
    eventId: "event-1",
    payloadHash: "hash",
    uid: scope.uid,
    agent: scope.agent,
    targetType: "turn",
    targetId: "turn-1",
    targetRevisionId: null,
    action: "replace",
    correctedContent: "corrected",
    reason: "manual correction",
    authority: "human_correction",
    status: "pending_l1",
    affectedSource: scope.source,
    affectedChannel: scope.channel,
    affectedSessionId: "session-1",
    createdSequence: 100,
    readySequence: null,
    appliedSequence: null,
    error: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    appliedAt: null
  } satisfies import("../src/domain/types.js").CorrectionRecord;

  expect(record.status).toBe("pending_l1");
  expect(record.createdSequence).toBe(100);
  expect(record.readySequence).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/v2-memory.test.ts -t "exposes correction lifecycle sequence fields"`

Expected: TypeScript/Vitest fails because `CorrectionRecord` is not exported.

- [ ] **Step 3: Add governance types**

Add to `src/domain/types.ts` after `OfflineRunStatus`:

```ts
export type EvidenceAuthority = "conversation" | "human_correction";
export type CorrectionTargetType = "turn" | "l1_component" | "l2_statement";
export type CorrectionAction = "retract" | "replace";
export type CorrectionStatus = "pending_l1" | "ready_l2" | "applied";
export type NamespaceChangeKind =
  | "l1_revision"
  | "l1_delete"
  | "correction_created"
  | "correction_ready"
  | "correction_applied";

export interface CorrectionRecord {
  id: string;
  eventId: string;
  payloadHash: string;
  uid: string;
  agent: string;
  targetType: CorrectionTargetType;
  targetId: string;
  targetRevisionId: string | null;
  action: CorrectionAction;
  correctedContent: string | null;
  reason: string;
  authority: "human_correction";
  status: CorrectionStatus;
  affectedSource: string | null;
  affectedChannel: string | null;
  affectedSessionId: string | null;
  createdSequence: number;
  readySequence: number | null;
  appliedSequence: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

export interface NamespaceChange {
  sequence: number;
  uid: string;
  agent: string;
  kind: NamespaceChangeKind;
  entityType: string;
  entityId: string;
  correctionId: string | null;
  createdAt: string;
}

export interface GovernanceFreshness {
  status: "current" | "pending_reconciliation";
  pendingCorrectionCount: number;
  latestGovernanceSequence: number;
  appliedGovernanceSequence: number;
}
```

Replace `L2Statement` with a backward-compatible shape:

```ts
export type StatementStatus = "supported" | "contested";

export type StatementEvidenceRef =
  | { kind: "component"; id: string }
  | { kind: "correction"; id: string };

export interface ConflictAssessment {
  summary: string;
  supportingEvidenceRefs: StatementEvidenceRef[];
  conflictingEvidenceRefs: StatementEvidenceRef[];
  alternatives: string[];
}

export interface L2Statement {
  id?: string;
  content: string;
  evidenceComponentIds: string[];
  evidenceCorrectionIds?: string[];
  semanticOrigin?: "derived";
  evidenceAuthority?: EvidenceAuthority;
  status?: StatementStatus;
  conflictAssessment?: ConflictAssessment | null;
  confidence: number;
  qualifier?: string;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/v2-memory.test.ts -t "exposes correction lifecycle sequence fields"`

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

---

### Task 2: Governance Schema and Deterministic Legacy Statement IDs

**Files:**
- Modify: `src/storage/database.ts`
- Test: `tests/v2-memory.test.ts`

- [ ] **Step 1: Write failing schema migration tests**

Append these tests after the existing migration test in `tests/v2-memory.test.ts`:

```ts
it("creates governance tables and L1 correction evidence columns", () => {
  const db = createDatabase(":memory:");
  const correctionColumns = db.pragma("table_info(correction_records)") as Array<{ name: string }>;
  const componentColumns = db.pragma("table_info(l1_components)") as Array<{ name: string }>;

  expect(correctionColumns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      "created_sequence",
      "ready_sequence",
      "applied_sequence",
      "affected_source",
      "affected_channel",
      "affected_session_id"
    ])
  );
  expect(componentColumns.map((column) => column.name)).toEqual(
    expect.arrayContaining(["evidence_authority", "evidence_correction_ids"])
  );
});

it("migrates legacy L2 statements with deterministic IDs and default governance fields", () => {
  const store = new MemoryRepository(createDatabase(":memory:"));
  const component = seedCanonicalComponent(store);
  const run = store.layered.runL2Aggregation(
    scope.uid,
    scope.agent,
    store.layered.getL1StableWatermark(scope.uid, scope.agent),
    {
      operations: [],
      desiredMemberships: [{ componentIds: [component.id] }],
      retireAggregateIds: []
    },
    [
      {
        membership: { componentIds: [component.id] },
        content: {
          aggregateType: "technical_topic",
          canonicalTitle: "Legacy aggregate",
          aliases: [],
          externalKeys: {},
          labels: [],
          summary: "Legacy summary",
          facts: [{ content: "Legacy fact", evidenceComponentIds: [component.id], confidence: 0.9 }],
          decisions: [],
          constraints: [],
          openQuestions: []
        },
        provenance: {
          promptVersion: "test",
          schemaVersion: "v2",
          reason: "test",
          confidence: 0.9
        }
      }
    ]
  );
  expect(run.status).toBe("success");

  const view = store.layered.listL2AggregateViews(scope.uid, scope.agent)[0];
  const statement = view.revision.facts[0];
  expect(statement.id).toMatch(/[0-9a-f-]{36}/);
  expect(statement.semanticOrigin).toBe("derived");
  expect(statement.evidenceAuthority).toBe("conversation");
  expect(statement.evidenceCorrectionIds).toEqual([]);
  expect(statement.status).toBe("supported");
  expect(statement.conflictAssessment).toBeNull();
});
```

Add this helper near the bottom of the file:

```ts
function seedCanonicalComponent(store: MemoryRepository) {
  const turn = store.createTurn({
    eventId: `turn-${Math.random()}`,
    sessionId: "session-1",
    role: "user",
    content: "seed",
    ...scope
  });
  const segment = store.createTopicSegment({
    sessionId: "session-1",
    title: "Seed",
    summary: "Seed",
    status: "complete",
    confidence: 1,
    turnIds: [turn.id],
    reason: "seed",
    fingerprint: `seed-${Math.random()}`,
    projectMemoryIds: [],
    ...scope
  });
  const provisional = store.layered.appendProvisionalTopic(segment, {
    promptVersion: "test",
    schemaVersion: "v2",
    reason: "seed",
    confidence: 1
  });
  store.layered.runL1Maintenance(
    scope,
    "session-1",
    new Date().toISOString(),
    {
      items: [
        {
          operation: "keep",
          sourceTopicIds: [provisional.topic.id],
          sourceTurnIds: [turn.id],
          title: "Seed",
          summary: "Seed",
          components: [{ content: "Seed component", evidenceTurnIds: [turn.id], confidence: 1 }],
          reason: "seed",
          confidence: 1
        }
      ]
    },
    { promptVersion: "test", schemaVersion: "v2" }
  );
  return store.layered.listStableComponents(scope.uid, scope.agent)[0];
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/v2-memory.test.ts -t "governance tables|legacy L2 statements"`

Expected: FAIL because schema columns and default statement fields are missing.

- [ ] **Step 3: Implement schema additions**

In `src/storage/database.ts`, add `ensureGovernanceSchema(db);` before `ensureIndexes(db);` in `runMigrations()`.

Add:

```ts
function ensureGovernanceSchema(db: Database.Database): void {
  const componentColumns = db.pragma("table_info(l1_components)") as Array<{ name: string }>;
  if (!componentColumns.some((column) => column.name === "evidence_authority")) {
    db.exec("alter table l1_components add column evidence_authority text not null default 'conversation'");
  }
  if (!componentColumns.some((column) => column.name === "evidence_correction_ids")) {
    db.exec("alter table l1_components add column evidence_correction_ids text not null default '[]'");
  }
  db.exec(`
    create table if not exists namespace_changes (
      sequence integer primary key autoincrement,
      uid text not null,
      agent text not null,
      kind text not null,
      entity_type text not null,
      entity_id text not null,
      correction_id text,
      created_at text not null
    );

    create table if not exists correction_records (
      id text primary key,
      event_id text not null,
      payload_hash text not null,
      uid text not null,
      agent text not null,
      target_type text not null,
      target_id text not null,
      target_revision_id text,
      action text not null,
      corrected_content text,
      reason text not null,
      authority text not null,
      status text not null,
      affected_source text,
      affected_channel text,
      affected_session_id text,
      created_sequence integer not null,
      ready_sequence integer,
      applied_sequence integer,
      error text,
      created_at text not null,
      updated_at text not null,
      applied_at text,
      unique(uid, agent, event_id)
    );

    create table if not exists statement_lineage_edges (
      id text primary key,
      uid text not null,
      agent text not null,
      from_revision_id text not null,
      from_statement_id text not null,
      to_revision_id text,
      to_statement_id text,
      operation text not null,
      created_at text not null
    );

    create table if not exists l2_checkpoints (
      uid text not null,
      agent text not null,
      l1_stable_watermark integer not null,
      governance_watermark integer not null,
      run_id text not null,
      prompt_version text not null,
      schema_version text not null,
      updated_at text not null,
      primary key(uid, agent)
    );
  `);
}
```

Extend `ensureIndexes()` with:

```sql
create index if not exists idx_corrections_status_created
  on correction_records (uid, agent, status, created_sequence);
create index if not exists idx_corrections_status_ready
  on correction_records (uid, agent, status, ready_sequence);
create index if not exists idx_corrections_l1_scope
  on correction_records (uid, affected_source, agent, affected_channel, affected_session_id, status);
create index if not exists idx_corrections_target_namespace
  on correction_records (uid, agent, target_type, target_id);
create index if not exists idx_namespace_changes_namespace_sequence
  on namespace_changes (uid, agent, sequence);
create index if not exists idx_statement_lineage_from
  on statement_lineage_edges (uid, agent, from_revision_id, from_statement_id);
create index if not exists idx_statement_lineage_to
  on statement_lineage_edges (uid, agent, to_revision_id, to_statement_id);
```

- [ ] **Step 4: Normalize L2 statement JSON on read/write**

In `src/storage/layered-repository.ts`, add a helper:

```ts
function normalizeL2Statement(statement: L2Statement, context: { uid: string; agent: string; aggregateId: string; revisionId: string; category: string; index: number }): L2Statement {
  return {
    id: statement.id ?? legacyStatementId(context),
    content: statement.content,
    evidenceComponentIds: statement.evidenceComponentIds,
    evidenceCorrectionIds: statement.evidenceCorrectionIds ?? [],
    semanticOrigin: statement.semanticOrigin ?? "derived",
    evidenceAuthority: statement.evidenceAuthority ?? "conversation",
    status: statement.status ?? "supported",
    conflictAssessment: statement.conflictAssessment ?? null,
    confidence: statement.confidence,
    qualifier: statement.qualifier
  };
}

function legacyStatementId(input: { uid: string; agent: string; aggregateId: string; revisionId: string; category: string; index: number }): string {
  return digest([
    "omm:legacy-statement:v1",
    input.uid,
    input.agent,
    input.aggregateId,
    input.revisionId,
    input.category,
    String(input.index)
  ]).slice(0, 36);
}
```

Then update `mapL2Revision(row)` to normalize every statement category by passing `row.aggregate_id`, `row.id`, and array indexes. Use the existing `digest()` helper for deterministic IDs.

- [ ] **Step 5: Run migration tests**

Run: `npm test -- tests/v2-memory.test.ts -t "governance tables|legacy L2 statements"`

Expected: PASS.

---

### Task 3: Correction Repository Create/List/Inspect

**Files:**
- Modify: `src/storage/layered-repository.ts`
- Modify: `src/domain/types.ts`
- Test: `tests/v2-memory.test.ts`

- [ ] **Step 1: Write failing repository tests**

Add:

```ts
it("creates an idempotent Turn correction with complete L1 scope and namespace changes", () => {
  const store = new MemoryRepository(createDatabase(":memory:"));
  const turn = store.createTurn({
    eventId: "turn-correction-target",
    sessionId: "session-1",
    role: "user",
    content: "old fact",
    ...scope
  });

  const created = store.layered.createCorrection({
    eventId: "correction-event-1",
    uid: scope.uid,
    agent: scope.agent,
    source: scope.source,
    channel: scope.channel,
    sessionId: "session-1",
    targetType: "turn",
    targetId: turn.id,
    targetRevisionId: null,
    action: "replace",
    correctedContent: "new fact",
    reason: "manual correction"
  });
  const repeated = store.layered.createCorrection({
    eventId: "correction-event-1",
    uid: scope.uid,
    agent: scope.agent,
    source: scope.source,
    channel: scope.channel,
    sessionId: "session-1",
    targetType: "turn",
    targetId: turn.id,
    targetRevisionId: null,
    action: "replace",
    correctedContent: "new fact",
    reason: "manual correction"
  });

  expect(repeated.id).toBe(created.id);
  expect(created.status).toBe("pending_l1");
  expect(created.affectedSource).toBe(scope.source);
  expect(created.affectedChannel).toBe(scope.channel);
  expect(created.affectedSessionId).toBe("session-1");
  expect(created.createdSequence).toBeGreaterThan(0);
  expect(created.readySequence).toBeNull();
});

it("rejects conflicting idempotency event reuse", () => {
  const store = new MemoryRepository(createDatabase(":memory:"));
  const turn = store.createTurn({
    eventId: "turn-conflict-target",
    sessionId: "session-1",
    role: "user",
    content: "old fact",
    ...scope
  });
  store.layered.createCorrection({
    eventId: "correction-event-conflict",
    uid: scope.uid,
    agent: scope.agent,
    source: scope.source,
    channel: scope.channel,
    sessionId: "session-1",
    targetType: "turn",
    targetId: turn.id,
    targetRevisionId: null,
    action: "replace",
    correctedContent: "new fact",
    reason: "manual correction"
  });

  expect(() =>
    store.layered.createCorrection({
      eventId: "correction-event-conflict",
      uid: scope.uid,
      agent: scope.agent,
      source: scope.source,
      channel: scope.channel,
      sessionId: "session-1",
      targetType: "turn",
      targetId: turn.id,
      targetRevisionId: null,
      action: "replace",
      correctedContent: "different fact",
      reason: "manual correction"
    })
  ).toThrow("Correction idempotency conflict");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/v2-memory.test.ts -t "Turn correction|idempotency event reuse"`

Expected: FAIL because `createCorrection` does not exist.

- [ ] **Step 3: Add correction input types**

In `src/domain/types.ts`, add:

```ts
export interface CreateCorrectionInput {
  eventId: string;
  uid: string;
  agent: string;
  source?: string;
  channel?: string;
  sessionId?: string;
  targetType: CorrectionTargetType;
  targetId: string;
  targetRevisionId: string | null;
  action: CorrectionAction;
  correctedContent: string | null;
  reason: string;
}
```

- [ ] **Step 4: Implement repository methods**

In `LayeredMemoryRepository`, add public methods:

```ts
createCorrection(input: CreateCorrectionInput): CorrectionRecord {
  validateCorrectionAction(input);
  const target = this.resolveCorrectionTarget(input);
  const payloadHash = digest([
    input.uid,
    input.agent,
    input.targetType,
    input.targetId,
    input.targetRevisionId ?? "",
    target.affectedSource ?? "",
    target.affectedChannel ?? "",
    target.affectedSessionId ?? "",
    input.action,
    input.correctedContent ?? "",
    input.reason,
    "human_correction"
  ]);
  const existing = this.db
    .prepare("select * from correction_records where uid = ? and agent = ? and event_id = ?")
    .get(input.uid, input.agent, input.eventId) as CorrectionRow | undefined;
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new Error("Correction idempotency conflict");
    return mapCorrection(existing);
  }
  const nowValue = now();
  const id = nanoid();
  return this.db.transaction(() => {
    const created = this.insertNamespaceChange(input.uid, input.agent, "correction_created", input.targetType, id, id, nowValue);
    const initialStatus = input.targetType === "l2_statement" ? "ready_l2" : "pending_l1";
    const ready = initialStatus === "ready_l2"
      ? this.insertNamespaceChange(input.uid, input.agent, "correction_ready", input.targetType, id, id, nowValue)
      : null;
    this.db
      .prepare(
        `insert into correction_records
        (id, event_id, payload_hash, uid, agent, target_type, target_id, target_revision_id, action, corrected_content,
         reason, authority, status, affected_source, affected_channel, affected_session_id, created_sequence, ready_sequence,
         applied_sequence, error, created_at, updated_at, applied_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human_correction', ?, ?, ?, ?, ?, ?, null, null, ?, ?, null)`
      )
      .run(
        id,
        input.eventId,
        payloadHash,
        input.uid,
        input.agent,
        input.targetType,
        input.targetId,
        input.targetRevisionId,
        input.action,
        input.correctedContent,
        input.reason,
        initialStatus,
        target.affectedSource,
        target.affectedChannel,
        target.affectedSessionId,
        created,
        ready,
        nowValue,
        nowValue
      );
    return this.getCorrection(input.uid, input.agent, id)!;
  })();
}

getCorrection(uid: string, agent: string, id: string): CorrectionRecord | null {
  const row = this.db.prepare("select * from correction_records where id = ? and uid = ? and agent = ?").get(id, uid, agent) as CorrectionRow | undefined;
  return row ? mapCorrection(row) : null;
}

listCorrections(filter: { uid: string; agent: string; status?: CorrectionStatus; limit?: number }): CorrectionRecord[] {
  const limit = filter.limit ?? 20;
  const rows = filter.status
    ? this.db.prepare("select * from correction_records where uid = ? and agent = ? and status = ? order by created_sequence asc limit ?").all(filter.uid, filter.agent, filter.status, limit)
    : this.db.prepare("select * from correction_records where uid = ? and agent = ? order by created_sequence asc limit ?").all(filter.uid, filter.agent, limit);
  return (rows as CorrectionRow[]).map(mapCorrection);
}
```

Add helpers for `validateCorrectionAction`, `resolveCorrectionTarget`, `insertNamespaceChange`, `CorrectionRow`, and `mapCorrection` using the exact spec field names.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/v2-memory.test.ts -t "Turn correction|idempotency event reuse"`

Expected: PASS.

---

### Task 4: Correction API Endpoints

**Files:**
- Modify: `src/application/memory-service.ts`
- Modify: `src/server.ts`
- Test: `tests/memory.test.ts`

- [ ] **Step 1: Write failing API tests**

Add to `tests/memory.test.ts` in the server section:

```ts
it("creates and inspects corrections through scoped v1 endpoints", async () => {
  const store = new MemoryRepository(createDatabase(":memory:"));
  const service = createTestMemoryService(store);
  const app = buildServer(service);
  const turn = store.createTurn({
    eventId: "api-turn-target",
    sessionId: "session-1",
    role: "user",
    content: "old fact",
    uid: "u1",
    source: "chat",
    agent: "codex",
    channel: "default",
    metadata: {}
  });

  const create = await app.inject({
    method: "POST",
    url: "/v1/corrections",
    payload: {
      eventId: "api-correction-1",
      uid: "u1",
      agent: "codex",
      source: "chat",
      channel: "default",
      sessionId: "session-1",
      targetType: "turn",
      targetId: turn.id,
      targetRevisionId: null,
      action: "replace",
      correctedContent: "new fact",
      reason: "manual correction"
    }
  });
  expect(create.statusCode).toBe(200);
  const body = create.json();
  expect(body.correction.status).toBe("pending_l1");

  const inspect = await app.inject({
    method: "GET",
    url: `/v1/corrections/${body.correction.id}?uid=u1&agent=codex`
  });
  expect(inspect.statusCode).toBe(200);
  expect(inspect.json().correction.id).toBe(body.correction.id);

  const hidden = await app.inject({
    method: "GET",
    url: `/v1/corrections/${body.correction.id}?uid=other&agent=codex`
  });
  expect(hidden.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/memory.test.ts -t "creates and inspects corrections"`

Expected: FAIL because endpoints/service methods do not exist.

- [ ] **Step 3: Add service methods**

Extend `MemoryService` in `src/application/memory-service.ts`:

```ts
createCorrection(input: CreateCorrectionInput): { correction: CorrectionRecord };
listCorrections(input: { uid: string; agent: string; status?: CorrectionStatus; limit?: number }): { corrections: CorrectionRecord[] };
getCorrection(input: { uid: string; agent: string; id: string }): { correction: CorrectionRecord };
```

Implement wrappers in `createMemoryService()`:

```ts
createCorrection(input) {
  return { correction: store.layered.createCorrection(input) };
},
listCorrections(input) {
  return { corrections: store.layered.listCorrections(input) };
},
getCorrection(input) {
  const correction = store.layered.getCorrection(input.uid, input.agent, input.id);
  if (!correction) throw new Error("Correction not found");
  return { correction };
},
```

- [ ] **Step 4: Add Fastify routes**

In `src/server.ts`, add Zod schemas:

```ts
const correctionCreateSchema = z.object({
  eventId: z.string().min(1),
  uid: z.string().min(1),
  agent: z.string().min(1),
  source: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  targetType: z.enum(["turn", "l1_component", "l2_statement"]),
  targetId: z.string().min(1),
  targetRevisionId: z.string().min(1).nullable(),
  action: z.enum(["retract", "replace"]),
  correctedContent: z.string().min(1).nullable(),
  reason: z.string().min(1)
});

const correctionQuerySchema = z.object({
  uid: z.string().min(1),
  agent: z.string().min(1),
  status: z.enum(["pending_l1", "ready_l2", "applied"]).optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});
```

Add routes before `/v1/recall`:

```ts
app.post("/v1/corrections", async (request, reply) => {
  const parsed = correctionCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  try {
    return service.createCorrection(parsed.data);
  } catch (error) {
    return mapCorrectionError(reply, error);
  }
});

app.get("/v1/corrections", async (request, reply) => {
  const parsed = correctionQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  return service.listCorrections(parsed.data);
});

app.get("/v1/corrections/:id", async (request, reply) => {
  const params = request.params as { id: string };
  const parsed = z.object({ uid: z.string().min(1), agent: z.string().min(1) }).safeParse(request.query);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  try {
    return service.getCorrection({ ...parsed.data, id: params.id });
  } catch {
    return reply.status(404).send({ error: "not found" });
  }
});
```

Add:

```ts
function mapCorrectionError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error";
  if (message.includes("idempotency conflict")) return reply.status(409).send({ error: message });
  if (message.includes("stale")) return reply.status(409).send({ error: message, retryable: true });
  if (message.includes("not found") || message.includes("outside namespace")) return reply.status(404).send({ error: "not found" });
  return reply.status(400).send({ error: message });
}
```

- [ ] **Step 5: Run API test**

Run: `npm test -- tests/memory.test.ts -t "creates and inspects corrections"`

Expected: PASS.

---

### Task 5: Recall Freshness and Scheduler Discovery

**Files:**
- Modify: `src/storage/layered-repository.ts`
- Modify: `src/application/layered-memory-service.ts`
- Modify: `src/application/layered-scheduler.ts`
- Test: `tests/v2-memory.test.ts`

- [ ] **Step 1: Write failing freshness and discovery tests**

Add:

```ts
it("reports pending reconciliation whenever any non-applied correction exists below the applied watermark", async () => {
  const store = new MemoryRepository(createDatabase(":memory:"));
  const pendingTurn = store.createTurn({
    eventId: "freshness-turn",
    sessionId: "session-1",
    role: "user",
    content: "old fact",
    ...scope
  });
  const pending = store.layered.createCorrection({
    eventId: "freshness-pending",
    uid: scope.uid,
    agent: scope.agent,
    source: scope.source,
    channel: scope.channel,
    sessionId: "session-1",
    targetType: "turn",
    targetId: pendingTurn.id,
    targetRevisionId: null,
    action: "replace",
    correctedContent: "new fact",
    reason: "manual"
  });
  store.layered.forceAppliedGovernanceWatermarkForTest(scope.uid, scope.agent, pending.createdSequence + 100);

  const service = new LayeredMemoryService(store, {
    l1Planner: { async plan() { return { items: [] }; } },
    l2Planner: { async plan() { return { operations: [], desiredMemberships: [], retireAggregateIds: [] }; } },
    l2Synthesizer: { async synthesize() { throw new Error("not used"); } },
    recallPlanner: { async plan() { return { shouldUseMemory: false, selectedIds: [], reason: "none" }; } }
  });

  const recall = await service.recall({ uid: scope.uid, agent: scope.agent, query: "anything" });
  expect(recall.freshness).toMatchObject({
    status: "pending_reconciliation",
    pendingCorrectionCount: 1
  });
});

it("discovers pending L1 sessions and ready L2 namespaces from correction status", () => {
  const store = new MemoryRepository(createDatabase(":memory:"));
  const turn = store.createTurn({
    eventId: "discovery-turn",
    sessionId: "session-1",
    role: "user",
    content: "old fact",
    ...scope
  });
  store.layered.createCorrection({
    eventId: "discovery-pending",
    uid: scope.uid,
    agent: scope.agent,
    source: scope.source,
    channel: scope.channel,
    sessionId: "session-1",
    targetType: "turn",
    targetId: turn.id,
    targetRevisionId: null,
    action: "replace",
    correctedContent: "new fact",
    reason: "manual"
  });

  expect(store.layered.listPendingL1CorrectionSessions()).toEqual([
    { scope: { ...scope }, sessionId: "session-1" }
  ]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/v2-memory.test.ts -t "pending reconciliation|discovers pending L1"`

Expected: FAIL because freshness and discovery helpers do not exist.

- [ ] **Step 3: Implement repository helpers**

Add to `LayeredMemoryRepository`:

```ts
getGovernanceFreshness(uid: string, agent: string): GovernanceFreshness {
  const pending = this.db
    .prepare("select * from correction_records where uid = ? and agent = ? and status != 'applied'")
    .all(uid, agent) as CorrectionRow[];
  const latestRow = this.db
    .prepare(
      `select max(
        case
          when status = 'pending_l1' then created_sequence
          when status = 'ready_l2' then ready_sequence
          else applied_sequence
        end
      ) as latest from correction_records where uid = ? and agent = ?`
    )
    .get(uid, agent) as { latest: number | null };
  const checkpoint = this.db
    .prepare("select governance_watermark from l2_checkpoints where uid = ? and agent = ?")
    .get(uid, agent) as { governance_watermark: number } | undefined;
  return {
    status: pending.length > 0 ? "pending_reconciliation" : "current",
    pendingCorrectionCount: pending.length,
    latestGovernanceSequence: latestRow.latest ?? 0,
    appliedGovernanceSequence: checkpoint?.governance_watermark ?? 0
  };
}

listPendingL1CorrectionSessions(): Array<{ scope: Scope; sessionId: string }> {
  const rows = this.db
    .prepare(
      `select distinct uid, affected_source, agent, affected_channel, affected_session_id
       from correction_records
       where status = 'pending_l1'
         and affected_source is not null
         and affected_channel is not null
         and affected_session_id is not null
       order by created_sequence asc`
    )
    .all() as Array<{ uid: string; affected_source: string; agent: string; affected_channel: string; affected_session_id: string }>;
  return rows.map((row) => ({
    scope: { uid: row.uid, source: row.affected_source, agent: row.agent, channel: row.affected_channel, metadata: {} },
    sessionId: row.affected_session_id
  }));
}

listReadyL2CorrectionNamespaces(): Array<{ uid: string; agent: string }> {
  const rows = this.db
    .prepare("select distinct uid, agent from correction_records where status = 'ready_l2' order by ready_sequence asc")
    .all() as Array<{ uid: string; agent: string }>;
  return rows;
}
```

Add this test-only helper to `LayeredMemoryRepository`:

```ts
forceAppliedGovernanceWatermarkForTest(uid: string, agent: string, watermark: number): void {
  this.db
    .prepare(
      `insert into l2_checkpoints (uid, agent, l1_stable_watermark, governance_watermark, run_id, prompt_version, schema_version, updated_at)
       values (?, ?, 0, ?, 'test', 'test', 'test', ?)
       on conflict(uid, agent) do update set governance_watermark = excluded.governance_watermark`
    )
    .run(uid, agent, watermark, now());
}
```

- [ ] **Step 4: Expose freshness in recall**

Change `LayeredMemoryService.recall()` return type to include:

```ts
usagePolicy: "reference_only";
freshness: GovernanceFreshness;
```

Return:

```ts
return {
  usagePolicy: "reference_only",
  freshness: this.store.layered.getGovernanceFreshness(input.uid, input.agent),
  shouldUseMemory: plan.shouldUseMemory && selected.length > 0,
  reason: plan.reason,
  results: selected
};
```

- [ ] **Step 5: Update scheduler discovery**

In `src/application/layered-scheduler.ts`, update `collectL1Sessions()` to include `service.listPendingL1CorrectionSessions()` results. Add `listPendingL1CorrectionSessions()` and `listReadyL2CorrectionNamespaces()` to `MemoryService`.

Update `collectL2Namespaces()` to include ready L2 correction namespaces.

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/v2-memory.test.ts -t "pending reconciliation|discovers pending L1"`

Expected: PASS.

---

## Final Verification

- [ ] Run focused governance tests:

```bash
npm test -- tests/v2-memory.test.ts -t "correction|governance|pending reconciliation|legacy L2 statements"
```

Expected: all selected tests pass.

- [ ] Run full test suite:

```bash
npm test
```

Expected: all tests pass.

- [ ] Run typecheck:

```bash
npm run typecheck
```

Expected: exit 0.

## Plan Self-Review

Spec requirements covered by this Phase 1 plan:

- Explicit Correction Records and idempotent create/list/inspect.
- Complete L1 scope pinning.
- Lifecycle sequence fields without cross-lifecycle watermark comparisons.
- NamespaceChange rows.
- Additive schema for governance tables and L1 correction evidence.
- Recall freshness based on non-applied Corrections.
- Scheduler rediscovery for pending L1 and ready L2 governance work.
- Deterministic legacy Statement IDs as a prerequisite for later L2 Statement correction work.

Intentional gaps for later plans:

- L1 semantic reconciliation of Corrections.
- L2 StatementOperation synthesis and lineage persistence.
- Conflict validation.
- Bounded candidate retrieval and `needs_context`.
- Cost telemetry and budget policy response schema.
