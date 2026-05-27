# oh-my-memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local oh-my-memory-inspired memory service with L0/L1/L2/L3 storage, memory extraction, supersede evolution, relation handling, Dreaming compression, and search APIs.

**Architecture:** Use a small Fastify TypeScript service backed by SQLite. Keep model-free MVP logic in isolated domain modules so extractor, similarity, resolver, search, and Dreaming can later be replaced by LLM/Embedding implementations.

**Tech Stack:** Node.js, TypeScript, Fastify, better-sqlite3, Vitest, tsx.

---

## File Structure

- Create `package.json`: scripts and dependencies.
- Create `tsconfig.json`: strict TypeScript config.
- Create `src/domain/types.ts`: shared domain types and enums.
- Create `src/storage/database.ts`: SQLite schema, connection, reset helper.
- Create `src/storage/repositories.ts`: repository methods for turns, memories, relations.
- Create `src/domain/text.ts`: tokenization, Jaccard similarity, simple text helpers.
- Create `src/domain/extractor.ts`: rule-based value filtering and L1 extraction.
- Create `src/domain/resolver.ts`: duplicate/update/support/related handling.
- Create `src/domain/project-memory.ts`: L2 project aggregation.
- Create `src/domain/dreaming.ts`: L3 promotion and compression.
- Create `src/domain/search.ts`: multi-level scoped search.
- Create `src/server.ts`: Fastify API routes.
- Create `src/index.ts`: app entry.
- Create `tests/memory.test.ts`: end-to-end domain/API behavior.

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Create package metadata**

```json
{
  "name": "oh-my-memory",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.1",
    "better-sqlite3": "^11.9.1",
    "fastify": "^4.28.1",
    "nanoid": "^5.1.5",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.13.10",
    "tsx": "^4.19.3",
    "typescript": "^5.8.2",
    "vitest": "^3.0.8"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`

Expected: `node_modules` and `package-lock.json` are created.

- [ ] **Step 4: Verify empty project tooling**

Run: `npm run typecheck`

Expected: TypeScript reports no source files or no type errors after `src` exists in later tasks.

## Task 2: Domain Types and SQLite Storage

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/storage/database.ts`
- Create: `src/storage/repositories.ts`
- Test: `tests/memory.test.ts`

- [ ] **Step 1: Write storage test**

```ts
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";

