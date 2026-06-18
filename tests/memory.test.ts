import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryService } from "../src/application/memory-service.js";
import { loadTopicWindowConfig } from "../src/application/topic-config.js";
import { runCli } from "../src/cli.js";
import {
  type EmbeddingIndex,
  DeterministicEmbeddingProvider,
  InMemoryEmbeddingIndex,
  OpenAICompatibleEmbeddingProvider,
  SqliteVectorIndex,
  cosineSimilarity
} from "../src/domain/embedding.js";
import { extractMemories } from "../src/domain/extractor.js";
import { HybridMemoryExtractor, LlmMemoryExtractor, RuleBasedMemoryExtractor } from "../src/domain/extractors.js";
import { runDreaming } from "../src/domain/dreaming.js";
import { loadProjectBuildSchedulerConfig, runScheduledProjectBuild } from "../src/application/project-scheduler.js";
import { ModelProjectMemoryBuilder, buildProjectTopicInputs, rebuildProjectMemories } from "../src/domain/project-memory.js";
import { HybridMemoryResolver, LlmMemoryResolver, RuleBasedMemoryResolver, resolveMemory } from "../src/domain/resolver.js";
import { searchMemories } from "../src/domain/search.js";
import { projectEvaluationFixtures } from "../src/domain/project-eval-fixtures.js";
import { runProjectEvaluationFixtures } from "../src/domain/project-eval-runner.js";
import { SlidingTopicBuilder } from "../src/domain/topics.js";
import {
  HybridTopicBoundaryDetector,
  LlmTopicBoundaryDetector,
  RuleBasedTopicBoundaryDetector,
  type TopicBoundaryDetector
} from "../src/domain/topic-boundary.js";
import { LlmTopicMemoryGenerator, RuleBasedTopicMemoryGenerator, topicMemoryUnitToDraft } from "../src/domain/topic-memory.js";
import { RuleBasedMemoryCompressor } from "../src/domain/dreaming.js";
import { buildServer } from "../src/server.js";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";
import { SqliteMemoryStore } from "../src/storage/sqlite-store.js";
import type { MemoryStore } from "../src/storage/store.js";

class TrackingEmbeddingIndex implements EmbeddingIndex {
  readonly upsertedIds: string[] = [];
  searchCount = 0;

  async upsert(record: { id: string }): Promise<void> {
    this.upsertedIds.push(record.id);
  }

  async delete(): Promise<void> {}

  async search(): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>> {
    this.searchCount += 1;
    return this.upsertedIds.map((id) => ({ id, score: 10, metadata: {} }));
  }
}

describe("topic boundary detection", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("keeps related messages in the same open topic", async () => {
    const detector = new RuleBasedTopicBoundaryDetector();
    const result = await detector.detectBoundary({
      existingTurns: [
        {
          id: "t1",
          sessionId: "s1",
          role: "user",
          content: "项目 A 要做 memory 系统",
          createdAt: "2026-06-01T00:00:00.000Z",
          ...scope
        }
      ],
      newTurn: {
        id: "t2",
        sessionId: "s1",
        role: "assistant",
        content: "可以先做 topic 抽取",
        createdAt: "2026-06-01T00:01:00.000Z",
        ...scope
      }
    });

    expect(result).toMatchObject({ shouldClose: false, confidence: expect.any(Number) });
  });

  it("parses LLM boundary decisions with closed turn ids", async () => {
    const detector = new LlmTopicBoundaryDetector({
      complete: async () =>
        JSON.stringify({
          shouldClose: true,
          confidence: 0.91,
          reason: "new unrelated request",
          closedTurnIds: ["t1"],
          carryOverTurnIds: ["t2"]
        })
    });

    await expect(
      detector.detectBoundary({
        existingTurns: [
          {
            id: "t1",
            sessionId: "s1",
            role: "user",
            content: "项目 A",
            createdAt: "2026-06-01T00:00:00.000Z",
            ...scope
          }
        ],
        newTurn: {
          id: "t2",
          sessionId: "s1",
          role: "user",
          content: "换个话题，健身计划",
          createdAt: "2026-06-01T00:02:00.000Z",
          ...scope
        }
      })
    ).resolves.toMatchObject({
      shouldClose: true,
      closedTurnIds: ["t1"],
      carryOverTurnIds: ["t2"]
    });
  });

  it("falls back when LLM boundary output is invalid", async () => {
    const fallback: TopicBoundaryDetector = {
      detectBoundary: () => ({ shouldClose: false, confidence: 0.6, reason: "fallback" })
    };
    const detector = new HybridTopicBoundaryDetector(
      new LlmTopicBoundaryDetector({ complete: async () => "not-json" }),
      fallback
    );

    await expect(
      detector.detectBoundary({
        existingTurns: [],
        newTurn: {
          id: "t1",
          sessionId: "s1",
          role: "user",
          content: "hello",
          createdAt: "2026-06-01T00:00:00.000Z",
          ...scope
        }
      })
    ).resolves.toMatchObject({ reason: "fallback" });
  });
});

