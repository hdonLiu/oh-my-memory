# Topic Layer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework L0 -> Topic so the server uses a session sliding buffer, LLM boundary detection, structured Topic Memory generation, MemoryResolver reconciliation, and explicit session flush.

**Architecture:** Split the current `TopicDetector` into `TopicBoundaryDetector` and `TopicMemoryGenerator`. Online ingestion keeps one open partial topic buffer per session; closed topics become `level: "topic"` memory units through `MemoryResolver`. L2 project extraction remains an offline job over active topic memories.

**Tech Stack:** TypeScript, Vitest, Fastify, Zod, existing `MemoryStore`, existing OpenAI-compatible completion client.

---

## File Structure

- Modify `src/domain/types.ts`
  - Keep `MemoryLevel = "topic" | "L2" | "L3"`.
  - Keep `TopicSegment` storage shape.
  - Add `TopicType` for structured topic classification.

- Create `src/domain/topic-boundary.ts`
  - Owns boundary detection only.
  - Exposes rule-based, LLM, and hybrid boundary detectors.

- Create `src/domain/topic-memory.ts`
  - Owns closed topic structuring.
  - Converts a closed `TopicSegment` to `CreateMemoryInput`.

- Modify `src/domain/topics.ts`
  - Keep `SlidingTopicBuilder`, but make it orchestrate buffer lifecycle.
  - Add `flush(store, scope, sessionId)` to close an open partial topic.
  - Remove LLM structuring from boundary detection.

- Modify `src/application/memory-service.ts`
  - Add `flushSessionTopic(scope, sessionId)`.
  - Use `TopicMemoryGenerator` only when topic is closed.

- Modify `src/server.ts`
  - Add `POST /sessions/:sessionId/topics/flush`.

- Modify `tests/memory.test.ts`
  - Replace old “every valuable turn is complete topic” assumptions.
  - Add coverage for boundary, carry-over, max window, flush, structured metadata, and resolver.

- Modify `README.md`
  - User-facing usage only: explain ingestion, search, project build, flush.

---

### Task 1: Add Topic Boundary Interfaces

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/domain/topic-boundary.ts`
- Test: `tests/memory.test.ts`

- [ ] **Step 1: Write failing boundary detector tests**

Append to `tests/memory.test.ts`:

```ts
import {
  HybridTopicBoundaryDetector,
  LlmTopicBoundaryDetector,
  RuleBasedTopicBoundaryDetector,
  type TopicBoundaryDetector
} from "../src/domain/topic-boundary.js";