describe("memory storage", () => {
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
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm test -- tests/memory.test.ts`

Expected: FAIL because storage files do not exist.

- [ ] **Step 3: Add domain types**

```ts
export type MemoryLevel = "L1" | "L2" | "L3";
export type MemoryType = "fact" | "preference" | "decision" | "profile" | "project";
export type MemoryStatus = "active" | "superseded" | "deleted";
export type RelationType = "duplicate" | "update" | "contradict" | "support" | "related";
export type Role = "user" | "assistant" | "system";

export interface Scope {
  mis: string;
  source: string;
  agent: string;
  channel: string;
  metadata: Record<string, unknown>;
}

export interface ConversationTurn extends Scope {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface Memory extends Scope {
  id: string;
  level: MemoryLevel;
  type: MemoryType;
  subject: string;
  predicate: string;
  object: string;
  summary: string;
  confidence: number;
  status: MemoryStatus;
  supersedesId: string | null;
  sourceTurnIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRelation {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: RelationType;
  confidence: number;
  createdAt: string;
}
```

- [ ] **Step 4: Add SQLite schema**

```ts
import Database from "better-sqlite3";

export function createDatabase(path = process.env.MEMORY_DB_PATH ?? "memory.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists conversation_turns (
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
    );

    create table if not exists memories (
      id text primary key,
      level text not null,
      type text not null,
      subject text not null,
      predicate text not null,
      object text not null,
      summary text not null,
      confidence real not null,
      status text not null,
      supersedes_id text,
      source_turn_ids text not null,
      mis text not null,
      source text not null,
      agent text not null,
      channel text not null,
      metadata text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists memory_relations (
      id text primary key,
      from_memory_id text not null,
      to_memory_id text not null,
      relation_type text not null,
      confidence real not null,
      created_at text not null
    );
  `);
  return db;
}
```

- [ ] **Step 5: Add repository**

Implement `MemoryRepository` with these methods:

```ts
createTurn(input)
listTurns()
createMemory(input)
updateMemory(id, patch)
listMemories(scope)
createRelation(fromMemoryId, toMemoryId, relationType, confidence)
listRelations(memoryId)
```

Mapping rule: database uses snake_case, TypeScript uses camelCase. JSON fields are serialized with `JSON.stringify` and parsed with `JSON.parse`.

- [ ] **Step 6: Run test**

Run: `npm test -- tests/memory.test.ts`

Expected: PASS.

## Task 3: Extractor and Resolver

**Files:**
- Create: `src/domain/text.ts`
- Create: `src/domain/extractor.ts`
- Create: `src/domain/resolver.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests for:

```ts
it("filters noise and extracts valuable L1 facts", () => {});
it("supersedes old memory when subject and predicate match with a new object", () => {});
it("merges duplicate memory by adding source turns", () => {});
```

Assertions:

```ts
expect(extractMemories(noiseTurn, [])).toEqual([]);
expect(extractMemories(projectTurn, [])).toMatchObject([{ subject: "项目 A", predicate: "使用", object: "PostgreSQL" }]);
expect(old.status).toBe("superseded");
expect(newMemory.supersedesId).toBe(old.id);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/memory.test.ts`

Expected: FAIL because extractor and resolver do not exist.

- [ ] **Step 3: Implement text helpers**

```ts
export function tokenize(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)));
}

export function jaccard(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  const union = new Set([...left, ...right]);
  const intersection = left.filter((token) => right.includes(token));
  return union.size === 0 ? 0 : intersection.length / union.size;
}

export function isNoise(content: string): boolean {
  const trimmed = content.trim();
  return ["你好", "谢谢", "好的", "ok", "OK"].includes(trimmed) || trimmed.length < 4;
}
```

- [ ] **Step 4: Implement extractor**

Rules:

```text
项目 X 使用 Y -> fact
项目 X 用的是 Y -> fact
项目 X 已迁移到 Y -> fact/update
我喜欢 X / 我偏好 X -> preference
决定 X / 决策 X -> decision
```

Return L1 draft memories with confidence `0.75` to `0.9`.

- [ ] **Step 5: Implement resolver**

Rules:

```text
same scope + same subject + same predicate + same object => duplicate
same scope + same subject + same predicate + different object => update and supersede old active memory
same scope + different predicate + related summary => support/related
```

When update occurs:

```text
old.status = superseded
new.status = active
new.supersedesId = old.id
relation = update
```

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/memory.test.ts`

Expected: PASS.

## Task 4: Project Memory and Dreaming

**Files:**
- Create: `src/domain/project-memory.ts`
- Create: `src/domain/dreaming.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests for:

```ts
it("builds L2 project memory from related L1 memories", () => {});
it("promotes stable repeated memories into L3 profile memories", () => {});
```

Expected behavior:

```text
L1 project facts for 项目 A produce one active L2 project memory.
Repeated preference memories produce one L3 profile memory.
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/memory.test.ts`

Expected: FAIL because project memory and Dreaming do not exist.

- [ ] **Step 3: Implement Project Memory**

Algorithm:

```text
group active L1 memories by subject
only subjects starting with 项目 become L2
summary = subject + "：" + joined predicate/object facts
upsert one active L2 memory per subject and scope
```

- [ ] **Step 4: Implement Dreaming**

Algorithm:

```text
read active L1/L2 memories
group by scope + type + subject + predicate + object
if group size >= 2 or type is preference, create/update one L3 profile memory
mark exact duplicate L1 memories as superseded when an L3 profile exists
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/memory.test.ts`

Expected: PASS.

## Task 5: Search

**Files:**
- Create: `src/domain/search.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests for:

```ts
it("searches L3, L2, and L1 but excludes superseded and deleted memories", () => {});
it("prefers same scope and active current facts", () => {});
```

Expected behavior:

```text
search("项目 A 数据库") returns PostgreSQL, not superseded MySQL.
search with mis=u1 does not return mis=u2 memories.
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/memory.test.ts`

Expected: FAIL because search does not exist.

- [ ] **Step 3: Implement search scoring**

Formula:

```ts
score =
  keywordScore
  + levelWeight
  + recencyScore
  + confidence
  + scopeMatch
  - stalePenalty;
```

Weights:

```text
L3 = 0.35
L2 = 0.25
L1 = 0.15
active = 1.0
superseded/deleted = excluded by default
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/memory.test.ts`

Expected: PASS.

## Task 6: Fastify API

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Add API tests**

Use Fastify `inject` to test:

```text
POST /turns writes L0 and extracts L1
POST /search returns active memories
GET /memories lists memories
PATCH /memories/:id updates status
GET /memories/:id/relations lists relations
POST /dreaming/run creates L3 memories
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/memory.test.ts`

Expected: FAIL because API does not exist.

- [ ] **Step 3: Implement server routes**

Routes:

```text
POST /turns
POST /search
GET /memories
PATCH /memories/:id
GET /memories/:id/relations
POST /dreaming/run
GET /health
```

Validation: use `zod` schemas for request bodies. Missing `mis/source/agent/channel` returns HTTP 400.

- [ ] **Step 4: Add entrypoint**

`src/index.ts` starts the server on `PORT` or `3000`.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: both PASS.

## Task 7: Manual Verification

**Files:**
- No source changes unless verification exposes a defect.

- [ ] **Step 1: Start server**

Run: `npm run dev`

Expected: server listens on `http://localhost:3000`.

- [ ] **Step 2: Write first turn**

Run:

```bash
curl -s http://localhost:3000/turns \
  -H 'content-type: application/json' \
  -d '{"sessionId":"s1","role":"user","content":"项目 A 使用 MySQL","mis":"u1","source":"local","agent":"demo","channel":"default","metadata":{}}'
```

Expected: response includes one L0 turn and one active L1 memory.

- [ ] **Step 3: Write updated fact**

Run:

```bash
curl -s http://localhost:3000/turns \
  -H 'content-type: application/json' \
  -d '{"sessionId":"s1","role":"user","content":"项目 A 已迁移到 PostgreSQL","mis":"u1","source":"local","agent":"demo","channel":"default","metadata":{}}'
```

Expected: old MySQL memory becomes `superseded`; PostgreSQL memory is `active`.

- [ ] **Step 4: Search current fact**

Run:

```bash
curl -s http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"项目 A 数据库","mis":"u1","source":"local","agent":"demo","channel":"default","metadata":{}}'
```

Expected: response contains PostgreSQL and does not contain active MySQL.

- [ ] **Step 5: Run Dreaming**

Run:

```bash
curl -s -X POST http://localhost:3000/dreaming/run \
  -H 'content-type: application/json' \
  -d '{"mis":"u1","source":"local","agent":"demo","channel":"default","metadata":{}}'
```

Expected: response reports created or updated L3 memories.

## Self-Review

- Spec coverage: L0/L1/L2/L3, value filtering, supersede evolution, relations, Project Memory, Dreaming, multi-level search, scope isolation, and API surface are covered.
- Placeholder scan: no unresolved placeholder language remains.
- Type consistency: plan uses `supersedesId`, `sourceTurnIds`, and camelCase TypeScript fields consistently; SQLite uses snake_case internally.