describe("topic memory generation", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("generates structured topic units from closed turns", async () => {
    const generator = new RuleBasedTopicMemoryGenerator();
    const unit = await generator.generate({
      sessionId: "s1",
      turns: [
        {
          id: "t1",
          sessionId: "s1",
          role: "user",
          content: "项目 A 要实现 memory 系统",
          createdAt: "2026-06-01T00:00:00.000Z",
          ...scope
        },
        {
          id: "t2",
          sessionId: "s1",
          role: "assistant",
          content: "先实现 topic 层",
          createdAt: "2026-06-01T00:01:00.000Z",
          ...scope
        }
      ],
      reason: "boundary"
    });

    expect(unit).toMatchObject({
      topicType: "project_work",
      title: expect.any(String),
      evidenceTurnIds: ["t1", "t2"]
    });
  });

  it("converts structured topic units to topic memory drafts", () => {
    const draft = topicMemoryUnitToDraft(
      {
        title: "项目 A memory 系统",
        summary: "讨论项目 A 的 memory 系统 topic 层。",
        topicType: "project_work",
        entities: ["项目 A"],
        decisions: ["先实现 topic 层"],
        tasks: ["实现 topic 层"],
        preferences: [],
        confidence: 0.86,
        reason: "boundary",
        evidenceTurnIds: ["t1", "t2"]
      },
      { sessionId: "s1", ...scope }
    );

    expect(draft).toMatchObject({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      predicate: "topic",
      sourceTurnIds: ["t1", "t2"],
      metadata: expect.objectContaining({ topicType: "project_work", sessionId: "s1" })
    });
  });

  it("rejects invalid LLM topic memory output", async () => {
    const generator = new LlmTopicMemoryGenerator({ complete: async () => JSON.stringify({ title: "bad" }) });

    await expect(
      generator.generate({
        sessionId: "s1",
        turns: [
          {
            id: "t1",
            sessionId: "s1",
            role: "user",
            content: "项目 A",
            createdAt: "2026-06-01T00:00:00.000Z",
            ...scope
          }
        ],
        reason: "flush"
      })
    ).rejects.toThrow("Invalid LLM topic memory response");
  });
});

describe("session sliding topic builder", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("keeps topic partial until boundary closes the previous buffer", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const detector: TopicBoundaryDetector = {
      detectBoundary: ({ newTurn }) => ({
        shouldClose: newTurn.content.includes("换个话题"),
        confidence: 0.9,
        reason: "topic changed"
      })
    };
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(detector, new RuleBasedTopicMemoryGenerator(), {
        maxSize: 5,
        minConfidence: 0.7
      })
    });

    const first = await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 要做 topic", ...scope });
    const second = await service.ingestTurn({ sessionId: "s1", role: "assistant", content: "先用滑动窗口", ...scope });
    const third = await service.ingestTurn({ sessionId: "s1", role: "user", content: "换个话题，晚饭吃什么", ...scope });

    expect(first.memories).toEqual([]);
    expect(second.memories).toEqual([]);
    expect(third.memories).toHaveLength(1);
    expect(third.memories[0].sourceTurnIds).toHaveLength(2);

    const partials = store.listTopicSegments(scope).filter((topic) => topic.status === "partial");
    expect(partials).toHaveLength(1);
    expect(partials[0].summary).toContain("晚饭吃什么");
  });

  it("forces close when max window size is reached", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(
        { detectBoundary: () => ({ shouldClose: false, confidence: 0.8, reason: "same topic" }) },
        new RuleBasedTopicMemoryGenerator(),
        { maxSize: 2, minConfidence: 0.7 }
      )
    });

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 第一条", ...scope });
    const result = await service.ingestTurn({ sessionId: "s1", role: "assistant", content: "项目 A 第二条", ...scope });

    expect(result.memories).toHaveLength(1);
    expect(result.topic).toMatchObject({ status: "complete", reason: "max window size reached" });
  });
});

describe("topic resolver integration", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("runs MemoryResolver only when a topic closes", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const resolvedSubjects: string[] = [];
    const service = createMemoryService(store, {
      resolver: {
        resolve: (repo, draft) => {
          resolvedSubjects.push(draft.subject);
          return repo.createMemory(draft);
        }
      },
      topicBuilder: new SlidingTopicBuilder(
        {
          detectBoundary: ({ newTurn }) => ({
            shouldClose: newTurn.content.includes("换个话题"),
            confidence: 0.9,
            reason: "topic changed"
          })
        },
        new RuleBasedTopicMemoryGenerator()
      )
    });

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 要做 memory", ...scope });
    expect(resolvedSubjects).toEqual([]);

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "换个话题，健身计划", ...scope });
    expect(resolvedSubjects).toEqual(["项目 A"]);
  });
});

describe("session topic flush", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("flushes an open partial topic into a memory", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(
        { detectBoundary: () => ({ shouldClose: false, confidence: 0.8, reason: "same topic" }) },
        new RuleBasedTopicMemoryGenerator()
      )
    });

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 要做 flush", ...scope });
    const flushed = await service.flushSessionTopic(scope, "s1");

    expect(flushed.topic).toMatchObject({ status: "complete", reason: "session topic flush" });
    expect(flushed.memories).toHaveLength(1);
    expect(flushed.memories[0]).toMatchObject({ level: "topic", type: "topic" });
  });

  it("exposes HTTP flush endpoint", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const app = buildServer(createMemoryService(store));

    await app.inject({
      method: "POST",
      url: "/turns",
      payload: { sessionId: "s1", role: "user", content: "项目 A 要做 HTTP flush", ...scope }
    });

    const response = await app.inject({
      method: "POST",
      url: "/sessions/s1/topics/flush",
      payload: scope
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().memories).toHaveLength(1);
  });
});

describe("default topic LLM wiring", () => {
  it("keeps topic layer injectable without requiring network in tests", () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(
        { detectBoundary: () => ({ shouldClose: false, confidence: 0.8, reason: "test" }) },
        new RuleBasedTopicMemoryGenerator()
      )
    });

    expect(service).toMatchObject({
      ingestTurn: expect.any(Function),
      flushSessionTopic: expect.any(Function)
    });
  });
});

