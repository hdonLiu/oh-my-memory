import { createHash } from "node:crypto";
import type { CreateMemoryInput, ConversationTurn, Scope, TopicSegment, TopicStatus } from "./types.js";
import type { MemoryStore } from "../storage/store.js";
import { isNoise } from "./text.js";
import {
  RuleBasedTopicBoundaryDetector,
  type TopicBoundaryDecision,
  type TopicBoundaryDetector
} from "./topic-boundary.js";
import {
  RuleBasedTopicMemoryGenerator,
  topicMemoryUnitToDraft,
  type TopicMemoryGenerator,
  type TopicMemoryUnit
} from "./topic-memory.js";

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
    if (!latest || isNoise(latest.content)) {
      return null;
    }

    const openTopic = findOpenTopic(store, scope, sessionId);
    const existingTurns = openTopic ? resolveTurns(store, scope, sessionId, openTopic.turnIds) : [];
    if (existingTurns.length === 0) {
      return this.persistPartial(store, scope, sessionId, [latest], "new session topic buffer");
    }

    const boundary = await this.boundaryDetector.detectBoundary({
      existingTurns: this.boundaryDetectionTurns(existingTurns),
      newTurn: latest
    });

    if (boundary.shouldClose && boundary.confidence >= this.config.minConfidence) {
      const closed = await this.closeTurns(
        store,
        scope,
        sessionId,
        selectClosedTurns(existingTurns, boundary),
        boundary.reason,
        openTopic
      );
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
    if (!openTopic) {
      return null;
    }
    const turns = resolveTurns(store, scope, sessionId, openTopic.turnIds);
    if (turns.length === 0) {
      return null;
    }
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
    return this.persistSegment(
      store,
      scope,
      sessionId,
      turns,
      {
        status: "complete",
        title: unit.title,
        summary: unit.summary,
        confidence: unit.confidence,
        reason,
        metadata: topicUnitMetadata(unit)
      },
      existingTopic
    );
  }

  private persistPartial(
    store: MemoryStore,
    scope: Scope,
    sessionId: string,
    turns: ConversationTurn[],
    reason: string,
    existingTopic?: TopicSegment | null
  ): TopicSegment {
    return this.persistSegment(
      store,
      scope,
      sessionId,
      turns,
      {
        status: "partial",
        title: inferTitle(turns),
        summary: turns.map((turn) => turn.content).join("\n"),
        confidence: 0.5,
        reason,
        metadata: {}
      },
      existingTopic
    );
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

export function topicFingerprint(scope: Scope, title: string, summary: string): string {
  return topicFingerprintWithSession(scope, "", title, summary);
}

export function topicFingerprintWithSession(scope: Scope, sessionId: string, title: string, summary: string): string {
  return createHash("sha256")
    .update([scope.mis, scope.source, scope.agent, scope.channel, sessionId, title.trim(), summary.trim()].join("\0"))
    .digest("hex");
}

export function topicToMemoryDraft(topic: TopicSegment): CreateMemoryInput {
  return topicMemoryUnitToDraft(
    {
      title: topic.title,
      summary: topic.summary,
      topicType: (topic.metadata.topicType as TopicMemoryUnit["topicType"]) ?? "other",
      entities: asStringArray(topic.metadata.entities),
      decisions: asStringArray(topic.metadata.decisions),
      tasks: asStringArray(topic.metadata.tasks),
      preferences: asStringArray(topic.metadata.preferences),
      confidence: topic.confidence,
      reason: topic.reason,
      evidenceTurnIds: topic.turnIds
    },
    {
      sessionId: topic.sessionId,
      mis: topic.mis,
      source: topic.source,
      agent: topic.agent,
      channel: topic.channel,
      metadata: topic.metadata
    }
  );
}

function resolveTurns(store: MemoryStore, scope: Scope, sessionId: string, ids: string[]): ConversationTurn[] {
  const byId = new Map(store.recentTurns({ ...scope, sessionId }, Math.max(ids.length + 5, 50)).map((turn) => [turn.id, turn]));
  return ids.map((id) => byId.get(id)).filter((turn): turn is ConversationTurn => Boolean(turn));
}

function selectClosedTurns(existingTurns: ConversationTurn[], boundary: TopicBoundaryDecision): ConversationTurn[] {
  if (!boundary.closedTurnIds?.length) {
    return existingTurns;
  }
  return existingTurns.filter((turn) => boundary.closedTurnIds?.includes(turn.id));
}

function selectCarryOverTurns(
  allTurns: ConversationTurn[],
  latest: ConversationTurn,
  boundary: TopicBoundaryDecision
): ConversationTurn[] {
  if (!boundary.carryOverTurnIds?.length) {
    return [latest];
  }
  return allTurns.filter((turn) => boundary.carryOverTurnIds?.includes(turn.id));
}

function topicUnitMetadata(unit: TopicMemoryUnit): Record<string, unknown> {
  return {
    topicType: unit.topicType,
    entities: unit.entities,
    decisions: unit.decisions,
    tasks: unit.tasks,
    preferences: unit.preferences
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
