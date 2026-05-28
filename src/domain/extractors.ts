import { z } from "zod";
import { extractMemories, type MemoryDraft } from "./extractor.js";
import type { ConversationTurn, MemoryLevel, MemoryType } from "./types.js";

export interface MemoryExtractor {
  extract(turn: ConversationTurn, window: ConversationTurn[]): Promise<MemoryDraft[]> | MemoryDraft[];
}

export class RuleBasedMemoryExtractor implements MemoryExtractor {
  extract(turn: ConversationTurn, window: ConversationTurn[]): MemoryDraft[] {
    return extractMemories(turn, window);
  }
}

export interface LlmCompletionClient {
  complete(prompt: string): Promise<string>;
}

const llmMemorySchema = z.object({
  level: z.enum(["L1", "L2", "L3"]),
  type: z.enum(["fact", "preference", "decision", "profile", "project"]),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

const llmResponseSchema = z.object({
  memories: z.array(llmMemorySchema)
});

export class LlmMemoryExtractor implements MemoryExtractor {
  constructor(private readonly client: LlmCompletionClient) {}

  async extract(turn: ConversationTurn, window: ConversationTurn[]): Promise<MemoryDraft[]> {
    const raw = await this.client.complete(buildPrompt(turn, window));
    const parsed = parseLlmResponse(raw);
    return parsed.memories.map((memory) => ({
      level: memory.level as MemoryLevel,
      type: memory.type as MemoryType,
      subject: memory.subject,
      predicate: memory.predicate,
      object: memory.object,
      summary: memory.summary,
      confidence: memory.confidence,
      status: "active",
      supersedesId: null,
      sourceTurnIds: [turn.id],
      mis: turn.mis,
      source: turn.source,
      agent: turn.agent,
      channel: turn.channel,
      metadata: turn.metadata
    }));
  }
}

export class HybridMemoryExtractor implements MemoryExtractor {
  constructor(
    private readonly primary: MemoryExtractor,
    private readonly fallback: MemoryExtractor
  ) {}

  async extract(turn: ConversationTurn, window: ConversationTurn[]): Promise<MemoryDraft[]> {
    try {
      return await this.primary.extract(turn, window);
    } catch {
      return this.fallback.extract(turn, window);
    }
  }
}

function parseLlmResponse(raw: string): z.infer<typeof llmResponseSchema> {
  try {
    const json = JSON.parse(raw) as unknown;
    return llmResponseSchema.parse(json);
  } catch (error) {
    throw new Error(
      `Invalid LLM memory extraction response: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

function buildPrompt(turn: ConversationTurn, window: ConversationTurn[]): string {
  return JSON.stringify({
    task: "Extract memory drafts from the latest turn. Return JSON with a memories array.",
    latestTurn: turn,
    window
  });
}