describe("topic configuration and debug api", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("loads topic window config from environment values", () => {
    expect(
      loadTopicWindowConfig({
        TOPIC_BUFFER_MAX_TURNS: "12",
        TOPIC_BOUNDARY_CONFIDENCE: "0.82",
        TOPIC_BOUNDARY_EXCLUDE_LAST_TURN: "false",
        TOPIC_BOUNDARY_EXCLUDE_THRESHOLD: "7"
      })
    ).toEqual({
      maxSize: 12,
      minConfidence: 0.82,
      excludeLastTurnForBoundary: false,
      excludeLastTurnThreshold: 7
    });
  });

  it("returns topic segments for debugging", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const app = buildServer(createMemoryService(store));

    await app.inject({
      method: "POST",
      url: "/turns",
      payload: { sessionId: "s1", role: "user", content: "项目 A 要做 debug api", ...scope }
    });

    const partial = await app.inject({
      method: "GET",
      url: "/topics?mis=u1&source=test&agent=agent&channel=default&sessionId=s1&status=partial"
    });

    expect(partial.statusCode).toBe(200);
    expect(partial.json().topics).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        status: "partial",
        summary: "项目 A 要做 debug api"
      })
    ]);

    await app.inject({ method: "POST", url: "/sessions/s1/topics/flush", payload: scope });

    const complete = await app.inject({
      method: "GET",
      url: "/topics?mis=u1&source=test&agent=agent&channel=default&sessionId=s1&status=complete"
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().topics).toEqual([expect.objectContaining({ sessionId: "s1", status: "complete" })]);

    await app.close();
  });
});

describe("project debug api and eval fixtures", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("returns L2 project memories with project metadata filters", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    store.createMemory({
      level: "L2",
      type: "project",
      subject: "oh-my-memory",
      predicate: "project",
      object: "Topic layer is implemented",
      summary: "oh-my-memory topic layer project",
      confidence: 0.9,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope,
      metadata: { projectKey: "repo:oh-my-memory", projectType: "repository" }
    });
    store.createMemory({
      level: "L2",
      type: "project",
      subject: "debug workflow",
      predicate: "project",
      object: "Debug workflow",
      summary: "debug workflow",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t2"],
      ...scope,
      metadata: { projectKey: "workflow:debug", projectType: "workflow" }
    });
    const app = buildServer(createMemoryService(store));

    const response = await app.inject({
      method: "GET",
      url: "/projects?mis=u1&source=test&agent=agent&channel=default&projectType=repository&projectKey=repo%3Aoh-my-memory"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toEqual([
      expect.objectContaining({
        level: "L2",
        type: "project",
        subject: "oh-my-memory",
        metadata: expect.objectContaining({ projectKey: "repo:oh-my-memory", projectType: "repository" })
      })
    ]);

    await app.close();
  });

  it("keeps L2 project evaluation fixtures for core aggregation cases", () => {
    expect(projectEvaluationFixtures.map((fixture) => fixture.id)).toEqual([
      "merge-topics-into-project",
      "keep-distinct-projects-separate",
      "keep-workflow-as-workflow",
      "exclude-preference-topic"
    ]);
    expect(projectEvaluationFixtures.find((fixture) => fixture.id === "exclude-preference-topic")).toMatchObject({
      expected: {
        projects: [],
        excludedTopicIds: ["topic-preference-1"]
      }
    });
  });

  it("runs L2 project evaluation fixtures and reports failures", async () => {
    const passing = await runProjectEvaluationFixtures(projectEvaluationFixtures, {
      extract: async (fixture) => fixture.expected.projects
    });

    expect(passing.passed).toBe(projectEvaluationFixtures.length);
    expect(passing.failed).toBe(0);
    expect(passing.results.every((result) => result.passed)).toBe(true);

    const failing = await runProjectEvaluationFixtures([projectEvaluationFixtures[0]], {
      extract: async () => []
    });

    expect(failing).toMatchObject({
      passed: 0,
      failed: 1,
      results: [
        expect.objectContaining({
          fixtureId: "merge-topics-into-project",
          passed: false,
          errors: [expect.stringContaining("missing project repository:oh-my-memory")]
        })
      ]
    });
  });
});

describe("embedding abstraction", () => {
  it("creates deterministic vectors and compares them with cosine similarity", async () => {
    const provider = new DeterministicEmbeddingProvider(16);

    const first = await provider.embed("项目 A 使用 PostgreSQL");
    const same = await provider.embed("项目 A 使用 PostgreSQL");
    const different = await provider.embed("用户偏好 TypeScript");

    expect(first).toEqual(same);
    expect(first).toHaveLength(16);
    expect(cosineSimilarity(first, same)).toBeCloseTo(1);
    expect(cosineSimilarity(first, different)).toBeLessThan(1);
  });

  it("keeps vector search behind a replaceable index interface", async () => {
    const provider = new DeterministicEmbeddingProvider(16);
    const index = new InMemoryEmbeddingIndex();

    await index.upsert({
      id: "m1",
      vector: await provider.embed("项目 A 使用 PostgreSQL"),
      metadata: { level: "L2" }
    });
    await index.upsert({
      id: "m2",
      vector: await provider.embed("用户偏好 TypeScript"),
      metadata: { level: "L3" }
    });

    const results = await index.search(await provider.embed("项目 A 数据库 PostgreSQL"), { limit: 1 });

    expect(results).toEqual([expect.objectContaining({ id: "m1" })]);
  });

  it("persists vector records in SQLite with scope filtering", async () => {
    const db = createDatabase(":memory:");
    const index = new SqliteVectorIndex(db);

    await index.upsert({
      id: "m1",
      vector: [1, 0, 0],
      metadata: { mis: "u1", level: "L2" }
    });
    await index.upsert({
      id: "m2",
      vector: [0, 1, 0],
      metadata: { mis: "u2", level: "L2" }
    });

    const scoped = await index.search([1, 0, 0], { limit: 3, filter: { mis: "u1" } });
    expect(scoped).toEqual([expect.objectContaining({ id: "m1", metadata: { mis: "u1", level: "L2" } })]);

    await index.delete("m1");
    expect(await index.search([1, 0, 0], { filter: { mis: "u1" } })).toEqual([]);
  });

  it("validates OpenAI-compatible embedding dimensions and reports provider failures", async () => {
    const okProvider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://embedding.local",
      apiKey: "test-key",
      model: "test-model",
      dimensions: 3,
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });

    await expect(okProvider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);

    const badProvider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://embedding.local",
      apiKey: "test-key",
      model: "test-model",
      dimensions: 3,
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });

    await expect(badProvider.embed("hello")).rejects.toThrow("dimension");

    const failingProvider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://embedding.local",
      apiKey: "test-key",
      model: "test-model",
      dimensions: 3,
      fetch: async () => new Response("bad gateway", { status: 502 })
    });

    await expect(failingProvider.embed("hello")).rejects.toThrow("Embedding provider request failed");
  });
});

