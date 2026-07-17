import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryService, type MemoryServiceOptions } from "../src/application/memory-service.js";
import { LayeredMemoryService } from "../src/application/layered-memory-service.js";
import { startLayeredSchedulers } from "../src/application/layered-scheduler.js";
import { RuleBasedMemoryCompressor } from "../src/domain/dreaming.js";
import { RuleBasedMemoryResolver } from "../src/domain/resolver.js";
import { RuleBasedTopicBoundaryDetector } from "../src/domain/topic-boundary.js";
import { RuleBasedTopicMemoryGenerator } from "../src/domain/topic-memory.js";
import { SlidingTopicBuilder } from "../src/domain/topics.js";
import { buildServer } from "../src/server.js";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";
import type { MemoryStore } from "../src/storage/store.js";

const scope = { uid: "user-1", source: "chat", agent: "codex", channel: "default", metadata: {} };
let seedCounter = 0;

describe("v2 layered memory", () => {
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

  it("migrates legacy mis columns to uid without losing turns", () => {
    const path = join(mkdtempSync(join(tmpdir(), "oh-my-memory-v2-")), "legacy.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      create table conversation_turns (
        id text primary key,
        session_id text not null,
        role text not null,
        content text not null,
        mis text not null,
        source text not null,
        agent text not null,
        channel text not null,
        metadata text not null,
        created_at text not null
      )
    `);
    legacy
      .prepare(
        "insert into conversation_turns (id, session_id, role, content, mis, source, agent, channel, metadata, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("legacy-turn", "s1", "user", "legacy", "legacy-user", "import", "agent", "default", "{}", "2026-01-01T00:00:00.000Z");
    legacy.close();

    const migrated = createDatabase(path);
    const columns = migrated.pragma("table_info(conversation_turns)") as Array<{ name: string }>;
    const row = migrated.prepare("select uid, event_id from conversation_turns where id = ?").get("legacy-turn") as {
      uid: string;
      event_id: string;
    };
    expect(columns.map((column) => column.name)).toContain("uid");
    expect(columns.map((column) => column.name)).not.toContain("mis");
    expect(row).toEqual({ uid: "legacy-user", event_id: "legacy-turn" });
    migrated.close();
  });

  it("creates governance tables and L1 correction evidence columns", () => {
    const db = createDatabase(":memory:");
    const correctionColumns = db.pragma("table_info(correction_records)") as Array<{ name: string }>;
    const componentColumns = db.pragma("table_info(l1_components)") as Array<{ name: string }>;
    const l1RunColumns = db.pragma("table_info(l1_maintenance_runs)") as Array<{ name: string }>;
    const l2RunColumns = db.pragma("table_info(l2_aggregation_runs)") as Array<{ name: string }>;

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
    expect(l1RunColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["input_snapshot_hash", "run_mode", "caller_idempotency_key", "prompt_version", "schema_version"])
    );
    expect(l2RunColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "source_governance_watermark",
        "input_snapshot_hash",
        "run_mode",
        "caller_idempotency_key",
        "prompt_version",
        "schema_version",
        "context_expansion_rounds",
        "context_request_json"
      ])
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

  it("creates, lists, and inspects Corrections through scoped API endpoints", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const app = buildServer(createTestMemoryService(store));
    const turn = store.createTurn({
      eventId: "api-turn-correction-target",
      sessionId: "session-1",
      role: "user",
      content: "old fact",
      ...scope
    });

    const create = await app.inject({
      method: "POST",
      url: "/v1/corrections",
      payload: {
        eventId: "api-correction-event-1",
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
      }
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().correction).toMatchObject({
      eventId: "api-correction-event-1",
      uid: scope.uid,
      agent: scope.agent,
      status: "pending_l1",
      affectedSessionId: "session-1"
    });

    const list = await app.inject({
      method: "GET",
      url: `/v1/corrections?uid=${scope.uid}&agent=${scope.agent}&status=pending_l1`
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().corrections.map((correction: { id: string }) => correction.id)).toEqual([create.json().correction.id]);

    const inspect = await app.inject({
      method: "GET",
      url: `/v1/corrections/${create.json().correction.id}?uid=${scope.uid}&agent=${scope.agent}`
    });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json().correction.id).toBe(create.json().correction.id);

    const crossNamespace = await app.inject({
      method: "GET",
      url: `/v1/corrections/${create.json().correction.id}?uid=other-user&agent=${scope.agent}`
    });
    expect(crossNamespace.statusCode).toBe(404);

    await app.close();
  });

  it("maps Correction API validation and unknown-target errors without leaking namespaces", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const app = buildServer(createTestMemoryService(store));

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/corrections",
      payload: {
        eventId: "invalid-correction",
        uid: scope.uid,
        agent: scope.agent,
        source: scope.source,
        channel: scope.channel,
        sessionId: "session-1",
        targetType: "turn",
        targetId: "missing-turn",
        targetRevisionId: null,
        action: "replace",
        correctedContent: null,
        reason: "manual correction"
      }
    });
    expect(invalid.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "POST",
      url: "/v1/corrections",
      payload: {
        eventId: "unknown-correction",
        uid: scope.uid,
        agent: scope.agent,
        source: scope.source,
        channel: scope.channel,
        sessionId: "session-1",
        targetType: "turn",
        targetId: "missing-turn",
        targetRevisionId: null,
        action: "retract",
        correctedContent: null,
        reason: "manual correction"
      }
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "Correction target not found" });

    await app.close();
  });

  it("reports pending reconciliation for any non-applied Correction regardless of checkpoint watermark", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const turn = store.createTurn({
      eventId: "freshness-turn",
      sessionId: "session-1",
      role: "user",
      content: "old fact",
      ...scope
    });
    const correction = store.layered.createCorrection({
      eventId: "freshness-pending",
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
    store.layered.upsertL2Checkpoint(scope.uid, scope.agent, 0, correction.createdSequence + 200, "checkpoint-run");

    const service = new LayeredMemoryService(store, {
      l1Planner: { plan: async () => ({ items: [] }) },
      l2Planner: { plan: async () => ({ operations: [], desiredMemberships: [], retireAggregateIds: [] }) },
      l2Synthesizer: {
        synthesize: async () => {
          throw new Error("not used");
        }
      },
      recallPlanner: {
        plan: async () => ({ shouldUseMemory: false, selectedIds: [], reason: "no candidates" })
      }
    });
    const recall = await service.recall({ uid: scope.uid, agent: scope.agent, query: "fact" });

    expect(recall.freshness).toMatchObject({
      status: "pending_reconciliation",
      pendingCorrectionCount: 1,
      latestGovernanceSequence: correction.createdSequence,
      appliedGovernanceSequence: correction.createdSequence + 200
    });
  });

  it("discovers L1 and L2 scheduler work from durable Correction statuses", async () => {
    const l1Runs: string[] = [];
    const l2Runs: string[] = [];
    const l3Runs: string[] = [];
    const schedulers = startLayeredSchedulers(
      {
        listL1Topics: () => [
          {
            topic: { ...scope, id: "topic", sessionId: "session-1", status: "active", metadata: {} },
            revision: { status: "canonical" },
            components: [],
            sourceSegmentStatus: "complete"
          }
        ],
        listPendingL1CorrectionSessions: () => [{ scope, sessionId: "session-1" }],
        listReadyL2CorrectionNamespaces: () => [{ uid: scope.uid, agent: scope.agent }],
        listDueL2Namespaces: () => [{ uid: scope.uid, agent: scope.agent }],
        listDueL3Namespaces: () => [{ uid: scope.uid, agent: scope.agent }],
        runL1Maintenance: async (_scope: typeof scope, sessionId: string) => {
          l1Runs.push(sessionId);
          return { run: null, topics: [] };
        },
        runL2Aggregation: async (uid: string, agent: string) => {
          l2Runs.push(`${uid}/${agent}`);
          return { run: null, aggregates: [] };
        },
        runL3ProfileBuild: async (uid: string, agent: string) => {
          l3Runs.push(`${uid}/${agent}`);
          return { createdOrUpdated: [], rejected: [] };
        }
      } as never,
      {
        l1Enabled: false,
        l1IntervalMs: 60_000,
        l2Enabled: false,
        l2IntervalMs: 60_000,
        l3Enabled: false,
        l3IntervalMs: 60_000
      }
    );

    await expect(schedulers.runL1Once()).resolves.toMatchObject({ sessionsRun: 1, errors: [] });
    await expect(schedulers.runL2Once()).resolves.toMatchObject({ namespacesRun: 1, errors: [] });
    await expect(schedulers.runL3Once()).resolves.toMatchObject({ namespacesRun: 1, errors: [] });
    expect(l1Runs).toEqual(["session-1"]);
    expect(l2Runs).toEqual([`${scope.uid}/${scope.agent}`]);
    expect(l3Runs).toEqual([`${scope.uid}/${scope.agent}`]);
    schedulers.stop();
  });

  it("requires L1 plans to handle all pending Corrections before marking them ready", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const turn = store.createTurn({
      eventId: "l1-correction-turn",
      sessionId: "session-1",
      role: "user",
      content: "old fact",
      ...scope
    });
    const segment = store.createTopicSegment({
      sessionId: "session-1",
      title: "Correction topic",
      summary: "Correction topic",
      status: "complete",
      confidence: 0.9,
      turnIds: [turn.id],
      reason: "seed",
      fingerprint: "l1-correction-topic",
      projectMemoryIds: [],
      ...scope
    });
    const correction = store.layered.createCorrection({
      eventId: "l1-correction",
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
    const service = new LayeredMemoryService(store, {
      l1Planner: {
        async plan(input) {
          expect(input.corrections.map((item) => item.id)).toEqual([correction.id]);
          return {
            handledCorrectionIds: [],
            items: [
              {
                operation: "keep",
                sourceTopicIds: [input.topics[0].topic.id],
                sourceTurnIds: [turn.id],
                title: "Correction topic",
                summary: "Correction topic",
                components: [{ content: "new fact", evidenceTurnIds: [turn.id], evidenceCorrectionIds: [correction.id], confidence: 0.9 }],
                reason: "test",
                confidence: 0.9
              }
            ]
          };
        }
      },
      l2Planner: { async plan() { return { operations: [], desiredMemberships: [], retireAggregateIds: [] }; } },
      l2Synthesizer: {
        async synthesize() {
          throw new Error("not used");
        }
      },
      recallPlanner: { async plan() { return { shouldUseMemory: false, selectedIds: [], reason: "test" }; } }
    });
    service.appendProvisionalTopic(segment);

    await expect(service.runL1Maintenance(scope, "session-1")).rejects.toThrow("L1 plan omitted pending Correction");
    expect(store.layered.getCorrection(scope.uid, scope.agent, correction.id)?.status).toBe("pending_l1");

    const successful = new LayeredMemoryService(store, {
      l1Planner: {
        async plan(input) {
          return {
            handledCorrectionIds: [correction.id],
            items: [
              {
                operation: "keep",
                sourceTopicIds: [input.topics[0].topic.id],
                sourceTurnIds: [turn.id],
                title: "Correction topic",
                summary: "Correction topic",
                components: [{ content: "new fact", evidenceTurnIds: [turn.id], evidenceCorrectionIds: [correction.id], confidence: 0.9 }],
                reason: "test",
                confidence: 0.9
              }
            ]
          };
        }
      },
      l2Planner: { async plan() { return { operations: [], desiredMemberships: [], retireAggregateIds: [] }; } },
      l2Synthesizer: {
        async synthesize() {
          throw new Error("not used");
        }
      },
      recallPlanner: { async plan() { return { shouldUseMemory: false, selectedIds: [], reason: "test" }; } }
    });
    await expect(successful.runL1Maintenance(scope, "session-1")).resolves.toMatchObject({ run: { status: "success" } });
    const ready = store.layered.getCorrection(scope.uid, scope.agent, correction.id)!;
    expect(ready.status).toBe("ready_l2");
    expect(ready.readySequence).toBeGreaterThan(ready.createdSequence);
    const component = store.layered.listStableComponents(scope.uid, scope.agent).find((item) => item.evidenceCorrectionIds.includes(correction.id));
    expect(component).toMatchObject({ evidenceAuthority: "human_correction" });
  });

  it("applies L2 Statement replacements with validated lineage and checkpoint freshness", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const component = seedCanonicalComponent(store);
    store.layered.runL2Aggregation(
      scope.uid,
      scope.agent,
      store.layered.getL1StableWatermark(scope.uid, scope.agent),
      { operations: [], desiredMemberships: [{ componentIds: [component.id] }], retireAggregateIds: [] },
      [
        {
          membership: { componentIds: [component.id] },
          content: {
            aggregateType: "technical_topic",
            canonicalTitle: "Database",
            aliases: [],
            externalKeys: {},
            labels: [],
            summary: "Database summary",
            facts: [{ content: "Project uses MySQL", evidenceComponentIds: [component.id], confidence: 0.8 }],
            decisions: [],
            constraints: [],
            openQuestions: []
          },
          provenance: { promptVersion: "test", schemaVersion: "v2", reason: "seed", confidence: 0.8 }
        }
      ]
    );
    const before = store.layered.listL2AggregateViews(scope.uid, scope.agent)[0];
    const oldStatement = before.revision.facts[0];
    const correction = store.layered.createCorrection({
      eventId: "l2-statement-replace",
      uid: scope.uid,
      agent: scope.agent,
      targetType: "l2_statement",
      targetId: oldStatement.id!,
      targetRevisionId: before.revision.id,
      action: "replace",
      correctedContent: "Project uses PostgreSQL",
      reason: "manual correction"
    });
    const service = new LayeredMemoryService(store, {
      l1Planner: { async plan() { return { items: [] }; } },
      l2Planner: {
        async plan(input) {
          expect(input.corrections.map((item) => item.id)).toEqual([correction.id]);
          return { operations: [], desiredMemberships: [{ aggregateId: before.aggregate.id, componentIds: [component.id] }], retireAggregateIds: [], handledCorrectionIds: [correction.id] };
        }
      },
      l2Synthesizer: {
        async synthesize(input) {
          return {
            statementOperations: [
              {
                op: "continue",
                sourceRef: input.sourceStatements[0].sourceRef,
                statement: {
                  content: "Project uses PostgreSQL",
                  evidenceComponentIds: [],
                  evidenceCorrectionIds: [correction.id],
                  status: "supported",
                  conflictAssessment: null,
                  confidence: 0.95
                }
              }
            ],
            content: {
              aggregateType: "technical_topic",
              canonicalTitle: "Database",
              aliases: [],
              externalKeys: {},
              labels: [],
              summary: "Database summary",
              facts: [],
              decisions: [],
              constraints: [],
              openQuestions: []
            },
            reason: "applied correction",
            confidence: 0.95
          };
        }
      },
      recallPlanner: { async plan(input) { return { shouldUseMemory: true, selectedIds: input.candidates.map((candidate) => candidate.id), reason: "test" }; } }
    });

    await expect(service.runL2Aggregation(scope.uid, scope.agent)).resolves.toMatchObject({ run: { status: "success" } });
    const after = store.layered.getL2AggregateView(before.aggregate.id)!;
    expect(after.revision.facts).toEqual([
      expect.objectContaining({
        id: oldStatement.id,
        content: "Project uses PostgreSQL",
        evidenceCorrectionIds: [correction.id],
        evidenceAuthority: "human_correction",
        status: "supported"
      })
    ]);
    expect(store.layered.getCorrection(scope.uid, scope.agent, correction.id)).toMatchObject({ status: "applied" });
    expect(store.layered.listStatementLineage(scope.uid, scope.agent)).toEqual([
      expect.objectContaining({
        fromRevisionId: before.revision.id,
        fromStatementId: oldStatement.id,
        toRevisionId: after.revision.id,
        toStatementId: oldStatement.id,
        operation: "continue"
      })
    ]);
    const recall = await service.recall({ uid: scope.uid, agent: scope.agent, query: "PostgreSQL" });
    expect(recall).toMatchObject({ usagePolicy: "reference_only", freshness: { status: "current", pendingCorrectionCount: 0 } });
    expect(recall.results.find((result) => result.level === "L2")).toMatchObject({
      evidenceAuthority: "human_correction",
      evidenceCorrectionIds: [correction.id],
      statementIds: [oldStatement.id],
      statementStatuses: ["supported"]
    });
  });

  it("deduplicates turns by uid, source, and eventId", () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const input = {
      eventId: "external-1",
      sessionId: "session-1",
      role: "user" as const,
      content: "讨论 v2 架构",
      ...scope
    };

    const first = store.createTurn(input);
    const duplicate = store.createTurn(input);

    expect(duplicate.id).toBe(first.id);
    expect(store.listTurns()).toHaveLength(1);
    expect(() => store.createTurn({ ...input, content: "不同内容" })).toThrow("Idempotency conflict");
  });

  it("builds canonical L1 Components and a two-phase L2 revision with evidence", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const firstTurn = store.createTurn({
      eventId: "turn-1",
      sessionId: "session-1",
      role: "user",
      content: "L2 应该跨 session 聚合知识",
      ...scope
    });
    const secondTurn = store.createTurn({
      eventId: "turn-2",
      sessionId: "session-1",
      role: "assistant",
      content: "Project 只是 L2 的一种主题类型",
      ...scope
    });
    const segment = store.createTopicSegment({
      sessionId: "session-1",
      title: "L2 架构定义",
      summary: "讨论 L2 跨 session 聚合以及 Project 的定位。",
      status: "complete",
      confidence: 0.95,
      turnIds: [firstTurn.id, secondTurn.id],
      reason: "flush",
      fingerprint: "segment-v2-1",
      projectMemoryIds: [],
      ...scope
    });

    const service = new LayeredMemoryService(store, {
      l1Planner: {
        async plan(input) {
          return {
            items: [
              {
                operation: "keep",
                sourceTopicIds: [input.topics[0].topic.id],
                title: "L2 架构定义",
                summary: "L2 是跨 session 的知识聚合层，Project 只是其中一种主题。",
                sourceTurnIds: [firstTurn.id, secondTurn.id],
                components: [
                  {
                    content: "L2 是跨 session 的知识聚合层",
                    labels: ["architecture"],
                    evidenceTurnIds: [firstTurn.id],
                    confidence: 0.97
                  },
                  {
                    content: "Project 只是 L2 的一种主题类型",
                    labels: ["architecture"],
                    evidenceTurnIds: [secondTurn.id],
                    confidence: 0.96
                  }
                ],
                reason: "topic is already coherent",
                confidence: 0.96
              }
            ]
          };
        }
      },
      l2Planner: {
        async plan(input) {
          const componentIds = input.components.map((component) => component.id);
          return {
            operations: [
              {
                operation: "create",
                componentIds,
                reason: "same architecture theme",
                confidence: 0.95
              }
            ],
            desiredMemberships: [{ componentIds }],
            retireAggregateIds: []
          };
        }
      },
      l2Synthesizer: {
        async synthesize(input) {
          return {
            content: {
              aggregateType: "technical_topic",
              canonicalTitle: "oh-my-memory 分层架构",
              aliases: ["memory architecture"],
              externalKeys: { repository: "oh-my-memory" },
              labels: ["architecture"],
              summary: "L2 跨 session 聚合知识，Project 是一种 L2 主题。",
              facts: [
                {
                  content: "L2 跨 session 聚合知识",
                  evidenceComponentIds: [input.componentIds[0]],
                  confidence: 0.97
                }
              ],
              decisions: [],
              constraints: [],
              openQuestions: []
            },
            reason: "synthesized from validated membership",
            confidence: 0.96
          };
        }
      },
      recallPlanner: {
        async plan(input) {
          return { shouldUseMemory: true, selectedIds: input.candidates.map((candidate) => candidate.id), reason: "test" };
        }
      },
      provenance: { provider: "test", model: "test-model" }
    });

    const provisional = service.appendProvisionalTopic(segment);
    expect(provisional.revision.status).toBe("provisional");

    const l1 = await service.runL1Maintenance(scope, "session-1");
    expect(l1.run.status).toBe("success");
    expect(l1.run.outputWatermark).toBeGreaterThan(0);
    const canonical = l1.topics.find((topic) => topic.topic.id === provisional.topic.id)!;
    expect(canonical.revision.status).toBe("canonical");
    expect(canonical.components).toHaveLength(2);
    expect(canonical.components[0].evidenceTurnIds).toEqual([firstTurn.id]);
    const repeatedL1 = await service.runL1Maintenance(scope, "session-1");
    expect(repeatedL1.run.id).toBe(l1.run.id);

    const l2 = await service.runL2Aggregation(scope.uid, scope.agent);
    expect(l2.run.status).toBe("success");
    const active = l2.aggregates.find((aggregate) => aggregate.aggregate.status === "active")!;
    expect(active.revision.aggregateType).toBe("technical_topic");
    expect(active.revision.externalKeys).toEqual({ repository: "oh-my-memory" });
    expect(active.componentIds).toEqual(expect.arrayContaining(canonical.components.map((component) => component.id)));
    expect(active.componentIds).toHaveLength(canonical.components.length);
    expect(active.revision.facts[0].evidenceComponentIds).toEqual([canonical.components[0].id]);
    const repeatedL2 = await service.runL2Aggregation(scope.uid, scope.agent);
    expect(repeatedL2.run.id).toBe(l2.run.id);
    expect(repeatedL2.aggregates.filter((aggregate) => aggregate.aggregate.status === "active")).toHaveLength(1);

    const recall = await service.recall({ uid: scope.uid, agent: scope.agent, query: "L2 跨 session" });
    expect(recall.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "L2", id: active.aggregate.id }),
        expect.objectContaining({ level: "L1_COMPONENT" })
      ])
    );
    expect(recall.results.find((result) => result.level === "L2")?.evidence.turnIds).toEqual(
      expect.arrayContaining([firstTurn.id, secondTurn.id])
    );
  });

  it("recalls a partial Topic immediately as provisional L1 without legacy memory writes", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const layeredService = new LayeredMemoryService(store, {
      l1Planner: { async plan() { return { items: [] }; } },
      l2Planner: { async plan() { return { operations: [], desiredMemberships: [], retireAggregateIds: [] }; } },
      l2Synthesizer: { async synthesize() { throw new Error("not used"); } },
      recallPlanner: {
        async plan(input) {
          return { shouldUseMemory: true, selectedIds: input.candidates.map((candidate) => candidate.id), reason: "test" };
        }
      }
    });
    const service = createTestMemoryService(store, { layeredService, legacyCompatibility: false });

    await service.ingestTurn({
      eventId: "online-1",
      sessionId: "online-session",
      role: "user",
      content: "我更喜欢 TypeScript 处理长期项目",
      ...scope
    });
    await service.ingestTurn({
      eventId: "online-2",
      sessionId: "online-session",
      role: "assistant",
      content: "已记录这个偏好",
      ...scope
    });

    const topics = service.listL1Topics({ uid: scope.uid, agent: scope.agent, sessionId: "online-session" });
    expect(store.listMemories({ uid: scope.uid })).toEqual([]);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      revision: { status: "provisional" },
      sourceSegmentStatus: "partial"
    });
    expect(topics[0].revision.sourceTurnIds).toHaveLength(2);

    const recall = await service.recallV2({ uid: scope.uid, agent: scope.agent, query: "TypeScript" });
    expect(recall.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "L1_TOPIC", stability: "provisional" })])
    );
  });

  it("creates L3 Profiles only from canonical evidence spanning multiple sessions", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const first = seedCanonicalComponent(store, "profile-session-1", "用户长期偏好 TypeScript");
    const second = seedCanonicalComponent(store, "profile-session-2", "用户再次选择 TypeScript");
    store.layered.upsertL2Checkpoint(
      scope.uid,
      scope.agent,
      store.layered.getL1StableWatermark(scope.uid, scope.agent),
      0,
      "profile-test-l2"
    );
    const service = new LayeredMemoryService(store, {
      l1Planner: { async plan() { return { items: [] }; } },
      l2Planner: { async plan() { return { operations: [], desiredMemberships: [], retireAggregateIds: [] }; } },
      l2Synthesizer: { async synthesize() { throw new Error("not used"); } },
      profileExtractor: {
        async extract() {
          return [
            {
              profileKey: "preference:typescript",
              category: "preference",
              value: "TypeScript",
              summary: "用户跨多个会话持续偏好 TypeScript",
              evidenceComponentIds: [first.id, second.id],
              evidenceAggregateIds: [],
              confidence: 0.95,
              reason: "repeated canonical evidence"
            },
            {
              profileKey: "unstable:single-session",
              category: "other",
              value: "temporary",
              summary: "仅单次出现",
              evidenceComponentIds: [first.id],
              evidenceAggregateIds: [],
              confidence: 0.8,
              reason: "single evidence"
            }
          ];
        }
      },
      recallPlanner: {
        async plan(input) {
          return { shouldUseMemory: true, selectedIds: input.candidates.map((candidate) => candidate.id), reason: "test" };
        }
      }
    });

    expect(store.layered.listDueL3Namespaces()).toContainEqual({ uid: scope.uid, agent: scope.agent });
    const build = await service.runL3ProfileBuild(scope.uid, scope.agent);
    expect(build.createdOrUpdated).toHaveLength(1);
    expect(build.createdOrUpdated[0]).toMatchObject({
      level: "L3",
      type: "profile",
      object: "TypeScript",
      metadata: {
        canonicalProfile: true,
        evidenceSessionIds: expect.arrayContaining(["profile-session-1", "profile-session-2"])
      }
    });
    expect(build.rejected).toEqual([
      expect.objectContaining({ profileKey: "unstable:single-session", reason: expect.stringContaining("two sessions") })
    ]);
    expect(store.layered.listDueL3Namespaces()).not.toContainEqual({ uid: scope.uid, agent: scope.agent });

    const recall = await service.recall({ uid: scope.uid, agent: scope.agent, query: "TypeScript" });
    expect(recall.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "L3_PROFILE", stability: "stable" })])
    );

    const app = buildServer(createTestMemoryService(store, { layeredService: service, legacyCompatibility: false }));
    const listed = await app.inject({
      method: "GET",
      url: `/v1/l3/profiles?uid=${scope.uid}&agent=${scope.agent}`
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: "TypeScript", metadata: expect.objectContaining({ canonicalProfile: true }) })
      ])
    );
    const rerun = await app.inject({
      method: "POST",
      url: "/v1/jobs/l3-profile/run",
      payload: { uid: scope.uid, agent: scope.agent }
    });
    expect(rerun.statusCode).toBe(200);
    expect(rerun.json().createdOrUpdated).toHaveLength(1);
  });

  it("supports an idempotent empty L2 checkpoint", async () => {
    const store = new MemoryRepository(createDatabase(":memory:"));
    const service = new LayeredMemoryService(store, {
      l1Planner: { async plan() { return { items: [] }; } },
      l2Planner: { async plan() { return { operations: [], desiredMemberships: [], retireAggregateIds: [] }; } },
      l2Synthesizer: {
        async synthesize() {
          throw new Error("not used");
        }
      },
      recallPlanner: { async plan() { return { shouldUseMemory: false, selectedIds: [], reason: "empty" }; } }
    });
    await expect(service.runL2Aggregation("missing", "agent")).resolves.toMatchObject({
      run: expect.objectContaining({ status: "success" }),
      aggregates: []
    });
  });
});

function seedCanonicalComponent(store: MemoryRepository, sessionId = "session-1", content = "seed") {
  seedCounter += 1;
  const turn = store.createTurn({
    eventId: `seed-turn-${seedCounter}`,
    sessionId,
    role: "user",
    content,
    ...scope
  });
  const segment = store.createTopicSegment({
    sessionId,
    title: content,
    summary: content,
    status: "complete",
    confidence: 1,
    turnIds: [turn.id],
    reason: "seed",
    fingerprint: `seed-${seedCounter}`,
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
    sessionId,
    new Date().toISOString(),
    {
      items: [
        {
          operation: "keep",
          sourceTopicIds: [provisional.topic.id],
          sourceTurnIds: [turn.id],
          title: content,
          summary: content,
          components: [{ content, evidenceTurnIds: [turn.id], confidence: 1 }],
          reason: "seed",
          confidence: 1
        }
      ]
    },
    { promptVersion: "test", schemaVersion: "v2" }
  );
  return store.layered.listStableComponents(scope.uid, scope.agent).at(-1)!;
}

function createTestMemoryService(store: MemoryStore, options: MemoryServiceOptions = {}) {
  return createMemoryService(store, {
    resolver: new RuleBasedMemoryResolver(),
    projectMemoryBuilder: { rebuild: () => [] },
    compressor: new RuleBasedMemoryCompressor(),
    topicBuilder: new SlidingTopicBuilder(new RuleBasedTopicBoundaryDetector(), new RuleBasedTopicMemoryGenerator()),
    recallPlanner: {
      plan: () => ({ shouldUseMemory: false, selectedMemoryIds: [], reason: "test default" })
    },
    legacyCompatibility: true,
    ...options
  });
}
