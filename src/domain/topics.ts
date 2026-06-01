import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConversationTurn, CreateMemoryInput, CreateTopicSegmentInput, Scope, TopicSegment, TopicStatus } from "./types.js";
import type { MemoryStore } from "../storage/store.js";
import { isNoise } from "./text.js";
import type { LlmCompletionClient } from "./extractors.js";

export interface TopicWindowConfig {
  initialSize: number;
  stepSize: number;
  maxSize: number;
  minConfidence: number;
}

export interface TopicDetectionDecision {
  status: TopicStatus;
  shouldMergeBackward: boolean;
  confidence: number;
  title?: string;
  summary?: string;
  reason: string;
  turnIds?: string[];
}

export interface TopicDetector {
  detect(turns: ConversationTurn[]): Promise<TopicDetectionDecision> | TopicDetectionDecision;
}

export interface TopicBuilder {
  build(store: MemoryStore, scope: Scope, sessionId: string): Promise<TopicSegment | null> | TopicSegment | null;
}

const defaultConfig: TopicWindowConfig = {
  initialSize: 8,
  stepSize: 4,
  maxSize: 24,
  minConfidence: 0.7
};

export class SlidingTopicBuilder implements TopicBuilder {
  private readonly config: TopicWindowConfig;

  constructor(
    private readonly detector: TopicDetector = new RuleBasedTopicDetector(),
    config: Partial<TopicWindowConfig> = {}
  ) {
    this.config = { ...defaultConfig, ...config };
  }

  async build(store: MemoryStore, scope: Scope, sessionId: string): Promise<TopicSegment | null> {
    const allTurns = store.recentTurns({ ...scope, sessionId }, this.config.maxSize);
    const latest = allTurns.at(-1);
    if (!latest) {
      return null;
    }

    const openTopic = findOpenTopic(store, scope, sessionId);
    const candidateTurnIds = Array.from(new Set([...(openTopic?.turnIds ?? []), latest.id])).slice(-this.config.maxSize);
    const candidateTurns = candidateTurnIds
      .map((id) => allTurns.find((turn) => turn.id === id))
      .filter((turn): turn is ConversationTurn => Boolean(turn))
      .filter((turn) => !isNoise(turn.content));

    if (candidateTurns.length === 0) {
      return this.persistSegment(store, scope, sessionId, [latest], {
        status: "noise",
        shouldMergeBackward: false,
        confidence: 0.9,
        reason: "window only contains noise"
      });
    }

    const decision = await this.detector.detect(candidateTurns);
    if (decision.status === "noise") {
      return this.persistSegment(store, scope, sessionId, candidateTurns, decision, openTopic);
    }

    if (decision.status === "complete" && decision.confidence >= this.config.minConfidence) {
      return this.closeTopic(store, scope, sessionId, candidateTurns, decision, openTopic);
    }

    if (candidateTurns.length >= this.config.maxSize) {
      return this.closeTopic(
        store,
        scope,
        sessionId,
        candidateTurns,
        {
          ...decision,
          status: "complete",
          confidence: Math.max(decision.confidence, this.config.minConfidence),
          reason: "max window size reached"
        },
        openTopic
      );
    }

    return this.persistSegment(store, scope, sessionId, candidateTurns, { ...decision, status: "partial" }, openTopic);
  }

  private closeTopic(
    store: MemoryStore,
    scope: Scope,
    sessionId: string,
    turns: ConversationTurn[],
    decision: TopicDetectionDecision,
    openTopic: TopicSegment | null
  ): TopicSegment {
    const closeTurnIds = decision.turnIds?.length ? decision.turnIds : turns.map((turn) => turn.id);
    const closedTurns = turns.filter((turn) => closeTurnIds.includes(turn.id));
    const remainingTurns = turns.filter((turn) => !closeTurnIds.includes(turn.id));
    const closed = this.persistSegment(store, scope, sessionId, closedTurns, decision, openTopic);
    if (remainingTurns.length > 0) {
      this.persistSegment(store, scope, sessionId, remainingTurns, {
        status: "partial",
        shouldMergeBackward: false,
        confidence: 0.5,
        title: inferTitle(remainingTurns),
        summary: remainingTurns.map((turn) => turn.content).join("\n"),
        reason: "new topic buffer started after boundary"
      });
    }
    return closed;
  }