describe("memory storage", () => {
  it("keeps persistence behind a replaceable MemoryStore interface", () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));

    const turn = store.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    const memory = store.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: [turn.id],
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    expect(store.getMemory(memory.id)).toEqual(memory);
    expect(store.listMemories({ mis: "u1" })).toEqual([memory]);
  });

  it("persists turns, memories, and relations", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);

    const turn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    const memory = repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: [turn.id],
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    const relation = repo.createRelation(memory.id, memory.id, "related", 0.5);

    expect(repo.listTurns()).toHaveLength(1);
    expect(repo.listMemories({ mis: "u1" })).toHaveLength(1);
    expect(repo.listRelations(memory.id)).toEqual([relation]);
  });
});

describe("memory application service", () => {
  it("ingests turns without depending on HTTP transport", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    const first = await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 MySQL",
      ...scope
    });
    await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      ...scope
    });
    const flushed = await service.flushSessionTopic(scope, "s1");

    expect(first.topic).toMatchObject({ summary: "项目 A 使用 MySQL", status: "partial" });
    expect(first.memories).toHaveLength(0);
    expect(flushed.topic).toMatchObject({ status: "complete" });
    expect(flushed.memories[0]).toMatchObject({ level: "topic", type: "topic", subject: "项目 A", status: "active" });
    expect(flushed.memories).toHaveLength(1);
    expect(store.listMemories(scope).map((memory): string => memory.level)).not.toContain("L1");
    expect(
      (await service.search({ query: "项目 A 数据库", ...scope })).results.some((result) =>
        result.memory.object.includes("PostgreSQL")
      )
    ).toBe(true);
  });

  it("creates topic memories without creating L2 during online ingestion", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store);

    await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const result = await service.flushSessionTopic(
      { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} },
      "s1"
    );

    expect(result.topic).toMatchObject({ status: "complete" });
    expect(result.memories[0]).toMatchObject({ level: "topic", type: "topic", subject: "项目 A" });
    expect(result.memories).toHaveLength(1);
    expect(store.listMemories().some((memory) => memory.level === "L2")).toBe(false);
    expect(store.listMemories().map((memory): string => memory.level)).not.toContain("L1");
  });

  it("resolves topic memory updates and relations before rebuilding L2", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 使用 MySQL", ...scope });
    const first = await service.flushSessionTopic(scope, "s1");
    await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      ...scope
    });
    const second = await service.flushSessionTopic(scope, "s1");

    expect(store.getMemory(first.memories[0].id)?.status).toBe("superseded");
    expect(second.memories[0]).toMatchObject({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      supersedesId: first.memories[0].id
    });
    expect(store.listRelations(first.memories[0].id)).toEqual([expect.objectContaining({ relationType: "update" })]);
    expect(store.listMemories(scope).some((memory) => memory.level === "L2")).toBe(false);
  });

  it("builds sliding windows within the current session only", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const seenWindows: string[][] = [];
    const detector: TopicBoundaryDetector = {
      detectBoundary({ existingTurns, newTurn }) {
        const turns = [...existingTurns, newTurn];
        seenWindows.push(turns.map((turn) => `${turn.sessionId}:${turn.content}`));
        return {
          shouldClose: turns.length >= 2,
          confidence: turns.length >= 2 ? 0.9 : 0.4,
          reason: "test"
        };
      }
    };
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(detector, new RuleBasedTopicMemoryGenerator(), { maxSize: 3, minConfidence: 0.7 })
    });
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    await service.ingestTurn({ sessionId: "s2", role: "user", content: "项目 B 使用 Redis", ...scope });
    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 使用 MySQL", ...scope });
    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 已迁移到 PostgreSQL", ...scope });

    expect(seenWindows.at(-1)).toEqual(["s1:项目 A 使用 MySQL", "s1:项目 A 已迁移到 PostgreSQL"]);
  });

  it("supports custom project builder and compressor strategies", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store, {
      projectMemoryBuilder: {
        rebuild(memoryStore, scope) {
          return [
            memoryStore.createMemory({
              level: "L2",
              type: "project",
              subject: "custom-project",
              predicate: "聚合",
              object: "custom",
              summary: "custom project",
              confidence: 0.5,
              status: "active",
              supersedesId: null,
              sourceTurnIds: [],
              ...scope
            })
          ];
        }
      },
      compressor: {
        compress(memoryStore, scope) {
          return {
            createdOrUpdated: [
              memoryStore.createMemory({
                level: "L3",
                type: "profile",
                subject: "custom-profile",
                predicate: "exists",
                object: "yes",
                summary: "custom profile exists",
                confidence: 0.5,
                status: "active",
                supersedesId: null,
                sourceTurnIds: [],
                ...scope
              })
            ]
          };
        }
      }
    });

    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 SQLite",
      ...scope
    });
    const result = await service.flushSessionTopic(scope, "s1");
    const dreaming = service.runDreaming(scope);

    const projects = await service.runProjectBuild(scope);
    expect(result.memories[0]).toMatchObject({ level: "topic" });
    expect(projects.createdOrUpdated[0].summary).toContain("custom project");
    expect(store.listMemories(scope).map((memory) => memory.subject)).toContain("custom-project");
    expect(dreaming.createdOrUpdated[0]).toMatchObject({ subject: "custom-profile" });
  });

  it("indexes ingested memories and uses vector score during service search", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const embeddingProvider = new DeterministicEmbeddingProvider(32);
    const embeddingIndex = new TrackingEmbeddingIndex();
    const service = createMemoryService(store, {
      embeddingProvider,
      embeddingIndex
    });

    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 alpha 使用 postgresql",
      ...scope
    });
    await service.flushSessionTopic(scope, "s1");

    const results = await service.search({ query: "postgresql database", ...scope });

    expect(embeddingIndex.upsertedIds).toHaveLength(1);
    expect(embeddingIndex.searchCount).toBe(1);
    expect(results.results[0]).toMatchObject({
      memory: { level: "topic", subject: "项目 alpha" }
    });
    expect(results.results[0].score).toBeGreaterThan(10);
  });
});

