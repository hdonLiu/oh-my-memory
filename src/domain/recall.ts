import { z } from "zod";
import type { LlmCompletionClient } from "./extractors.js";
import type { Memory, Scope } from "./types.js";

export interface RecallInput extends Scope {
  query: string;
  limit?: number;
}

export interface MemoryRecallPlan {
  shouldUseMemory: boolean;
  selectedMemoryIds: string[];
  reason: string;
}

export interface MemoryRecallPlanner {
  plan(input: { query: string; candidates: Memory[]; scope: Scope }): Promise<MemoryRecallPlan> | MemoryRecallPlan;
}

const recallPlanSchema = z.object({
  shouldUseMemory: z.boolean(),
  selectedMemoryIds: z.array(z.string()).default([]),
  reason: z.string().min(1)
});

export class LlmMemoryRecallPlanner implements MemoryRecallPlanner {
  constructor(private readonly client: LlmCompletionClient) {}

  async plan(input: { query: string; candidates: Memory[]; scope: Scope }): Promise<MemoryRecallPlan> {
    const raw = await this.client.complete(buildRecallPrompt(input.query, input.candidates));
    const plan = parseRecallPlan(raw);
    assertKnownMemoryIds(plan.selectedMemoryIds, input.candidates.map((memory) => memory.id));
    return plan.shouldUseMemory ? plan : { ...plan, selectedMemoryIds: [] };
  }
}

function parseRecallPlan(raw: string): MemoryRecallPlan {
  try {
    return recallPlanSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`Invalid LLM recall response: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

function assertKnownMemoryIds(selectedMemoryIds: string[], knownIds: string[]): void {
  const known = new Set(knownIds);
  const unknown = selectedMemoryIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`LLM recall selected unknown memory ids: ${unknown.join(", ")}`);
  }
}

function buildRecallPrompt(query: string, candidates: Memory[]): string {
  return JSON.stringify({
    task: "Decide whether memory is needed for the user query. Select only useful memory ids. Return JSON only.",
    rules: [
      "Use memory only when it materially improves the answer.",
      "Do not select superseded or deleted memories.",
      "Prefer concise stable memories over raw topic chatter.",
      "Use selectedMemoryIds only from candidates."
    ],
    query,
    candidates: candidates.map((memory) => ({
      id: memory.id,
      level: memory.level,
      type: memory.type,
      status: memory.status,
      readableText: memory.readableText,
      confidence: memory.confidence
    })),
    responseSchema: {
      shouldUseMemory: "boolean",
      selectedMemoryIds: "string[]",
      reason: "string"
    }
  });
}
