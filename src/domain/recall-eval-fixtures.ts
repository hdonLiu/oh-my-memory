import type { Memory } from "./types.js";

export interface RecallEvaluationExpected {
  shouldUseMemory: boolean;
  selectedMemoryIds: string[];
  promptSnippets: string[];
}

export interface RecallEvaluationFixture {
  id: string;
  query: string;
  memories: Memory[];
  expected: RecallEvaluationExpected;
}

const scope = { mis: "u1", source: "test", agent: "agent", channel: "default", metadata: {} };

export const recallEvaluationFixtures: RecallEvaluationFixture[] = [
  {
    id: "select-user-preference",
    query: "我写脚本应该优先用什么语言？",
    memories: [
      memory({
        id: "memory-preference-typescript",
        level: "L3",
        type: "profile",
        subject: "用户",
        predicate: "偏好",
        object: "TypeScript",
        summary: "用户偏好 TypeScript"
      })
    ],
    expected: {
      shouldUseMemory: true,
      selectedMemoryIds: ["memory-preference-typescript"],
      promptSnippets: ["L3 profile: 用户 偏好 TypeScript\n用户偏好 TypeScript"]
    }
  },
  {
    id: "exclude-superseded-memory",
    query: "项目 A 现在用什么数据库？",
    memories: [
      memory({
        id: "memory-old-db",
        level: "topic",
        type: "topic",
        subject: "项目 A",
        predicate: "topic",
        object: "项目 A 使用 MySQL",
        summary: "项目 A 使用 MySQL",
        status: "superseded"
      }),
      memory({
        id: "memory-new-db",
        level: "topic",
        type: "topic",
        subject: "项目 A",
        predicate: "topic",
        object: "项目 A 已迁移到 PostgreSQL",
        summary: "项目 A 已迁移到 PostgreSQL"
      })
    ],
    expected: {
      shouldUseMemory: true,
      selectedMemoryIds: ["memory-new-db"],
      promptSnippets: ["topic topic: 项目 A topic 项目 A 已迁移到 PostgreSQL\n项目 A 已迁移到 PostgreSQL"]
    }
  },
  {
    id: "skip-when-memory-not-needed",
    query: "帮我把这句话翻译成英文：你好",
    memories: [
      memory({
        id: "memory-preference-typescript",
        level: "L3",
        type: "profile",
        subject: "用户",
        predicate: "偏好",
        object: "TypeScript",
        summary: "用户偏好 TypeScript"
      })
    ],
    expected: {
      shouldUseMemory: false,
      selectedMemoryIds: [],
      promptSnippets: []
    }
  }
];

function memory(input: Partial<Memory> & Pick<Memory, "id" | "level" | "type" | "subject" | "predicate" | "object" | "summary">): Memory {
  const readableText = `${input.level} ${input.type}: ${input.subject} ${input.predicate} ${input.object}\n${input.summary}`;
  return {
    confidence: 0.9,
    status: "active",
    supersedesId: null,
    sourceTurnIds: [`turn-${input.id}`],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...scope,
    ...input,
    readableText: input.readableText ?? readableText
  };
}