describe("topic extraction layer", () => {
  it("closes the current session buffer when a new unrelated instruction starts", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    const detector: TopicBoundaryDetector = {
      detectBoundary({ existingTurns, newTurn }) {
        const unrelated = newTurn.content.includes("项目 B");
        if (unrelated) {
          const projectATurns = existingTurns.filter((turn) => turn.content.includes("项目 A"));
          return {
            shouldClose: true,
            confidence: 0.9,
            reason: "new unrelated project starts",
            closedTurnIds: projectATurns.map((turn) => turn.id)
          };
        }
        return {
          shouldClose: false,
          confidence: 0.4,
          reason: "topic still open"
        };
      }
    };
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(
        detector,
        {
          generate(input) {
            return {
              title: "项目 A 数据库",
              summary: "项目 A 使用 PostgreSQL",
              topicType: "project_work",
              entities: ["项目 A"],
              decisions: [],
              tasks: [],
              preferences: [],
              confidence: 0.9,
              reason: input.reason,
              evidenceTurnIds: input.turns.map((turn) => turn.id)
            };
          }
        },
        { maxSize: 8, minConfidence: 0.7 }
      )
    });

    const first = await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 使用 MySQL", ...scope });
    const second = await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      ...scope
    });
    const closed = await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 B 使用 Redis", ...scope });

    expect(first.memories).toEqual([]);
    expect(second.memories).toEqual([]);
    expect(closed.memories[0]).toMatchObject({ level: "topic", subject: "项目 A", object: "项目 A 使用 PostgreSQL" });
    expect(closed.memories[0].sourceTurnIds).toEqual([first.turn.id, second.turn.id]);
    expect(
      store.listTopicSegments(scope).find((topic) => topic.status === "partial" && topic.sessionId === "s1")?.turnIds
    ).toEqual([closed.turn.id]);
  });

  it("forces the open buffer to close when it reaches max size", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(
        {
          detectBoundary() {
            return {
              shouldClose: false,
              confidence: 0.5,
              reason: "waiting for more context"
            };
          }
        },
        new RuleBasedTopicMemoryGenerator(),
        { maxSize: 2, minConfidence: 0.7 }
      )
    });
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 使用 MySQL", ...scope });
    const result = await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      ...scope
    });

    expect(result.topic).toMatchObject({ status: "complete", reason: "max window size reached" });
    expect(result.memories[0]).toMatchObject({ level: "topic", subject: "项目 A" });
  });

  it("keeps growing the open L0 buffer until max window creates topic memory", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    const sizes: number[] = [];
    const detector: TopicBoundaryDetector = {
      async detectBoundary({ existingTurns, newTurn }) {
        sizes.push([...existingTurns, newTurn].length);
        return {
          shouldClose: false,
          confidence: 0.4,
          reason: "needs earlier context"
        };
      }
    };
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(detector, new RuleBasedTopicMemoryGenerator(), { maxSize: 3, minConfidence: 0.7 })
    });

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "为什么？", ...scope });
    await service.ingestTurn({ sessionId: "s1", role: "assistant", content: "因为 MySQL 成本高", ...scope });
    const result = await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 已迁移到 PostgreSQL", ...scope });

    expect(sizes.slice(-2)).toEqual([2, 3]);
    expect(result.topic).toMatchObject({ status: "complete" });
    expect(result.memories[0]).toMatchObject({ level: "topic", subject: "项目 A" });
    expect(result.memories[0].sourceTurnIds).toEqual(result.topic?.turnIds);
    expect(store.listMemories(scope).map((memory): string => memory.level)).not.toContain("L1");
  });

  it("skips extraction when the turn is noise", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store, {
      topicBuilder: new SlidingTopicBuilder(
        {
          detectBoundary() {
            return {
              shouldClose: true,
              confidence: 0.95,
              reason: "small talk"
            };
          }
        },
        new RuleBasedTopicMemoryGenerator(),
        { maxSize: 1, minConfidence: 0.7 }
      )
    });

    const result = await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "好的",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    expect(result.topic).toBeNull();
    expect(result.memories).toEqual([]);
    expect(store.listMemories()).toEqual([]);
  });

  it("reuses duplicate topic memories through resolver", async () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      ...scope
    });
    const first = await service.flushSessionTopic(scope, "s1");
    await service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      ...scope
    });
    const duplicate = await service.flushSessionTopic(scope, "s1");

    expect(first.memories).toHaveLength(1);
    expect(duplicate.memories[0].id).toBe(first.memories[0].id);
    expect(store.listMemories(scope).map((memory): string => memory.level)).not.toContain("L1");
    expect(store.listMemories(scope).filter((memory) => memory.level === "topic")).toHaveLength(1);
    expect(store.listMemories(scope).filter((memory) => memory.level === "L2")).toHaveLength(0);
  });
});

