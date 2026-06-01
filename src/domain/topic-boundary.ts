import { z } from "zod";
import type { LlmCompletionClient } from "./extractors.js";
import { isNoise } from "./text.js";
import type { ConversationTurn } from "./types.js";

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
