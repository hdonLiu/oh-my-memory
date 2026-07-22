import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createMemoryService } from "../src/application/memory-service.js";
import type {
  AmbiguousTopicModel,
  L2AggregationModel,
  L3ProfilingModel,
  RecallModel,
  TopicMaintenanceModel
} from "../src/domain/models.js";
import type { EmbeddingProvider } from "../src/domain/embedding.js";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";

const databases: Database.Database[] = [];

afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});

function setup() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MemoryRepository(db);
  return { db, repository };
}

class ScriptedEmbedding implements EmbeddingProvider {
  readonly dimensions = 2;
  readonly calls: string[] = [];

  constructor(private readonly values: Record<string, number[]>) {}

  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    const value = this.values[text];
    if (!value) throw new Error(`No scripted embedding for: ${text}`);
    return value;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

class ScriptedBoundary implements AmbiguousTopicModel {
  readonly calls: Array<{ topicText: string; turnText: string }> = [];

  constructor(private readonly decisions: Array<"continue" | "split">) {}

  async decide(input: { topicText: string; turnText: string }): Promise<"continue" | "split"> {
    this.calls.push(input);
    const decision = this.decisions.shift();
    if (!decision) throw new Error("No scripted topic decision");
    return decision;
  }
}

describe("Session and immutable Turn", () => {
  it("uses uid + agentId + externalSessionId as identity and keeps source/channel as metadata", () => {
    const { repository } = setup();
    const first = repository.resolveSession({
      uid: "u1",
      agentId: "agent-a",
      externalSessionId: "chat-1",
      source: "web",
      channel: "main"
    });
    const same = repository.resolveSession({
      uid: "u1",
      agentId: "agent-a",
      externalSessionId: "chat-1",
      source: "slack",
      channel: "dm"
    });
    const otherAgent = repository.resolveSession({
      uid: "u1",
      agentId: "agent-b",
      externalSessionId: "chat-1",
      source: "web",
      channel: "main"
    });

    expect(same.id).toBe(first.id);
    expect(same.source).toBe("slack");
    expect(otherAgent.id).not.toBe(first.id);
    expect(repository.getSessionByExternal("u1", "agent-a", "chat-1")?.id).toBe(first.id);
    expect(repository.ensurePrivateSpace("u1", "agent-a").ownerAgentId).toBe("agent-a");
  });

  it("deduplicates eventId inside uid + agentId and rejects conflicting payloads", () => {
    const { repository } = setup();
    const session = repository.resolveSession({
      uid: "u1",
      agentId: "agent-a",
      externalSessionId: "chat-1",
      source: "web"
    });
    const input = {
      uid: "u1",
      agentId: "agent-a",
      sessionId: session.id,
      eventId: "event-1",
      role: "user" as const,
      content: "first",
      metadata: {}
    };

    expect(repository.appendTurn(input).id).toBe(repository.appendTurn(input).id);
    expect(() => repository.appendTurn({ ...input, content: "changed" })).toThrow(/Idempotency conflict/);

    const secondSession = repository.resolveSession({
      uid: "u1",
      agentId: "agent-b",
      externalSessionId: "chat-1",
      source: "web"
    });
    expect(
      repository.appendTurn({ ...input, agentId: "agent-b", sessionId: secondSession.id }).id
    ).not.toBe(repository.appendTurn(input).id);
  });

  it("enforces Turn immutability in storage", () => {
    const { db, repository } = setup();
    const session = repository.resolveSession({
      uid: "u1",
      agentId: "agent-a",
      externalSessionId: "chat-1",
      source: "web"
    });
    const turn = repository.appendTurn({
      uid: "u1",
      agentId: "agent-a",
      sessionId: session.id,
      eventId: "event-1",
      role: "user",
      content: "immutable",
      metadata: {}
    });

    expect(() => db.prepare("update turns set content = ? where id = ?").run("mutated", turn.id)).toThrow(
      /immutable/
    );
    expect(() => db.prepare("delete from turns where id = ?").run(turn.id)).toThrow(/immutable/);
  });
});

describe("realtime Topic", () => {
  it("uses embeddings for clear bands, calls the small model only in the fuzzy band, and ignores low-information text", async () => {
    const { repository } = setup();
    const embedding = new ScriptedEmbedding({
      "项目预算": [1, 0],
      "项目预算\n预算还是一万元": [1, 0],
      "预算还是一万元": [0.99, 0.01],
      "项目预算\n预算还是一万元\n周末去爬山": [1, 0],
      "周末去爬山": [0, 1],
      "周末去爬山\n需要带水吗": [0, 1],
      "需要带水吗": [0.75, 0.66]
    });
    const boundary = new ScriptedBoundary(["continue"]);
    const service = createMemoryService(repository, {
      embeddingProvider: embedding,
      ambiguousTopicModel: boundary,
      topicThresholds: { join: 0.9, split: 0.2 }
    });

    await service.ingestTurn(turnInput("e1", "项目预算"));
    await service.ingestTurn(turnInput("e2", "你好"));
    await service.ingestTurn(turnInput("e3", "预算还是一万元"));
    await service.ingestTurn(turnInput("e4", "周末去爬山"));
    await service.ingestTurn(turnInput("e5", "需要带水吗"));

    const session = repository.getSessionByExternal("u1", "agent-a", "chat-1")!;
    const topics = repository.listTopics(session.id);
    expect(topics.map((topic) => topic.status)).toEqual(["pending", "open"]);
    expect(topics[0]?.recallText).toBe("项目预算\n预算还是一万元");
    expect(topics[0]?.turnIds).toHaveLength(3);
    expect(topics[1]?.recallText).toBe("周末去爬山\n需要带水吗");
    expect(embedding.calls).not.toContain("你好");
    expect(boundary.calls).toHaveLength(1);
  });

  it("persists the Turn and marks Topic dirty when a model dependency fails, without semantic rule fallback", async () => {
    const { repository } = setup();
    const embedding = new ScriptedEmbedding({ "first": [1, 0] });
    const service = createMemoryService(repository, {
      embeddingProvider: embedding,
      ambiguousTopicModel: new ScriptedBoundary([])
    });

    await service.ingestTurn(turnInput("e1", "first"));
    const result = await service.ingestTurn(turnInput("e2", "provider fails"));
    const session = repository.getSessionByExternal("u1", "agent-a", "chat-1")!;

    expect(repository.listTurns(session.id)).toHaveLength(2);
    expect(result.derivation.status).toBe("deferred");
    expect(repository.getRebuildJob("topic", session.id)?.status).toBe("dirty");
    expect(repository.listTopics(session.id)).toHaveLength(1);
  });
});

describe("MemorySpace, current snapshots, and recall authorization", () => {
  it("creates the private space lazily even before the Agent opens a Session", () => {
    const { repository } = setup();
    expect(repository.listAuthorizedSpaces("u1", "new-agent")).toMatchObject([
      { uid: "u1", type: "private", ownerAgentId: "new-agent" }
    ]);
  });

  it("shares only L2/L3 through an explicitly authorized same-uid MemorySpace", async () => {
    const { repository } = setup();
    const privateA = repository.ensurePrivateSpace("u1", "agent-a");
    const privateB = repository.ensurePrivateSpace("u1", "agent-b");
    const shared = repository.createSharedSpace("u1", "team", "agent-a");

    expect(repository.listAuthorizedSpaces("u1", "agent-b").map((space) => space.id)).toEqual([privateB.id]);
    repository.addSpaceMember("u1", shared.id, "agent-b");
    expect(repository.listAuthorizedSpaces("u1", "agent-b").map((space) => space.id)).toEqual([
      privateB.id,
      shared.id
    ]);
    expect(() => repository.addSpaceMember("u2", shared.id, "agent-x")).toThrow(/same uid/);

    repository.replaceL2Snapshot(shared.id, [
      {
        id: "fact-1",
        key: "favorite-drink",
        content: "用户喜欢红茶",
        kind: "preference",
        evidenceTurnIds: ["turn-1"],
        sourceAgentIds: ["agent-a"],
        confidence: 0.9
      }
    ]);
    repository.replaceL3Snapshot(shared.id, [
      { id: "profile-1", key: "taste", content: "偏好茶饮", evidenceL2Ids: ["fact-1"], confidence: 0.8 }
    ]);

    const recall: RecallModel = {
      rank: async ({ candidates }) => ({ ids: candidates.map((candidate) => candidate.id), reason: "scripted" })
    };
    const service = createMemoryService(repository, { recallModel: recall });
    expect((await service.recall({ uid: "u1", agentId: "agent-b", query: "喝什么" })).items).toHaveLength(2);
    expect((await service.recall({ uid: "u1", agentId: "agent-a", query: "喝什么" })).items).toHaveLength(2);
    expect(privateA.id).not.toBe(privateB.id);
  });

  it("uses LLM model interfaces to atomically replace Topic, L2, and L3 current snapshots", async () => {
    const { repository } = setup();
    const session = repository.resolveSession({
      uid: "u1",
      agentId: "agent-a",
      externalSessionId: "chat-1",
      source: "web"
    });
    const turn = repository.appendTurn({
      uid: "u1",
      agentId: "agent-a",
      sessionId: session.id,
      eventId: "event-1",
      role: "user",
      content: "我喜欢红茶",
      metadata: {}
    });
    const space = repository.ensurePrivateSpace("u1", "agent-a");

    const topicMaintenanceModel: TopicMaintenanceModel = {
      rebuild: async () => ({
        topics: [
          {
            id: "topic-current",
            turnIds: [turn.id],
            title: "饮品偏好",
            summary: "用户表达了饮品偏好",
            structuredContent: { preference: "红茶" },
            recallText: "我喜欢红茶"
          }
        ]
      })
    };
    const l2AggregationModel: L2AggregationModel = {
      rebuild: async () => ({
        aggregates: [
          {
            id: "fact-current",
            key: "favorite-drink",
            content: "用户喜欢红茶",
            kind: "preference",
            evidenceTurnIds: [turn.id],
            sourceAgentIds: ["agent-a"],
            confidence: 0.95
          }
        ]
      })
    };
    const l3ProfilingModel: L3ProfilingModel = {
      rebuild: async () => ({
        profiles: [
          {
            id: "profile-current",
            key: "taste",
            content: "偏好茶饮",
            evidenceL2Ids: ["fact-current"],
            confidence: 0.8
          }
        ]
      })
    };
    const service = createMemoryService(repository, {
      topicMaintenanceModel,
      l2AggregationModel,
      l3ProfilingModel
    });

    await service.maintainTopics({ uid: "u1", agentId: "agent-a", externalSessionId: "chat-1" });
    await service.rebuildL2({ uid: "u1", agentId: "agent-a", memorySpaceId: space.id });
    await service.rebuildL3({ uid: "u1", agentId: "agent-a", memorySpaceId: space.id });

    expect(repository.listTopics(session.id).map((topic) => topic.id)).toEqual(["topic-current"]);
    expect(repository.listL2(space.id).map((item) => item.id)).toEqual(["fact-current"]);
    expect(repository.listL3(space.id).map((item) => item.id)).toEqual(["profile-current"]);
  });

  it("rolls back a current-snapshot replacement when the target set is invalid", () => {
    const { repository } = setup();
    const space = repository.ensurePrivateSpace("u1", "agent-a");
    repository.replaceL2Snapshot(space.id, [
      {
        id: "stable",
        key: "stable-key",
        content: "stable value",
        kind: "fact",
        evidenceTurnIds: ["turn-1"],
        sourceAgentIds: ["agent-a"],
        confidence: 1
      }
    ]);

    expect(() =>
      repository.replaceL2Snapshot(space.id, [
        {
          id: "duplicate-a",
          key: "duplicate-key",
          content: "a",
          kind: "fact",
          evidenceTurnIds: ["turn-1"],
          sourceAgentIds: ["agent-a"],
          confidence: 1
        },
        {
          id: "duplicate-b",
          key: "duplicate-key",
          content: "b",
          kind: "fact",
          evidenceTurnIds: ["turn-1"],
          sourceAgentIds: ["agent-a"],
          confidence: 1
        }
      ])
    ).toThrow();
    expect(repository.listL2(space.id).map((item) => item.id)).toEqual(["stable"]);
  });
});

describe("Correction rebuild cascade", () => {
  it("keeps the original Turn immutable and marks Topic -> L2 -> L3 dirty", () => {
    const { repository } = setup();
    const session = repository.resolveSession({
      uid: "u1",
      agentId: "agent-a",
      externalSessionId: "chat-1",
      source: "web"
    });
    const turn = repository.appendTurn({
      uid: "u1",
      agentId: "agent-a",
      sessionId: session.id,
      eventId: "event-1",
      role: "user",
      content: "我喜欢咖啡",
      metadata: {}
    });
    const space = repository.ensurePrivateSpace("u1", "agent-a");
    const service = createMemoryService(repository);

    const result = service.correctTurn({
      uid: "u1",
      agentId: "agent-a",
      targetTurnId: turn.id,
      correctedContent: "我其实喜欢红茶",
      reason: "用户纠正"
    });

    expect(repository.getTurn(turn.id, "u1", "agent-a")?.content).toBe("我喜欢咖啡");
    expect(result.correction.correctedContent).toBe("我其实喜欢红茶");
    expect(repository.getRebuildJob("topic", session.id)?.status).toBe("dirty");
    expect(repository.getRebuildJob("L2", space.id)?.status).toBe("dirty");
    expect(repository.getRebuildJob("L3", space.id)?.status).toBe("dirty");
  });
});

function turnInput(eventId: string, content: string) {
  return {
    uid: "u1",
    agentId: "agent-a",
    externalSessionId: "chat-1",
    source: "web",
    channel: "main",
    eventId,
    role: "user" as const,
    content,
    metadata: {}
  };
}
