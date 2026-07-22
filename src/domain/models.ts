import { z } from "zod";
import type {
  Correction,
  L2AggregateInput,
  L3ProfileInput,
  RecallItem,
  Topic,
  TopicSnapshotInput,
  Turn
} from "./types.js";

export interface LlmCompletionClient {
  complete(prompt: string): Promise<string>;
}

export interface OpenAICompatibleCompletionOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAICompatibleCompletionClient implements LlmCompletionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleCompletionOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? "";
    this.model = options.model ?? process.env.LLM_MODEL ?? "gpt-4.1-mini";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("LLM response missing content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface AmbiguousTopicModel {
  decide(input: { topicText: string; turnText: string }): Promise<"continue" | "split">;
}

export interface TopicMaintenanceModel {
  rebuild(input: { turns: Turn[]; currentTopics: Topic[]; corrections: Correction[] }): Promise<{ topics: TopicSnapshotInput[] }>;
}

export interface L2AggregationModel {
  rebuild(input: { topics: Topic[]; currentAggregates: L2AggregateInput[] }): Promise<{ aggregates: L2AggregateInput[] }>;
}

export interface L3ProfilingModel {
  rebuild(input: { aggregates: L2AggregateInput[]; currentProfiles: L3ProfileInput[] }): Promise<{ profiles: L3ProfileInput[] }>;
}

export interface RecallModel {
  rank(input: { query: string; candidates: RecallItem[] }): Promise<{ ids: string[]; reason: string }>;
}

const topicDecisionSchema = z.object({ decision: z.enum(["continue", "split"]) });
const topicSnapshotSchema = z.object({
  id: z.string().min(1),
  turnIds: z.array(z.string().min(1)).min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  structuredContent: z.record(z.unknown()),
  recallText: z.string().min(1)
});
const topicMaintenanceSchema = z.object({ topics: z.array(topicSnapshotSchema) });
const l2ItemSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  content: z.string().min(1),
  kind: z.string().min(1),
  evidenceTurnIds: z.array(z.string().min(1)).min(1),
  sourceAgentIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1)
});
const l2Schema = z.object({ aggregates: z.array(l2ItemSchema) });
const l3ItemSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  content: z.string().min(1),
  evidenceL2Ids: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1)
});
const l3Schema = z.object({ profiles: z.array(l3ItemSchema) });
const recallSchema = z.object({ ids: z.array(z.string().min(1)), reason: z.string() });

export class LlmAmbiguousTopicModel implements AmbiguousTopicModel {
  constructor(private readonly client: LlmCompletionClient) {}

  async decide(input: { topicText: string; turnText: string }): Promise<"continue" | "split"> {
    const raw = await this.client.complete(
      prompt('Decide whether the new turn continues the current topic. Return exactly one JSON object shaped as {"decision":"continue"|"split"}.', input)
    );
    return parseJson(topicDecisionSchema, raw, "topic boundary").decision;
  }
}

export class LlmTopicMaintenanceModel implements TopicMaintenanceModel {
  constructor(private readonly client: LlmCompletionClient) {}

  async rebuild(input: { turns: Turn[]; currentTopics: Topic[]; corrections: Correction[] }): Promise<{ topics: TopicSnapshotInput[] }> {
    const raw = await this.client.complete(
      prompt(
        "Rebuild the complete current topic set. Return {topics:[{id,turnIds,title,summary,structuredContent,recallText}]}. Every meaningful Turn must appear once, in order, and no Topic may cross the Session.",
        input
      )
    );
    return parseJson(topicMaintenanceSchema, raw, "topic maintenance");
  }
}

export class LlmL2AggregationModel implements L2AggregationModel {
  constructor(private readonly client: LlmCompletionClient) {}

  async rebuild(input: { topics: Topic[]; currentAggregates: L2AggregateInput[] }): Promise<{ aggregates: L2AggregateInput[] }> {
    const raw = await this.client.complete(
      prompt(
        "Build the complete current L2 fact set from processed topics. Return {aggregates:[{id,key,content,kind,evidenceTurnIds,sourceAgentIds,confidence}]}; evidence must directly reference supplied Turn IDs.",
        input
      )
    );
    return parseJson(l2Schema, raw, "L2 aggregation");
  }
}

export class LlmL3ProfilingModel implements L3ProfilingModel {
  constructor(private readonly client: LlmCompletionClient) {}

  async rebuild(input: { aggregates: L2AggregateInput[]; currentProfiles: L3ProfileInput[] }): Promise<{ profiles: L3ProfileInput[] }> {
    const raw = await this.client.complete(
      prompt(
        "Build the complete current L3 profile set from current L2 facts. Return {profiles:[{id,key,content,evidenceL2Ids,confidence}]}.",
        input
      )
    );
    return parseJson(l3Schema, raw, "L3 profiling");
  }
}

export class LlmRecallModel implements RecallModel {
  constructor(private readonly client: LlmCompletionClient) {}

  async rank(input: { query: string; candidates: RecallItem[] }): Promise<{ ids: string[]; reason: string }> {
    const raw = await this.client.complete(
      prompt('Rank only relevant supplied memory candidate IDs. Return exactly {"ids":["candidate-id"],"reason":"..."}.', input)
    );
    return parseJson(recallSchema, raw, "recall ranking");
  }
}

function prompt(task: string, input: unknown): string {
  return JSON.stringify({ task, input });
}

function parseJson<T>(schema: z.ZodType<T>, raw: string, operation: string): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid ${operation} model response: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