  private persistSegment(
    store: MemoryStore,
    scope: Scope,
    sessionId: string,
    turns: ConversationTurn[],
    decision: TopicDetectionDecision,
    existingTopic?: TopicSegment | null
  ): TopicSegment {
    const turnIds = decision.turnIds?.length ? decision.turnIds : turns.map((turn) => turn.id);
    const title = decision.title ?? inferTitle(turns);
    const summary = decision.summary ?? turns.map((turn) => turn.content).join("\n");
    const fingerprint = topicFingerprintWithSession(scope, sessionId, title, summary);
    const existing = existingTopic ?? store.getTopicSegmentByFingerprint(fingerprint);
    if (existing) {
      return store.updateTopicSegment(existing.id, {
        title,
        summary,
        status: decision.status,
        confidence: decision.confidence,
        turnIds,
        reason: decision.reason,
        fingerprint,
        sessionId,
        ...scope
      });
    }
    return store.createTopicSegment({
      sessionId,
      title,
      summary,
      status: decision.status,
      confidence: decision.confidence,
      turnIds,
      reason: decision.reason,
      fingerprint,
      projectMemoryIds: [],
      ...scope
    });
  }
}

export class RuleBasedTopicDetector implements TopicDetector {
  detect(turns: ConversationTurn[]): TopicDetectionDecision {
    const latest = turns.at(-1);
    if (!latest || isNoise(latest.content)) {
      return {
        status: "noise",
        shouldMergeBackward: false,
        confidence: 0.9,
        reason: "latest turn is noise"
      };
    }
    return {
      status: "complete",
      shouldMergeBackward: false,
      confidence: 0.8,
      title: inferTitle(turns),
      summary: latest.content,
      reason: "rule-based fallback treats valuable latest turn as a complete topic"
    };
  }
}

const llmTopicSchema = z.object({
  status: z.enum(["complete", "partial", "noise"]),
  shouldMergeBackward: z.boolean(),
  confidence: z.number().min(0).max(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  reason: z.string().min(1),
  turnIds: z.array(z.string()).optional()
});

export class LlmTopicDetector implements TopicDetector {
  constructor(private readonly client: LlmCompletionClient) {}

  async detect(turns: ConversationTurn[]): Promise<TopicDetectionDecision> {
    const raw = await this.client.complete(
      JSON.stringify({
        task: "Decide whether the buffered session turns should stay open, close as a complete topic, or be treated as noise. If a new unrelated instruction starts, return status=complete and set turnIds to only the turns that should be closed.",
        turns
      })
    );
    try {
      return llmTopicSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`Invalid LLM topic detection response: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

export class HybridTopicDetector implements TopicDetector {
  constructor(
    private readonly primary: TopicDetector,
    private readonly fallback: TopicDetector
  ) {}

  async detect(turns: ConversationTurn[]): Promise<TopicDetectionDecision> {
    try {
      return await this.primary.detect(turns);
    } catch {
      return this.fallback.detect(turns);
    }
  }
}

export function topicFingerprint(scope: Scope, title: string, summary: string): string {
  return topicFingerprintWithSession(scope, "", title, summary);
}

export function topicFingerprintWithSession(scope: Scope, sessionId: string, title: string, summary: string): string {
  return createHash("sha256")
    .update([scope.mis, scope.source, scope.agent, scope.channel, sessionId, title.trim(), summary.trim()].join("\0"))
    .digest("hex");
}

export function topicToMemoryDraft(topic: TopicSegment): CreateMemoryInput {
  const subject = inferTopicSubject(topic);
  return {
    level: "topic",
    type: "topic",
    subject,
    predicate: "topic",
    object: topic.summary,
    summary: topic.summary,
    confidence: topic.confidence,
    status: "active",
    supersedesId: null,
    sourceTurnIds: topic.turnIds,
    mis: topic.mis,
    source: topic.source,
    agent: topic.agent,
    channel: topic.channel,
    metadata: {
      ...topic.metadata,
      topicId: topic.id,
      sessionId: topic.sessionId,
      title: topic.title,
      reason: topic.reason
    }
  };
}

function inferTopicSubject(topic: TopicSegment): string {
  const text = [topic.title, topic.summary].join("\n");
  const project = text.match(/项目\s*\S+/u)?.[0].replace(/\s+/g, " ").trim();
  if (project) {
    return project;
  }
  if (/(?:我|用户)(?:喜欢|偏好)/u.test(text)) {
    return "用户";
  }
  return topic.title;
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

export type TopicDraft = CreateTopicSegmentInput;