describe("memory api", () => {
  it("writes turns, searches memories, manages status, lists relations, and runs dreaming", async () => {
    const db = createDatabase(":memory:");
    const app = buildServer(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    const first = await app.inject({
      method: "POST",
      url: "/turns",
      payload: { sessionId: "s1", role: "user", content: "项目 A 使用 MySQL", ...scope }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().memories).toHaveLength(0);

    const firstFlush = await app.inject({
      method: "POST",
      url: "/sessions/s1/topics/flush",
      payload: scope
    });
    expect(firstFlush.statusCode).toBe(200);
    expect(firstFlush.json().memories).toHaveLength(1);

    const second = await app.inject({
      method: "POST",
      url: "/turns",
      payload: { sessionId: "s1", role: "user", content: "项目 A 已迁移到 PostgreSQL", ...scope }
    });
    expect(second.statusCode).toBe(200);
    const secondFlush = await app.inject({
      method: "POST",
      url: "/sessions/s1/topics/flush",
      payload: scope
    });
    expect(secondFlush.statusCode).toBe(200);
    const activeId = secondFlush.json().memories[0].id;

    const search = await app.inject({
      method: "POST",
      url: "/search",
      payload: { query: "项目 A 数据库", ...scope }
    });
    expect(search.statusCode).toBe(200);
    expect(
      search.json().results.some((result: { memory: { object: string } }) => result.memory.object.includes("PostgreSQL"))
    ).toBe(true);

    const patch = await app.inject({
      method: "PATCH",
      url: `/memories/${activeId}`,
      payload: { status: "deleted" }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().memory.status).toBe("deleted");

    const relations = await app.inject({ method: "GET", url: `/memories/${activeId}/relations` });
    expect(relations.statusCode).toBe(200);
    expect(relations.json().relations).toEqual([expect.objectContaining({ relationType: "update" })]);

    await app.inject({
      method: "POST",
      url: "/turns",
      payload: { sessionId: "s1", role: "user", content: "我偏好 TypeScript", ...scope }
    });
    await app.inject({
      method: "POST",
      url: "/sessions/s1/topics/flush",
      payload: scope
    });
    const dreaming = await app.inject({
      method: "POST",
      url: "/dreaming/run",
      payload: scope
    });
    expect(dreaming.statusCode).toBe(200);
    expect(dreaming.json().createdOrUpdated[0]).toMatchObject({ level: "L3", object: "TypeScript" });

    const list = await app.inject({ method: "GET", url: "/memories?mis=u1&source=test&agent=agent&channel=default" });
    expect(list.statusCode).toBe(200);
    expect(list.json().memories.length).toBeGreaterThan(0);

    await app.close();
  });

  it("returns 400 when scope is missing", async () => {
    const db = createDatabase(":memory:");
    const app = buildServer(db);
    const response = await app.inject({
      method: "POST",
      url: "/turns",
      payload: { sessionId: "s1", role: "user", content: "项目 A 使用 MySQL" }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("extractor strategies", () => {
  it("keeps rule-based extractor compatible with extractMemories", () => {
    const store = new SqliteMemoryStore(createDatabase(":memory:"));
    const turn = store.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    expect(new RuleBasedMemoryExtractor().extract(turn, [])).toEqual(extractMemories(turn, []));
  });

  it("validates LLM extractor JSON and falls back through hybrid extractor", async () => {
    const store = new SqliteMemoryStore(createDatabase(":memory:"));
    const turn = store.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    const invalid = new LlmMemoryExtractor({
      complete: async () => "not-json"
    });
    await expect(invalid.extract(turn, [])).rejects.toThrow("Invalid LLM memory extraction response");

    const hybrid = new HybridMemoryExtractor(invalid, new RuleBasedMemoryExtractor());
    await expect(hybrid.extract(turn, [])).resolves.toEqual(extractMemories(turn, []));
  });
});

describe("strategy compatibility", () => {
  it("keeps default strategies compatible with existing functions", async () => {
    const store = new SqliteMemoryStore(createDatabase(":memory:"));
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    const turn = store.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      ...scope
    });
    const draft = extractMemories(turn, [])[0];
    const resolved = new RuleBasedMemoryResolver().resolve(store, draft);
    store.createMemory({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      predicate: "topic",
      object: "项目 A 使用 PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: [turn.id],
      ...scope
    });
    const projects = await new ModelProjectMemoryBuilder({
      extract() {
        return [
          {
            level: "L2",
            type: "project",
            subject: "项目 A",
            predicate: "project",
            object: "项目 A 使用 PostgreSQL",
            summary: "项目 A 使用 PostgreSQL",
            confidence: 0.8,
            status: "active",
            supersedesId: null,
            sourceTurnIds: [turn.id],
            ...scope
          }
        ];
      }
    }).rebuild(store, scope);
    const compressed = new RuleBasedMemoryCompressor().compress(store, scope);

    expect(resolved).toMatchObject({ subject: "项目 A", predicate: "使用", object: "PostgreSQL" });
    expect(projects[0]).toMatchObject({ level: "L2", subject: "项目 A" });
    expect(compressed).toEqual(runDreaming(store, scope));
  });
});

describe("cli ingestion", () => {
  it("ingests one turn and imports a batch through MemoryService", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-my-memory-"));
    const dbPath = join(dir, "memory.sqlite");
    const batchPath = join(dir, "batch.json");

    const single = await runCli([
      "ingest",
      "--db",
      dbPath,
      "--session-id",
      "s1",
      "--role",
      "user",
      "--content",
      "项目 A 使用 MySQL",
      "--mis",
      "u1",
      "--source",
      "cli",
      "--agent",
      "demo",
      "--channel",
      "default"
    ]);
    expect(single.exitCode).toBe(0);

    writeFileSync(
      batchPath,
      JSON.stringify([
        {
          sessionId: "s1",
          role: "user",
          content: "项目 A 已迁移到 PostgreSQL",
          mis: "u1",
          source: "cli",
          agent: "demo",
          channel: "default",
          metadata: {}
        },
        {
          role: "user",
          content: "missing session id",
          mis: "u1",
          source: "cli",
          agent: "demo",
          channel: "default",
          metadata: {}
        }
      ])
    );

    const imported = await runCli(["import", "--db", dbPath, batchPath]);
    expect(imported.exitCode).toBe(1);
    expect(imported.stdout).toContain('"success":1');
    expect(imported.stdout).toContain('"failed":1');

    const store = new SqliteMemoryStore(createDatabase(dbPath));
    expect(store.listMemories({ mis: "u1" }).some((memory) => memory.object.includes("PostgreSQL"))).toBe(true);
  });
});

describe("memory search", () => {
  it("searches L3 and L2 but excludes superseded and deleted memories", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "MySQL",
      summary: "项目 A 使用 MySQL",
      confidence: 0.8,
      status: "superseded",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope
    });
    repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t2"],
      ...scope
    });
    repo.createMemory({
      level: "L3",
      type: "profile",
      subject: "用户",
      predicate: "偏好",
      object: "TypeScript",
      summary: "用户偏好 TypeScript",
      confidence: 0.9,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t3"],
      ...scope
    });

    const results = searchMemories(repo, { query: "项目 A 数据库", ...scope });

    expect(results.map((result) => result.memory.object)).toContain("PostgreSQL");
    expect(results.map((result) => result.memory.object)).not.toContain("MySQL");
  });

  it("prefers same scope and active current facts", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope
    });
    repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "SQLite",
      summary: "项目 A 使用 SQLite",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t2"],
      mis: "u2",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    const results = searchMemories(repo, { query: "项目 A 使用", ...scope });

    expect(results).toHaveLength(1);
    expect(results[0].memory.object).toBe("PostgreSQL");
  });
});

