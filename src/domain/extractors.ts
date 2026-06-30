import { z } from "zod";
import type { ConversationTurn, CreateMemoryInput, MemoryLevel, MemoryType } from "./types.js";

export type MemoryDraft = CreateMemoryInput;

export interface MemoryExtractor {
  extract(turn: ConversationTurn, window: ConversationTurn[]): Promise<MemoryDraft[]> | MemoryDraft[];
}

export interface LlmCompletionClient {
  complete(prompt: string): Promise<string>;
}

export interface OpenAICompatibleCompletionProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export class OpenAICompatibleCompletionClient implements LlmCompletionClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleCompletionProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(prompt: string): Promise<string> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0
      })
    });
    if (!response.ok) {
      throw new Error(`LLM completion request failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM completion response missing content");
    }
    return content;
  }
}

const llmMemorySchema = z.object({
  level: z.enum(["topic", "L2", "L3"]),
  type: z.enum(["topic", "fact", "preference", "decision", "profile", "project"]),
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
      uid: turn.uid,
      source: turn.source,
      agent: turn.agent,
      channel: turn.channel,
      metadata: turn.metadata
    }));
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
