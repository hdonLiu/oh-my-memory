import { describe, expect, it } from "vitest";
import {
  DeterministicEmbeddingProvider,
  InMemoryEmbeddingIndex,
  cosineSimilarity
} from "../src/domain/embedding.js";
import { extractMemories } from "../src/domain/extractor.js";
import { runDreaming } from "../src/domain/dreaming.js";
import { rebuildProjectMemories } from "../src/domain/project-memory.js";
import { resolveMemory } from "../src/domain/resolver.js";
import { searchMemories } from "../src/domain/search.js";
import { createMemoryService } from "../src/application/memory-service.js";
import { buildServer } from "../src/server.js";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";
import { SqliteMemoryStore } from "../src/storage/sqlite-store.js";
import type { MemoryStore } from "../src/storage/store.js";

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
      metadata: { level: "L1" }
    });
    await index.upsert({
      id: "m2",
      vector: await provider.embed("用户偏好 TypeScript"),
      metadata: { level: "L3" }
    });

    const results = await index.search(await provider.embed("项目 A 数据库 PostgreSQL"), { limit: 1 });

    expect(results).toEqual([expect.objectContaining({ id: "m1" })]);
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
      level: "L1",
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
      level: "L1",
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
  it("ingests turns without depending on HTTP transport", () => {
    const store: MemoryStore = new SqliteMemoryStore(createDatabase(":memory:"));
    const service = createMemoryService(store);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    const first = service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 使用 MySQL",
      ...scope
    });
    const second = service.ingestTurn({
      sessionId: "s1",
      role: "user",
      content: "项目 A 已迁移到 PostgreSQL",
      ...scope
    });

    expect(first.memories[0]).toMatchObject({ object: "MySQL", status: "active" });
    expect(second.memories[0]).toMatchObject({ object: "PostgreSQL", status: "active" });
    expect(service.search({ query: "项目 A 数据库", ...scope }).results.map((result) => result.memory.object)).toContain(
      "PostgreSQL"
    );
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
    expect(first.json().memories).toHaveLength(1);

    const second = await app.inject({
      method: "POST",
      url: "/turns",
      payload: { sessionId: "s1", role: "user", content: "项目 A 已迁移到 PostgreSQL", ...scope }
    });
    expect(second.statusCode).toBe(200);
    const activeId = second.json().memories[0].id;

    const search = await app.inject({
      method: "POST",
      url: "/search",
      payload: { query: "项目 A 数据库", ...scope }
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results.map((result: { memory: { object: string } }) => result.memory.object)).toContain(
      "PostgreSQL"
    );

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

describe("memory search", () => {
  it("searches L3, L2, and L1 but excludes superseded and deleted memories", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    repo.createMemory({
      level: "L1",
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
      level: "L1",
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
      level: "L1",
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
      level: "L1",
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
  it("builds L2 project memory from related L1 memories", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    repo.createMemory({
      level: "L1",
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
      level: "L1",
      type: "fact",
      subject: "项目 A",
      predicate: "后端",
      object: "Node.js",
      summary: "项目 A 后端 Node.js",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t2"],
      ...scope
    });

    const [project] = rebuildProjectMemories(repo, scope);

    expect(project).toMatchObject({
      level: "L2",
      type: "project",
      subject: "项目 A",
      status: "active"
    });
    expect(project.summary).toContain("使用 PostgreSQL");
    expect(project.summary).toContain("后端 Node.js");
  });

  it("promotes stable repeated memories into L3 profile memories", () => {
    const db = createDatabase(":memory:");
    const repo = new MemoryRepository(db);
    const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

    repo.createMemory({
      level: "L1",
      type: "preference",
      subject: "用户",
      predicate: "偏好",
      object: "TypeScript",
      summary: "用户偏好 TypeScript",
      confidence: 0.8,
      status: "active",
      supersedesId: null,
      sourceTurnIds: ["t1"],
      ...scope
    });
    repo.createMemory({
      level: "L1",
      type: "preference",
      subject: "用户",
      predicate: "偏好",
      object: "TypeScript",
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
  it("filters noise and extracts valuable L1 facts", () => {
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
      level: "L1",
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
      level: "L1",
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
});