describe("project memory and dreaming", () => {
  it("passes structured topic inputs into the L2 project extractor", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    const topic = repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      predicate: "topic",
      object: "项目 A 决定使用 SQLite",
      summary: "项目 A 决定使用 SQLite",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope,
      metadata: {
        topicType: "project_work",
        entities: ["项目 A"],
        decisions: ["使用 SQLite"],
        tasks: ["实现 L2 定时任务"],
        preferences: []
      }
    });

    expect(buildProjectTopicInputs([topic])).toEqual([
      expect.objectContaining({
        id: topic.id,
        summary: "项目 A 决定使用 SQLite",
        topicType: "project_work",
        entities: ["项目 A"],
        decisions: ["使用 SQLite"],
        tasks: ["实现 L2 定时任务"]
      })
    ]);

    await rebuildProjectMemories(repo, scope, {
      extract(input) {
        expect(input.topicInputs).toEqual([
          expect.objectContaining({
            id: topic.id,
            topicType: "project_work",
            entities: ["项目 A"],
            decisions: ["使用 SQLite"],
            tasks: ["实现 L2 定时任务"]
          })
        ]);
        return [];
      }
    });
  });

  it("runs scheduled project builds for scopes with active topic memories", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scopeA = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: { team: "a" } };
    const scopeB = { mis: "u2", source: "test", agent: "agent", channel: "default", metadata: { team: "b" } };
    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      predicate: "topic",
      object: "项目 A",
      summary: "项目 A",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scopeA
    });
    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "项目 B",
      predicate: "topic",
      object: "项目 B",
      summary: "项目 B",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t2"],
      ...scopeB
    });
    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "旧项目",
      predicate: "topic",
      object: "旧项目",
      summary: "旧项目",
      confidence: 0.8,
      status: "deleted",
      supersedesId: null,
      sourceTurnIds: ["t3"],
      ...scopeB
    });

    const scopesRun: string[] = [];
    const service = createMemoryService(repo, {
      projectMemoryBuilder: {
        rebuild(_store, scope) {
          scopesRun.push(`${scope.mis}:${scope.metadata.team as string}`);
          return [];
        }
      }
    });

    const result = await runScheduledProjectBuild(service);

    expect(result.scopesRun).toBe(2);
    expect(result.errors).toEqual([]);
    expect(scopesRun.sort()).toEqual(["u1:a", "u2:b"]);
    expect(loadProjectBuildSchedulerConfig({ PROJECT_BUILD_ENABLED: "true", PROJECT_BUILD_INTERVAL_MS: "60000" })).toEqual({
      enabled: true,
      intervalMs: 60000
    });
  });

  it("records scheduled project build runs", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      predicate: "topic",
      object: "项目 A",
      summary: "项目 A",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope
    });
    const service = createMemoryService(repo, {
      projectMemoryBuilder: {
        rebuild(memoryStore, scope) {
          return [
            memoryStore.createMemory({
              level: "L2",
              type: "project",
              subject: "项目 A",
              predicate: "project",
              object: "项目 A 已聚合",
              summary: "项目 A 已聚合",
              confidence: 0.8,
              status: "active",
              supersedesId: null,
              sourceTurnIds: ["t1"],
              ...scope
            })
          ];
        }
      }
    });

    const result = await runScheduledProjectBuild(service);
    const [run] = service.listProjectBuildRuns().runs;

    expect(result.createdOrUpdated).toBe(1);
    expect(run).toMatchObject({
      scopesRun: 1,
      createdOrUpdated: 1,
      status: "success",
      errors: []
    });
    expect(Date.parse(run.startedAt)).not.toBeNaN();
    expect(Date.parse(run.endedAt)).not.toBeNaN();
  });

  it("exposes project build run records through HTTP", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };
    const service = createMemoryService(repo);
    service.recordProjectBuildRun({
      startedAt: "2026-06-18T00:00:00.000Z",
      endedAt: "2026-06-18T00:00:01.000Z",
      scopesRun: 1,
      createdOrUpdated: 2,
      status: "success",
      errors: []
    });
    const app = buildServer(service);

    const response = await app.inject({ method: "GET", url: "/projects/runs?limit=1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().runs).toEqual([
      expect.objectContaining({
        scopesRun: 1,
        createdOrUpdated: 2,
        status: "success",
        errors: []
      })
    ]);

    await app.close();
  });

  it("builds L2 project memory from topic memories with a model extractor", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      predicate: "topic",
      object: "项目 A 使用 PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope
    });
    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "项目 A",
      predicate: "topic",
      object: "项目 A 后端 Node.js",
      summary: "项目 A 后端 Node.js",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t2"],
      ...scope
    });

    const [project] = await rebuildProjectMemories(
      repo,
      scope,
      {
        extract(input) {
          expect(input.topics.map((topic) => topic.summary)).toEqual(["项目 A 使用 PostgreSQL", "项目 A 后端 Node.js"]);
          return [
            {
              level: "L2",
              type: "project",
              subject: "oh-my-memory",
              predicate: "project",
              object: "oh-my-memory project memory",
              summary: "oh-my-memory covers PostgreSQL storage and Node.js backend work.",
              confidence: 0.86,
              status: "active",
              supersedesId: null,
              sourceTurnIds: ["t1", "t2"],
              ...scope
            }
          ];
        }
      }
    );

    expect(project).toMatchObject({
      level: "L2",
      type: "project",
      subject: "oh-my-memory",
      status: "active"
    });
    expect(project.summary).toContain("PostgreSQL");
    expect(project.summary).toContain("Node.js");
  });

  it("promotes preference topics into L3 profile memories", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "用户",
      predicate: "topic",
      object: "用户偏好 TypeScript",
      summary: "用户偏好 TypeScript",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope
    });
    repo.createMemory({
      level: "topic",
      type: "topic",
      subject: "用户",
      predicate: "topic",
      object: "用户偏好 TypeScript",
      summary: "用户偏好 TypeScript",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t2"],
      ...scope
    });

    const result = runDreaming(repo, scope);

    expect(result.createdOrUpdated).toHaveLength(1);
    expect(result.createdOrUpdated[0]).toMatchObject({
      level: "L3",
      type: "profile",
      subject: "用户",
      predicate: "偏好",
      object: "TypeScript"
    });
  });
});