describe("topic boundary detection", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("keeps related messages in the same open topic", async () => {
    const detector = new RuleBasedTopicBoundaryDetector();
    const result = await detector.detectBoundary({
      existingTurns: [
        { id: "t1", sessionId: "s1", role: "user", content: "项目 A 要做 memory 系统", createdAt: "2026-06-01T00:00:00.000Z", ...scope }
      ],
      newTurn: { id: "t2", sessionId: "s1", role: "assistant", content: "可以先做 topic 抽取", createdAt: "2026-06-01T00:01:00.000Z", ...scope }
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
          { id: "t1", sessionId: "s1", role: "user", content: "项目 A", createdAt: "2026-06-01T00:00:00.000Z", ...scope }
        ],
        newTurn: { id: "t2", sessionId: "s1", role: "user", content: "换个话题，健身计划", createdAt: "2026-06-01T00:02:00.000Z", ...scope }
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
        newTurn: { id: "t1", sessionId: "s1", role: "user", content: "hello", createdAt: "2026-06-01T00:00:00.000Z", ...scope }
      })
    ).resolves.toMatchObject({ reason: "fallback" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/memory.test.ts -t "topic boundary detection"
```

Expected: FAIL because `src/domain/topic-boundary.ts` does not exist.

- [ ] **Step 3: Add `TopicType`**

In `src/domain/types.ts`, replace `MemoryType` section with:

```ts
export type TopicType =
  | "project_work"
  | "product_design"
  | "technical_decision"
  | "workflow"
  | "preference"
  | "personal_context"
  | "research"
  | "other";

export type MemoryType = "topic" | "fact" | "preference" | "decision" | "profile" | "project";
```

- [ ] **Step 4: Create boundary detector module**

Create `src/domain/topic-boundary.ts`:

```ts
import { z } from "zod";
import type { ConversationTurn } from "./types.js";
import { isNoise } from "./text.js";
import type { LlmCompletionClient } from "./extractors.js";

export interface TopicBoundaryInput {
  existingTurns: ConversationTurn[];
  newTurn: ConversationTurn;
}

export interface TopicBoundaryDecision {
  shouldClose: boolean;
  confidence: number;
  reason: string;
  closedTurnIds?: string[];
  carryOverTurnIds?: string[];
}

export interface TopicBoundaryDetector {
  detectBoundary(input: TopicBoundaryInput): Promise<TopicBoundaryDecision> | TopicBoundaryDecision;
}

export class RuleBasedTopicBoundaryDetector implements TopicBoundaryDetector {
  detectBoundary(input: TopicBoundaryInput): TopicBoundaryDecision {
    if (input.existingTurns.length === 0 || isNoise(input.newTurn.content)) {
      return { shouldClose: false, confidence: 0.7, reason: "no meaningful boundary" };
    }
    return { shouldClose: false, confidence: 0.55, reason: "rule-based fallback keeps buffer open" };
  }
}

const llmTopicBoundarySchema = z.object({
  shouldClose: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  closedTurnIds: z.array(z.string()).optional(),
  carryOverTurnIds: z.array(z.string()).optional()
});

export class LlmTopicBoundaryDetector implements TopicBoundaryDetector {
  constructor(private readonly client: LlmCompletionClient) {}

  async detectBoundary(input: TopicBoundaryInput): Promise<TopicBoundaryDecision> {
    const raw = await this.client.complete(
      JSON.stringify({
        task: "Detect whether existingTurns should be closed as one topic before accepting newTurn. Return JSON only.",
        rules: [
          "Close when newTurn starts a different task or topic.",
          "Keep open when newTurn continues the same task.",
          "When closing, closedTurnIds normally contains existingTurns ids only.",
          "Use carryOverTurnIds when any recent turn should start the next topic."
        ],
        existingTurns: input.existingTurns,
        newTurn: input.newTurn
      })
    );
    try {
      return llmTopicBoundarySchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`Invalid LLM topic boundary response: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

export class HybridTopicBoundaryDetector implements TopicBoundaryDetector {
  constructor(
    private readonly primary: TopicBoundaryDetector,
    private readonly fallback: TopicBoundaryDetector
  ) {}

  async detectBoundary(input: TopicBoundaryInput): Promise<TopicBoundaryDecision> {
    try {
      return await this.primary.detectBoundary(input);
    } catch {
      return this.fallback.detectBoundary(input);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- tests/memory.test.ts -t "topic boundary detection"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/domain/topic-boundary.ts tests/memory.test.ts
git commit -m "feat: add topic boundary detector"
```

---

### Task 2: Add Structured Topic Memory Generator

**Files:**
- Create: `src/domain/topic-memory.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Write failing topic memory tests**

Append to `tests/memory.test.ts`:

```ts
import {
  LlmTopicMemoryGenerator,
  RuleBasedTopicMemoryGenerator,
  topicMemoryUnitToDraft
} from "../src/domain/topic-memory.js";

describe("topic memory generation", () => {
  const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

  it("generates structured topic units from closed turns", async () => {
    const generator = new RuleBasedTopicMemoryGenerator();
    const unit = await generator.generate({
      sessionId: "s1",
      turns: [
        { id: "t1", sessionId: "s1", role: "user", content: "项目 A 要实现 memory 系统", createdAt: "2026-06-01T00:00:00.000Z", ...scope },
        { id: "t2", sessionId: "s1", role: "assistant", content: "先实现 topic 层", createdAt: "2026-06-01T00:01:00.000Z", ...scope }
      ],
      reason: "boundary"
    });

    expect(unit).toMatchObject({
      topicType: "project_work",
      title: expect.any(String),
      evidenceTurnIds: ["t1", "t2"]
    });
  });

  it("converts structured topic units to topic memory drafts", async () => {
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
        turns: [{ id: "t1", sessionId: "s1", role: "user", content: "项目 A", createdAt: "2026-06-01T00:00:00.000Z", ...scope }],
        reason: "flush"
      })
    ).rejects.toThrow("Invalid LLM topic memory response");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/memory.test.ts -t "topic memory generation"
```

Expected: FAIL because `src/domain/topic-memory.ts` does not exist.

- [ ] **Step 3: Create topic memory generator module**

Create `src/domain/topic-memory.ts`:

```ts
import { z } from "zod";
import type { ConversationTurn, CreateMemoryInput, Scope, TopicType } from "./types.js";
import type { LlmCompletionClient } from "./extractors.js";

export interface TopicMemoryInput {
  sessionId: string;
  turns: ConversationTurn[];
  reason: string;
}

export interface TopicMemoryUnit {
  title: string;
  summary: string;
  topicType: TopicType;
  entities: string[];
  decisions: string[];
  tasks: string[];
  preferences: string[];
  confidence: number;
  reason: string;
  evidenceTurnIds: string[];
}

export interface TopicMemoryGenerator {
  generate(input: TopicMemoryInput): Promise<TopicMemoryUnit> | TopicMemoryUnit;
}

const topicMemorySchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  topicType: z.enum([
    "project_work",
    "product_design",
    "technical_decision",
    "workflow",
    "preference",
    "personal_context",
    "research",
    "other"
  ]),
  entities: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  tasks: z.array(z.string()).default([]),
  preferences: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  evidenceTurnIds: z.array(z.string()).min(1)
});

export class RuleBasedTopicMemoryGenerator implements TopicMemoryGenerator {
  generate(input: TopicMemoryInput): TopicMemoryUnit {
    const text = input.turns.map((turn) => turn.content).join("\n");
    const title = input.turns.at(-1)?.content.trim().slice(0, 80) || "Untitled topic";
    const project = inferProjectEntity(text);
    return {
      title,
      summary: text,
      topicType: inferTopicType(text),
      entities: project ? [project] : [],
      decisions: [],
      tasks: [],
      preferences: [],
      confidence: 0.72,
      reason: input.reason,
      evidenceTurnIds: input.turns.map((turn) => turn.id)
    };
  }
}

export class LlmTopicMemoryGenerator implements TopicMemoryGenerator {
  constructor(private readonly client: LlmCompletionClient) {}

  async generate(input: TopicMemoryInput): Promise<TopicMemoryUnit> {
    const raw = await this.client.complete(
      JSON.stringify({
        task: "Convert a closed conversation topic into one structured Topic Memory Unit. Return JSON only.",
        schema: {
          title: "string",
          summary: "string",
          topicType: "project_work|product_design|technical_decision|workflow|preference|personal_context|research|other",
          entities: "string[]",
          decisions: "string[]",
          tasks: "string[]",
          preferences: "string[]",
          confidence: "0..1",
          reason: "string",
          evidenceTurnIds: "string[]"
        },
        sessionId: input.sessionId,
        reason: input.reason,
        turns: input.turns
      })
    );
    try {
      return topicMemorySchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`Invalid LLM topic memory response: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

export function topicMemoryUnitToDraft(unit: TopicMemoryUnit, scope: Scope & { sessionId: string }): CreateMemoryInput {
  return {
    level: "topic",
    type: "topic",
    subject: inferSubject(unit),
    predicate: "topic",
    object: unit.summary,
    summary: unit.summary,
    confidence: unit.confidence,
    status: "active",
    supersedesId: null,
    sourceTurnIds: unit.evidenceTurnIds,
    mis: scope.mis,
    source: scope.source,
    agent: scope.agent,
    channel: scope.channel,
    metadata: {
      ...scope.metadata,
      sessionId: scope.sessionId,
      title: unit.title,
      topicType: unit.topicType,
      entities: unit.entities,
      decisions: unit.decisions,
      tasks: unit.tasks,
      preferences: unit.preferences,
      reason: unit.reason
    }
  };
}

function inferTopicType(text: string): TopicType {
  if (/(?:项目|repo|repository|系统|memory)/iu.test(text)) return "project_work";
  if (/(?:喜欢|偏好|习惯|prefer)/iu.test(text)) return "preference";
  if (/(?:方案|决策|决定|取舍)/u.test(text)) return "technical_decision";
  return "other";
}

function inferProjectEntity(text: string): string | null {
  return text.match(/项目\s*\S+/u)?.[0].replace(/\s+/g, " ").trim() ?? null;
}

function inferSubject(unit: TopicMemoryUnit): string {
  return unit.entities[0] ?? (unit.topicType === "preference" ? "用户" : unit.title);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/memory.test.ts -t "topic memory generation"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/topic-memory.ts src/domain/types.ts tests/memory.test.ts
git commit -m "feat: add structured topic memory generator"
```

---

### Task 3: Rework Sliding Topic Builder Around Session Buffer

**Files:**
- Modify: `src/domain/topics.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Write failing sliding buffer tests**

Append to `tests/memory.test.ts`:

```ts
import { RuleBasedTopicMemoryGenerator } from "../src/domain/topic-memory.js";
import type { TopicBoundaryDetector } from "../src/domain/topic-boundary.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/memory.test.ts -t "session sliding topic builder"
```

Expected: FAIL because `SlidingTopicBuilder` constructor and behavior still use `TopicDetector`.

- [ ] **Step 3: Replace `topics.ts` orchestration**

In `src/domain/topics.ts`, keep `topicFingerprint` exports for compatibility, but change the builder to:

```ts
import { createHash } from "node:crypto";
import type { ConversationTurn, Scope, TopicSegment, TopicStatus } from "./types.js";
import type { MemoryStore } from "../storage/store.js";
import { isNoise } from "./text.js";
import {
  RuleBasedTopicBoundaryDetector,
  type TopicBoundaryDetector,
  type TopicBoundaryDecision
} from "./topic-boundary.js";
import { RuleBasedTopicMemoryGenerator, type TopicMemoryGenerator } from "./topic-memory.js";

export interface TopicWindowConfig {
  maxSize: number;
  minConfidence: number;
  excludeLastTurnForBoundary: boolean;
  excludeLastTurnThreshold: number;
}

export interface TopicBuilder {
  build(store: MemoryStore, scope: Scope, sessionId: string): Promise<TopicSegment | null> | TopicSegment | null;
  flush(store: MemoryStore, scope: Scope, sessionId: string): Promise<TopicSegment | null> | TopicSegment | null;
}

const defaultConfig: TopicWindowConfig = {
  maxSize: 24,
  minConfidence: 0.7,
  excludeLastTurnForBoundary: true,
  excludeLastTurnThreshold: 10
};

export class SlidingTopicBuilder implements TopicBuilder {
  private readonly config: TopicWindowConfig;

  constructor(
    private readonly boundaryDetector: TopicBoundaryDetector = new RuleBasedTopicBoundaryDetector(),
    private readonly topicMemoryGenerator: TopicMemoryGenerator = new RuleBasedTopicMemoryGenerator(),
    config: Partial<TopicWindowConfig> = {}
  ) {
    this.config = { ...defaultConfig, ...config };
  }

  async build(store: MemoryStore, scope: Scope, sessionId: string): Promise<TopicSegment | null> {
    const latest = store.recentTurns({ ...scope, sessionId }, 1).at(-1);
    if (!latest) return null;
    if (isNoise(latest.content)) return null;

    const openTopic = findOpenTopic(store, scope, sessionId);
    const existingTurns = openTopic ? resolveTurns(store, scope, sessionId, openTopic.turnIds) : [];
    if (existingTurns.length === 0) {
      return this.persistPartial(store, scope, sessionId, [latest], "new session topic buffer");
    }

    const detectionTurns = this.boundaryDetectionTurns(existingTurns);
    const boundary = await this.boundaryDetector.detectBoundary({
      existingTurns: detectionTurns,
      newTurn: latest
    });

    if (boundary.shouldClose && boundary.confidence >= this.config.minConfidence) {
      const closed = await this.closeTurns(store, scope, sessionId, selectClosedTurns(existingTurns, boundary), boundary.reason, openTopic);
      const carryOver = selectCarryOverTurns([...existingTurns, latest], latest, boundary);
      if (carryOver.length > 0) {
        this.persistPartial(store, scope, sessionId, carryOver, "new topic buffer started after boundary");
      }
      return closed;
    }

    const nextTurns = [...existingTurns, latest].slice(-this.config.maxSize);
    if (nextTurns.length >= this.config.maxSize) {
      return this.closeTurns(store, scope, sessionId, nextTurns, "max window size reached", openTopic);
    }

    return this.persistPartial(store, scope, sessionId, nextTurns, boundary.reason, openTopic);
  }

  async flush(store: MemoryStore, scope: Scope, sessionId: string): Promise<TopicSegment | null> {
    const openTopic = findOpenTopic(store, scope, sessionId);
    if (!openTopic) return null;
    const turns = resolveTurns(store, scope, sessionId, openTopic.turnIds);
    if (turns.length === 0) return null;
    return this.closeTurns(store, scope, sessionId, turns, "session topic flush", openTopic);
  }

  private boundaryDetectionTurns(turns: ConversationTurn[]): ConversationTurn[] {
    if (!this.config.excludeLastTurnForBoundary || turns.length <= this.config.excludeLastTurnThreshold) {
      return turns;
    }
    return turns.slice(0, -1);
  }

  private async closeTurns(
    store: MemoryStore,
    scope: Scope,
    sessionId: string,
    turns: ConversationTurn[],
    reason: string,
    existingTopic?: TopicSegment | null
  ): Promise<TopicSegment> {
    const unit = await this.topicMemoryGenerator.generate({ sessionId, turns, reason });
    return this.persistSegment(store, scope, sessionId, turns, {
      status: "complete",
      title: unit.title,
      summary: unit.summary,
      confidence: unit.confidence,
      reason,
      metadata: {
        topicType: unit.topicType,
        entities: unit.entities,
        decisions: unit.decisions,
        tasks: unit.tasks,
        preferences: unit.preferences
      }
    }, existingTopic);
  }

  private persistPartial(
    store: MemoryStore,
    scope: Scope,
    sessionId: string,
    turns: ConversationTurn[],
    reason: string,
    existingTopic?: TopicSegment | null
  ): TopicSegment {
    return this.persistSegment(store, scope, sessionId, turns, {
      status: "partial",
      title: inferTitle(turns),
      summary: turns.map((turn) => turn.content).join("\n"),
      confidence: 0.5,
      reason,
      metadata: {}
    }, existingTopic);
  }

  private persistSegment(
    store: MemoryStore,
    scope: Scope,
    sessionId: string,
    turns: ConversationTurn[],
    input: {
      status: TopicStatus;
      title: string;
      summary: string;
      confidence: number;
      reason: string;
      metadata: Record<string, unknown>;
    },
    existingTopic?: TopicSegment | null
  ): TopicSegment {
    const turnIds = turns.map((turn) => turn.id);
    const fingerprint = topicFingerprintWithSession(scope, sessionId, input.title, input.summary);
    const existing = existingTopic ?? store.getTopicSegmentByFingerprint(fingerprint);
    const patch = {
      sessionId,
      title: input.title,
      summary: input.summary,
      status: input.status,
      confidence: input.confidence,
      turnIds,
      reason: input.reason,
      fingerprint,
      projectMemoryIds: existingTopic?.projectMemoryIds ?? [],
      ...scope,
      metadata: { ...scope.metadata, ...input.metadata }
    };
    return existing ? store.updateTopicSegment(existing.id, patch) : store.createTopicSegment(patch);
  }
}

function resolveTurns(store: MemoryStore, scope: Scope, sessionId: string, ids: string[]): ConversationTurn[] {
  const byId = new Map(store.recentTurns({ ...scope, sessionId }, Math.max(ids.length + 5, 50)).map((turn) => [turn.id, turn]));
  return ids.map((id) => byId.get(id)).filter((turn): turn is ConversationTurn => Boolean(turn));
}

function selectClosedTurns(existingTurns: ConversationTurn[], boundary: TopicBoundaryDecision): ConversationTurn[] {
  if (!boundary.closedTurnIds?.length) return existingTurns;
  return existingTurns.filter((turn) => boundary.closedTurnIds?.includes(turn.id));
}

function selectCarryOverTurns(
  allTurns: ConversationTurn[],
  latest: ConversationTurn,
  boundary: TopicBoundaryDecision
): ConversationTurn[] {
  if (!boundary.carryOverTurnIds?.length) return [latest];
  return allTurns.filter((turn) => boundary.carryOverTurnIds?.includes(turn.id));
}

export function topicFingerprint(scope: Scope, title: string, summary: string): string {
  return topicFingerprintWithSession(scope, "", title, summary);
}

export function topicFingerprintWithSession(scope: Scope, sessionId: string, title: string, summary: string): string {
  return createHash("sha256")
    .update([scope.mis, scope.source, scope.agent, scope.channel, sessionId, title.trim(), summary.trim()].join("\0"))
    .digest("hex");
}

function inferTitle(turns: ConversationTurn[]): string {
  const latest = turns.at(-1);
  return latest ? latest.content.trim().slice(0, 80) : "Untitled topic";
}

function findOpenTopic(store: MemoryStore, scope: Scope, sessionId: string): TopicSegment | null {
  return (
    store
      .listTopicSegments(scope)
      .filter((topic) => topic.sessionId === sessionId && topic.status === "partial")
      .at(-1) ?? null
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/memory.test.ts -t "session sliding topic builder"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/topics.ts tests/memory.test.ts
git commit -m "feat: use boundary-based topic buffer"
```

---

### Task 4: Wire Closed Topics Through MemoryResolver

**Files:**
- Modify: `src/application/memory-service.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Write failing service tests**

Append to `tests/memory.test.ts`:

```ts
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
        { detectBoundary: ({ newTurn }) => ({ shouldClose: newTurn.content.includes("换个话题"), confidence: 0.9, reason: "topic changed" }) },
        new RuleBasedTopicMemoryGenerator()
      )
    });

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "项目 A 要做 memory", ...scope });
    expect(resolvedSubjects).toEqual([]);

    await service.ingestTurn({ sessionId: "s1", role: "user", content: "换个话题，健身计划", ...scope });
    expect(resolvedSubjects).toEqual(["项目 A"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/memory.test.ts -t "topic resolver integration"
```

Expected: FAIL because service still imports `topicToMemoryDraft`.

- [ ] **Step 3: Update service to use structured topic drafts**

In `src/application/memory-service.ts`:

```ts
import { topicMemoryUnitToDraft } from "../domain/topic-memory.js";
```

Remove:

```ts
import { SlidingTopicBuilder, topicToMemoryDraft, type TopicBuilder } from "../domain/topics.js";
```

Replace with:

```ts
import { SlidingTopicBuilder, type TopicBuilder } from "../domain/topics.js";
```

Add helper:

```ts
function topicToDraftFromSegment(topic: TopicSegment): CreateMemoryInput {
  const metadata = topic.metadata as Record<string, unknown>;
  return topicMemoryUnitToDraft(
    {
      title: topic.title,
      summary: topic.summary,
      topicType: (metadata.topicType as never) ?? "other",
      entities: Array.isArray(metadata.entities) ? (metadata.entities as string[]) : [],
      decisions: Array.isArray(metadata.decisions) ? (metadata.decisions as string[]) : [],
      tasks: Array.isArray(metadata.tasks) ? (metadata.tasks as string[]) : [],
      preferences: Array.isArray(metadata.preferences) ? (metadata.preferences as string[]) : [],
      confidence: topic.confidence,
      reason: topic.reason,
      evidenceTurnIds: topic.turnIds
    },
    { sessionId: topic.sessionId, mis: topic.mis, source: topic.source, agent: topic.agent, channel: topic.channel, metadata: topic.metadata }
  );
}
```

In `ingestTurn`, replace:

```ts
const topicMemory = resolver.resolve(store, topicToMemoryDraft(topic));
```

with:

```ts
const topicMemory = resolver.resolve(store, topicToDraftFromSegment(topic));
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/memory.test.ts -t "topic resolver integration"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/memory-service.ts tests/memory.test.ts
git commit -m "feat: resolve closed topic memories"
```

---

### Task 5: Add Session Topic Flush

**Files:**
- Modify: `src/application/memory-service.ts`
- Modify: `src/server.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Write failing flush tests**

Append to `tests/memory.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/memory.test.ts -t "session topic flush"
```

Expected: FAIL because `flushSessionTopic` and HTTP endpoint do not exist.

- [ ] **Step 3: Add service method**

In `src/application/memory-service.ts`, add to `MemoryService`:

```ts
flushSessionTopic(scope: Scope, sessionId: string): Promise<{ topic: TopicSegment | null; memories: Memory[] }>;
```

In returned service object, add:

```ts
async flushSessionTopic(scope, sessionId) {
  const topic = await topicBuilder.flush(store, scope, sessionId);
  if (!topic || topic.status !== "complete") {
    return { topic, memories: [] };
  }
  const topicMemory = resolver.resolve(store, topicToDraftFromSegment(topic));
  const memories = [topicMemory];
  if (embeddingProvider && embeddingIndex) {
    await Promise.all(memories.map((memory) => indexMemory(memory, embeddingProvider, embeddingIndex)));
  }
  return { topic, memories };
},
```

- [ ] **Step 4: Add HTTP endpoint**

In `src/server.ts`, after `/turns`:

```ts
app.post("/sessions/:sessionId/topics/flush", async (request, reply) => {
  const params = request.params as { sessionId: string };
  const parsed = scopeSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  return service.flushSessionTopic(toScope(parsed.data), params.sessionId);
});
```

In `isMemoryService`, add:

```ts
typeof (value as MemoryService).flushSessionTopic === "function" &&
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- tests/memory.test.ts -t "session topic flush"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/memory-service.ts src/server.ts tests/memory.test.ts
git commit -m "feat: add session topic flush"
```

---

### Task 6: Update Default LLM Wiring

**Files:**
- Modify: `src/application/memory-service.ts`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Write failing default wiring test**

Append to `tests/memory.test.ts`:

```ts
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
```

- [ ] **Step 2: Run targeted test**

Run:

```bash
npm test -- tests/memory.test.ts -t "default topic LLM wiring"
```

Expected: PASS after Task 5.

- [ ] **Step 3: Add default topic builder factory**

In `src/application/memory-service.ts`, import:

```ts
import { HybridTopicBoundaryDetector, LlmTopicBoundaryDetector, RuleBasedTopicBoundaryDetector } from "../domain/topic-boundary.js";
import { LlmTopicMemoryGenerator, RuleBasedTopicMemoryGenerator } from "../domain/topic-memory.js";
```

Replace:

```ts
const topicBuilder = options.topicBuilder ?? new SlidingTopicBuilder();
```

with:

```ts
const topicBuilder = options.topicBuilder ?? createDefaultTopicBuilder();
```

Add:

```ts
function createDefaultTopicBuilder(): TopicBuilder {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    return new SlidingTopicBuilder(new RuleBasedTopicBoundaryDetector(), new RuleBasedTopicMemoryGenerator());
  }
  const client = new OpenAICompatibleCompletionClient({ baseUrl, apiKey, model });
  return new SlidingTopicBuilder(
    new HybridTopicBoundaryDetector(new LlmTopicBoundaryDetector(client), new RuleBasedTopicBoundaryDetector()),
    new LlmTopicMemoryGenerator(client)
  );
}
```

- [ ] **Step 4: Run test and typecheck**

Run:

```bash
npm test -- tests/memory.test.ts -t "default topic LLM wiring"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/memory-service.ts tests/memory.test.ts
git commit -m "feat: wire default topic llm pipeline"
```

---

### Task 7: Update README Usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update user-facing topic usage**

In `README.md`, ensure usage includes:

```md
### Ingest Turns

`POST /turns` appends one conversation turn to a session. The service keeps an open Topic buffer and closes it when the model detects a topic boundary or the configured maximum window is reached.

### Flush A Session Topic

`POST /sessions/:sessionId/topics/flush` closes the current open Topic buffer for a session. Use this when a chat/session ends and you want the latest partial topic to become searchable memory immediately.

### Build Project Memories

`POST /projects/run` runs the offline L2 builder. It reads active Topic memories and asks the model to extract stable project memories.
```

- [ ] **Step 2: Run docs sanity**

Run:

```bash
rg -n "catmemory|L1|/sessions/.*/topics/flush|/projects/run" README.md
```

Expected:
- No `catmemory`
- No obsolete `L1`
- Flush and project endpoints are present

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update topic usage"
```

---

### Task 8: Full Verification

**Files:**
- All changed files

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run whitespace check**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Final commit if verification changed files**

```bash
git status --short
git add src tests README.md
git commit -m "chore: verify topic layer redesign"
```

Only run the commit command if `git status --short` shows uncommitted files.

---

## Self-Review

Spec coverage:
- xMemory-style buffer: Task 3.
- LLM boundary detection: Task 1 and Task 6.
- Structured Topic Memory Unit: Task 2.
- MemoryResolver update/delete/association path: Task 4.
- Session end flush: Task 5.
- OpenViking-style session archive inspiration: Task 5 keeps explicit flush as the small version of commit/close.
- README user-facing usage: Task 7.

No placeholders:
- Every task has concrete files, test code, commands, expected result, and commit.

Type consistency:
- `TopicBoundaryDetector.detectBoundary()`.
- `TopicMemoryGenerator.generate()`.
- `TopicBuilder.build()` and `TopicBuilder.flush()`.
- `MemoryService.flushSessionTopic()`.
