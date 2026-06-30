import { z } from "zod";
import type { LlmCompletionClient } from "./extractors.js";
import type { ConversationTurn, CreateMemoryInput, Scope, TopicType } from "./types.js";

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
          topicType:
            "project_work|product_design|technical_decision|workflow|preference|personal_context|research|other",
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
      const unit = topicMemorySchema.parse(JSON.parse(raw) as unknown);
      assertKnownTurnIds(unit.evidenceTurnIds, input.turns.map((turn) => turn.id));
      return unit;
    } catch (error) {
      throw new Error(`Invalid LLM topic memory response: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

function assertKnownTurnIds(evidenceTurnIds: string[], knownIds: string[]): void {
  const known = new Set(knownIds);
  const unknown = evidenceTurnIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown evidenceTurnIds: ${unknown.join(", ")}`);
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
    uid: scope.uid,
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
