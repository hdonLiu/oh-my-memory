import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayeredMemoryService } from "../src/application/layered-memory-service.js";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";

const scope = { uid: "user-1", source: "chat", agent: "codex", channel: "default", metadata: {} };

describe("v2 layered memory", () => {
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