describe("memory extraction and resolution", () => {
  it("filters noise and extracts valuable legacy facts", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const noiseTurn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "谢谢",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const projectTurn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    expect(extractMemories(noiseTurn, [])).toEqual([]);
    expect(extractMemories(projectTurn, [])).toMatchObject([
      { subject: "项目 A", predicate: "使用", object: "PostgreSQL" }
    ]);
  });

  it("supersedes old memory when subject and predicate match with a new object", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const old = repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "MySQL",
      summary: "项目 A 使用 MySQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const turn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    const [draft] = extractMemories(turn, []);
    const newMemory = resolveMemory(repo, draft);

    expect(repo.getMemory(old.id)?.status).toBe("superseded");
    expect(newMemory.supersedesId).toBe(old.id);
    expect(newMemory.status).toBe("active");
    expect(repo.listRelations(old.id)).toEqual([
      expect.objectContaining({ relationType: "update", fromMemoryId: old.id, toMemoryId: newMemory.id })
    ]);
  });

  it("merges duplicate memory by adding source turns", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const old = repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const turn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });

    const [draft] = extractMemories(turn, []);
    const merged = resolveMemory(repo, draft);

    expect(merged.id).toBe(old.id);
    expect(merged.sourceTurnIds).toEqual(["t1", turn.id]);
    expect(repo.listMemories()).toHaveLength(1);
    expect(repo.listRelations(old.id)).toEqual([
      expect.objectContaining({ relationType: "duplicate", fromMemoryId: old.id, toMemoryId: old.id })
    ]);
  });

  it("lets an LLM choose update for conflicting memories", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const old = repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "MySQL",
      summary: "项目 A 使用 MySQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const turn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const [draft] = extractMemories(turn, []);
    const resolver = new LlmMemoryResolver({
      complete: async () => JSON.stringify({ operation: "update", targetMemoryId: old.id, confidence: 0.92 })
    });

    const memory = await resolver.resolve(repo, draft);

    expect(repo.getMemory(old.id)?.status).toBe("superseded");
    expect(memory).toMatchObject({ object: "PostgreSQL", supersedesId: old.id, status: "active" });
    expect(repo.listRelations(old.id)).toEqual([
      expect.objectContaining({ relationType: "update", fromMemoryId: old.id, toMemoryId: memory.id })
    ]);
  });

  it("lets an LLM choose none for duplicate memories", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const old = repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "PostgreSQL",
      summary: "项目 A 使用 PostgreSQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const turn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const [draft] = extractMemories(turn, []);
    const resolver = new LlmMemoryResolver({
      complete: async () => JSON.stringify({ operation: "none", targetMemoryId: old.id, confidence: 0.96 })
    });

    const memory = await resolver.resolve(repo, draft);

    expect(memory.id).toBe(old.id);
    expect(memory.sourceTurnIds).toEqual(["t1", turn.id]);
    expect(repo.listMemories()).toHaveLength(1);
    expect(repo.listRelations(old.id)).toEqual([
      expect.objectContaining({ relationType: "duplicate", fromMemoryId: old.id, toMemoryId: old.id })
    ]);
  });

  it("falls back to rule-based resolution when LLM decision is invalid", async () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const old = repo.createMemory({
      level: "L2",
      type: "fact",
      subject: "项目 A",
      predicate: "使用",
      object: "MySQL",
      summary: "项目 A 使用 MySQL",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const turn = repo.createTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      mis: "u1",
      source: "test",
      agent: "agent",
      channel: "default",
      metadata: {}
    });
    const [draft] = extractMemories(turn, []);
    const resolver = new HybridMemoryResolver(new LlmMemoryResolver({ complete: async () => "bad-json" }));

    const memory = await resolver.resolve(repo, draft);

    expect(repo.getMemory(old.id)?.status).toBe("superseded");
    expect(memory).toMatchObject({ object: "PostgreSQL", supersedesId: old.id });
  });
});
