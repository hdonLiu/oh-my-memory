import { z } from "zod";
import { createHash } from "node:crypto";
import type { LlmCompletionClient } from "../domain/extractors.js";
import { jaccard } from "../domain/text.js";
import type {
  CanonicalProfileDraft,
  GenerationProvenance,
  GovernanceFreshness,
  CorrectionRecord,
  L1MaintenancePlan,
  L1TopicRevision,
  L2AggregateContent,
  L2MembershipPlan,
  L2Statement,
  Memory,
  StatementOperation,
  Scope,
  TopicSegment
} from "../domain/types.js";
import type { MemoryStore } from "../storage/store.js";
import type { L1TopicView, L2AggregateView, L2SynthesisOutput } from "../storage/layered-repository.js";

export interface L1MaintenancePlanner {
  plan(input: {
    scope: Scope;
    sessionId: string;
    topics: L1TopicView[];
    turns: ReturnType<MemoryStore["recentTurns"]>;
    corrections: CorrectionRecord[];
  }): Promise<L1MaintenancePlan>;
}

export interface L2MembershipPlanner {
  plan(input: {
    uid: string;
    agent: string;
    watermark: number;
    components: ReturnType<MemoryStore["layered"]["listStableComponents"]>;
    aggregates: L2AggregateView[];
    corrections: CorrectionRecord[];
  }): Promise<L2MembershipPlan>;
}

export interface L2RevisionSynthesizer {
  synthesize(input: {
    uid: string;
    agent: string;
    componentIds: string[];
    components: ReturnType<MemoryStore["layered"]["listStableComponents"]>;
    current?: L2AggregateView;
    corrections: CorrectionRecord[];
    sourceStatements: Array<{
      sourceRef: string;
      revisionId: string;
      statementId: string;
      category: "facts" | "decisions" | "constraints" | "openQuestions";
      content: string;
    }>;
  }): Promise<{ content: L2AggregateContent; statementOperations?: StatementOperation[]; reason: string; confidence: number }>;
}

export interface CanonicalProfileExtractor {
  extract(input: {
    uid: string;
    agent: string;
    components: ReturnType<MemoryStore["layered"]["listStableComponents"]>;
    componentSessions: Record<string, string>;
    aggregates: L2AggregateView[];
    existingProfiles: Memory[];
  }): Promise<CanonicalProfileDraft[]>;
}

export interface LayeredRecallResult {
  level: "L3_PROFILE" | "L2" | "L1_COMPONENT" | "L1_TOPIC";
  id: string;
  text: string;
  score: number;
  stability: "stable" | "provisional";
  evidence: {
    aggregateIds: string[];
    componentIds: string[];
    topicRevisionIds: string[];
    turnIds: string[];
  };
  evidenceAuthority: "conversation" | "human_correction";
  evidenceCorrectionIds: string[];
  statementIds: string[];
  statementStatuses: Array<"supported" | "contested">;
  statementConflicts: Array<{
    statementId: string;
    assessment: NonNullable<import("../domain/types.js").ConflictAssessment>;
  }>;
  sourceL1Watermark?: number;
  sourceGovernanceWatermark?: number;
}

export interface LayeredRecallPlanner {
  plan(input: { query: string; candidates: LayeredRecallResult[] }): Promise<{
    shouldUseMemory: boolean;
    selectedIds: string[];
    reason: string;
  }>;
}

export interface LayeredMemoryServiceOptions {
  l1Planner: L1MaintenancePlanner;
  l2Planner: L2MembershipPlanner;
  l2Synthesizer: L2RevisionSynthesizer;
  recallPlanner: LayeredRecallPlanner;
  profileExtractor?: CanonicalProfileExtractor;
  provenance?: Partial<GenerationProvenance>;
}

export class LayeredMemoryService {
  constructor(private readonly store: MemoryStore, private readonly options: LayeredMemoryServiceOptions) {}

  appendProvisionalTopic(topic: TopicSegment): L1TopicView {
    return this.store.layered.appendProvisionalTopic(topic, this.provenance("online-topic-v1", "online topic close", topic.confidence));
  }

  listL1Topics(filter: Parameters<MemoryStore["layered"]["listL1TopicViews"]>[0] = {}): L1TopicView[] {
    return this.store.layered.listL1TopicViews(filter);
  }

  async runL1Maintenance(scope: Scope, sessionId: string): Promise<{
    run: ReturnType<MemoryStore["layered"]["runL1Maintenance"]>;
    topics: L1TopicView[];
  }> {
    const allTopics = this.store.layered.listL1TopicViews({ ...scope, sessionId, includeInactive: true });
    const topics = allTopics.filter(
      (view) => view.revision.status !== "provisional" || view.sourceSegmentStatus === "complete"
    );
    const turns = this.store.recentTurns({ ...scope, sessionId }, 10_000);
    const corrections = this.store.layered.listPendingL1CorrectionsForSession(scope, sessionId);
    const inputCutoff = turns.at(-1)?.createdAt ?? new Date().toISOString();
    const base = this.provenance("l1-maintenance-v1", "offline L1 maintenance", 1);
    const snapshotHash = snapshotDigest({
      kind: "l1",
      scope,
      sessionId,
      topics: topics.map((view) => ({ topicId: view.topic.id, revisionId: view.revision.id, status: view.revision.status })),
      turns: turns.map((turn) => ({ id: turn.id, content: turn.content, createdAt: turn.createdAt })),
      corrections: corrections.map((correction) => ({
        id: correction.id,
        payloadHash: correction.payloadHash,
        createdSequence: correction.createdSequence,
        affectedSource: correction.affectedSource,
        affectedChannel: correction.affectedChannel,
        affectedSessionId: correction.affectedSessionId
      })),
      promptVersion: base.promptVersion,
      schemaVersion: base.schemaVersion,
      runMode: "incremental"
    });
    const prior = this.store.layered.getSuccessfulL1RunBySnapshot(scope, sessionId, snapshotHash);
    if (prior) return { run: prior, topics };
    const plan = await this.options.l1Planner.plan({ scope, sessionId, topics, turns, corrections });
    const run = this.store.layered.runL1Maintenance(scope, sessionId, inputCutoff, plan, {
      provider: base.provider,
      model: base.model,
      promptVersion: base.promptVersion,
      schemaVersion: base.schemaVersion
    }, snapshotHash);
    return { run, topics: this.store.layered.listL1TopicViews({ ...scope, sessionId, includeInactive: true }) };
  }

  async runL2Aggregation(uid: string, agent: string, requestedWatermark?: number): Promise<{
    run: ReturnType<MemoryStore["layered"]["runL2Aggregation"]>;
    aggregates: L2AggregateView[];
  }> {
    const available = this.store.layered.getL1StableWatermark(uid, agent);
    const watermark = requestedWatermark ?? available;
    if (watermark > available) throw new Error(`L1 watermark ${watermark} is not stable; latest is ${available}`);
    const components = this.store.layered.listStableComponents(uid, agent, watermark);
    const aggregates = this.store.layered.listL2AggregateViews(uid, agent, true);
    const corrections = this.store.layered.listReadyL2Corrections(uid, agent);
    const base = this.provenance("l2-synthesis-v1", "offline L2 aggregation", 1);
    const freshness = this.store.layered.getGovernanceFreshness(uid, agent);
    const snapshotHash = snapshotDigest({
      kind: "l2",
      uid,
      agent,
      watermark,
      components: components.map((component) => ({ id: component.id, content: component.content, authority: component.evidenceAuthority })),
      aggregates: aggregates.map((view) => ({ aggregateId: view.aggregate.id, revisionId: view.revision.id, status: view.aggregate.status })),
      corrections: corrections.map((correction) => ({
        id: correction.id,
        payloadHash: correction.payloadHash,
        readySequence: correction.readySequence,
        targetType: correction.targetType,
        targetId: correction.targetId,
        targetRevisionId: correction.targetRevisionId
      })),
      sourceGovernanceWatermark: freshness.appliedGovernanceSequence,
      promptVersion: base.promptVersion,
      schemaVersion: base.schemaVersion,
      runMode: "incremental"
    });
    const prior = this.store.layered.getSuccessfulL2RunBySnapshot(uid, agent, snapshotHash);
    if (prior) return { run: prior, aggregates };
    const plan = await this.options.l2Planner.plan({ uid, agent, watermark, components, aggregates, corrections });
    const outputs: L2SynthesisOutput[] = [];
    for (const membership of plan.desiredMemberships) {
      const selected = components.filter((component) => membership.componentIds.includes(component.id));
      const current = membership.aggregateId ? aggregates.find((view) => view.aggregate.id === membership.aggregateId) : undefined;
      const generated = await this.options.l2Synthesizer.synthesize({
        uid,
        agent,
        componentIds: membership.componentIds,
        components: selected,
        current,
        corrections,
        sourceStatements: current ? sourceStatementsForView(current) : []
      });
      outputs.push({
        membership,
        content: generated.content,
        statementOperations: generated.statementOperations,
        provenance: this.provenance("l2-synthesis-v1", generated.reason, generated.confidence)
      });
    }
    const run = this.store.layered.runL2Aggregation(uid, agent, watermark, plan, outputs, snapshotHash, freshness.appliedGovernanceSequence);
    return { run, aggregates: this.store.layered.listL2AggregateViews(uid, agent, true) };
  }

  async runL3ProfileBuild(uid: string, agent: string): Promise<{
    createdOrUpdated: Memory[];
    rejected: Array<{ profileKey: string; reason: string }>;
  }> {
    const extractor = this.options.profileExtractor;
    if (!extractor) throw new Error("L3 profile extraction is not configured");

    const components = this.store.layered.listStableComponents(uid, agent);
    const componentsById = new Map(components.map((component) => [component.id, component]));
    const aggregates = this.store.layered.listL2AggregateViews(uid, agent);
    const aggregatesById = new Map(aggregates.map((view) => [view.aggregate.id, view]));
    const topicRevisionSessions = new Map(
      this.store.layered
        .listL1TopicViews({ uid, agent, includeInactive: true })
        .map((view) => [view.revision.id, view.topic.sessionId])
    );
    const componentSessions = Object.fromEntries(
      components
        .map((component) => [component.id, topicRevisionSessions.get(component.topicRevisionId)] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    );
    const existingProfiles = this.store
      .listMemories({ uid, agent })
      .filter(
        (memory) =>
          memory.level === "L3" &&
          memory.type === "profile" &&
          memory.status === "active" &&
          memory.metadata.canonicalProfile === true
      );
    const drafts = await extractor.extract({ uid, agent, components, componentSessions, aggregates, existingProfiles });
    const createdOrUpdated: Memory[] = [];
    const rejected: Array<{ profileKey: string; reason: string }> = [];
    const profilesByKey = new Map(existingProfiles.map((profile) => [profile.metadata.profileKey, profile]));
    const freshness = this.store.layered.getGovernanceFreshness(uid, agent);
    const sourceL1Watermark = this.store.layered.getL1StableWatermark(uid, agent);

    for (const draft of drafts) {
      const unknownComponents = draft.evidenceComponentIds.filter((id) => !componentsById.has(id));
      const unknownAggregates = draft.evidenceAggregateIds.filter((id) => !aggregatesById.has(id));
      if (unknownComponents.length || unknownAggregates.length) {
        rejected.push({ profileKey: draft.profileKey, reason: "profile references non-canonical evidence" });
        continue;
      }
      const aggregateComponentIds = draft.evidenceAggregateIds.flatMap(
        (id) => aggregatesById.get(id)?.componentIds ?? []
      );
      if (aggregateComponentIds.some((id) => !componentsById.has(id))) {
        rejected.push({ profileKey: draft.profileKey, reason: "profile Aggregate contains non-canonical evidence" });
        continue;
      }
      const evidenceComponentIds = unique([...draft.evidenceComponentIds, ...aggregateComponentIds]);
      const evidenceComponents = evidenceComponentIds
        .map((id) => componentsById.get(id))
        .filter((component): component is NonNullable<typeof component> => Boolean(component));
      const evidenceSessionIds = unique(
        evidenceComponents
          .map((component) => topicRevisionSessions.get(component.topicRevisionId))
          .filter((sessionId): sessionId is string => Boolean(sessionId))
      );
      if (evidenceSessionIds.length < 2) {
        rejected.push({ profileKey: draft.profileKey, reason: "profile requires canonical evidence from at least two sessions" });
        continue;
      }

      const sourceTurnIds = unique(evidenceComponents.flatMap((component) => component.evidenceTurnIds));
      const evidenceAggregates = draft.evidenceAggregateIds
        .map((id) => aggregatesById.get(id))
        .filter((view): view is NonNullable<typeof view> => Boolean(view));
      const evidenceCorrectionIds = unique([
        ...evidenceComponents.flatMap((component) => component.evidenceCorrectionIds),
        ...evidenceAggregates.flatMap((view) => [
          ...view.revision.facts,
          ...view.revision.decisions,
          ...view.revision.constraints,
          ...view.revision.openQuestions
        ]).flatMap((statement) => statement.evidenceCorrectionIds ?? [])
      ]);
      const metadata = {
        canonicalProfile: true,
        profileKey: draft.profileKey,
        category: draft.category,
        evidenceComponentIds,
        evidenceAggregateIds: unique(draft.evidenceAggregateIds),
        evidenceSessionIds,
        evidenceCorrectionIds,
        sourceTopicRevisionIds: unique(evidenceComponents.map((component) => component.topicRevisionId)),
        sourceL1Watermark,
        sourceGovernanceWatermark: freshness.appliedGovernanceSequence,
        reason: draft.reason
      };
      const existing = profilesByKey.get(draft.profileKey);
      const input = {
        level: "L3" as const,
        type: "profile" as const,
        subject: "user",
        predicate: draft.category,
        object: draft.value,
        summary: draft.summary,
        confidence: draft.confidence,
        status: "active" as const,
        supersedesId: null,
        sourceTurnIds,
        uid,
        source: "canonical",
        agent,
        channel: "profile",
        metadata
      };
      const profile = existing ? this.store.updateMemory(existing.id, input) : this.store.createMemory(input);
      createdOrUpdated.push(profile);
      profilesByKey.set(draft.profileKey, profile);
    }
    this.store.layered.upsertL3ProfileCheckpoint(
      uid,
      agent,
      sourceL1Watermark,
      freshness.appliedGovernanceSequence
    );
    return { createdOrUpdated, rejected };
  }

  async recall(input: { uid: string; agent: string; query: string; limit?: number; sessionId?: string; includeProvisional?: boolean }): Promise<{
    usagePolicy: "reference_only";
    shouldUseMemory: boolean;
    freshness: GovernanceFreshness;
    reason: string;
    results: LayeredRecallResult[];
  }> {
    const limit = input.limit ?? 10;
    const stableComponents = this.store.layered.listStableComponents(input.uid, input.agent);
    const componentsById = new Map(stableComponents.map((component) => [component.id, component]));
    const freshness = this.store.layered.getGovernanceFreshness(input.uid, input.agent);
    const results: LayeredRecallResult[] = [];

    for (const profile of this.store.listMemories({ uid: input.uid, agent: input.agent }).filter(
      (memory) =>
        memory.level === "L3" &&
        memory.type === "profile" &&
        memory.status === "active" &&
        memory.metadata.canonicalProfile === true
    )) {
      const relevance = scoreText(input.query, profile.readableText);
      if (relevance <= 0) continue;
      const score = relevance + 0.6;
      const componentIds = toStringArray(profile.metadata.evidenceComponentIds);
      const evidenceComponents = componentIds
        .map((id) => componentsById.get(id))
        .filter((component): component is NonNullable<typeof component> => Boolean(component));
      const evidenceCorrectionIds = unique([
        ...toStringArray(profile.metadata.evidenceCorrectionIds),
        ...evidenceComponents.flatMap((component) => component.evidenceCorrectionIds)
      ]);
      results.push({
        level: "L3_PROFILE",
        id: profile.id,
        text: profile.readableText,
        score,
        stability: "stable",
        evidence: {
          aggregateIds: toStringArray(profile.metadata.evidenceAggregateIds),
          componentIds,
          topicRevisionIds: toStringArray(profile.metadata.sourceTopicRevisionIds),
          turnIds: profile.sourceTurnIds
        },
        evidenceAuthority: evidenceCorrectionIds.length > 0 ? "human_correction" : "conversation",
        evidenceCorrectionIds,
        statementIds: [],
        statementStatuses: [],
        statementConflicts: [],
        sourceL1Watermark: toOptionalNumber(profile.metadata.sourceL1Watermark),
        sourceGovernanceWatermark: toOptionalNumber(profile.metadata.sourceGovernanceWatermark)
      });
    }

    for (const view of this.store.layered.listL2AggregateViews(input.uid, input.agent)) {
      const statements = [
        ...view.revision.facts,
        ...view.revision.decisions,
        ...view.revision.constraints,
        ...view.revision.openQuestions
      ];
      const text = [
        view.revision.canonicalTitle,
        view.revision.summary,
        ...statements.map((statement) => statement.content)
      ].join("\n");
      const relevance = scoreText(input.query, text);
      if (relevance <= 0) continue;
      const score = relevance + 0.4;
      const components = view.componentIds.map((id) => componentsById.get(id)).filter((value): value is NonNullable<typeof value> => Boolean(value));
      const topicRevisionIds = unique(components.map((component) => component.topicRevisionId));
      const turnIds = unique(components.flatMap((component) => component.evidenceTurnIds));
      const evidenceCorrectionIds = unique(statements.flatMap((statement) => statement.evidenceCorrectionIds ?? []));
      const statementIds = statements.map((statement) => statement.id).filter((id): id is string => Boolean(id));
      const statementStatuses = unique(statements.map((statement) => statement.status ?? "supported")) as Array<"supported" | "contested">;
      const statementConflicts = statements
        .filter((statement) => statement.id && statement.conflictAssessment)
        .map((statement) => ({ statementId: statement.id!, assessment: statement.conflictAssessment! }));
      results.push({
        level: "L2",
        id: view.aggregate.id,
        text,
        score,
        stability: "stable",
        evidence: { aggregateIds: [view.aggregate.id], componentIds: view.componentIds, topicRevisionIds, turnIds },
        evidenceAuthority: evidenceCorrectionIds.length > 0 || statements.some((statement) => statement.evidenceAuthority === "human_correction")
          ? "human_correction"
          : "conversation",
        evidenceCorrectionIds,
        statementIds,
        statementStatuses,
        statementConflicts,
        sourceL1Watermark: view.revision.sourceL1Watermark,
        sourceGovernanceWatermark: freshness.appliedGovernanceSequence
      });
    }

    for (const component of stableComponents) {
      const relevance = scoreText(input.query, component.content);
      if (relevance <= 0) continue;
      const score = relevance + 0.2;
      results.push({
        level: "L1_COMPONENT",
        id: component.id,
        text: component.content,
        score,
        stability: "stable",
        evidence: {
          aggregateIds: [],
          componentIds: [component.id],
          topicRevisionIds: [component.topicRevisionId],
          turnIds: component.evidenceTurnIds
        },
        evidenceAuthority: component.evidenceAuthority,
        evidenceCorrectionIds: component.evidenceCorrectionIds,
        statementIds: [],
        statementStatuses: [],
        statementConflicts: [],
        sourceGovernanceWatermark: freshness.appliedGovernanceSequence
      });
    }

    if (input.includeProvisional ?? true) {
      const topics = this.store.layered.listL1TopicViews({
        uid: input.uid,
        agent: input.agent,
        sessionId: input.sessionId
      });
      for (const view of topics.filter((value) => value.revision.status === "provisional")) {
        const score = scoreText(input.query, `${view.revision.title}\n${view.revision.summary}`);
        if (score <= 0) continue;
        results.push({
          level: "L1_TOPIC",
          id: view.topic.id,
          text: `${view.revision.title}\n${view.revision.summary}`,
          score,
          stability: "provisional",
          evidence: {
            aggregateIds: [],
            componentIds: [],
            topicRevisionIds: [view.revision.id],
            turnIds: view.revision.sourceTurnIds
          },
          evidenceAuthority: "conversation",
          evidenceCorrectionIds: [],
          statementIds: [],
          statementStatuses: [],
          statementConflicts: [],
          sourceGovernanceWatermark: freshness.appliedGovernanceSequence
        });
      }
    }

    const candidates = diversify(results)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(limit * 3, limit));
    const plan = await this.options.recallPlanner.plan({ query: input.query, candidates });
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const unknown = plan.selectedIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`Layered Recall selected unknown ids: ${unknown.join(", ")}`);
    const selected = plan.shouldUseMemory
      ? plan.selectedIds.map((id) => byId.get(id)).filter((result): result is LayeredRecallResult => Boolean(result)).slice(0, limit)
      : [];
    return {
      usagePolicy: "reference_only",
      shouldUseMemory: plan.shouldUseMemory && selected.length > 0,
      freshness,
      reason: plan.reason,
      results: selected
    };
  }

  private provenance(promptVersion: string, reason: string, confidence: number): GenerationProvenance {
    return {
      provider: this.options.provenance?.provider,
      model: this.options.provenance?.model,
      promptVersion,
      schemaVersion: "v2",
      reason,
      confidence
    };
  }
}

const l1ComponentSchema = z.object({
  content: z.string().min(1),
  labels: z.array(z.string()).default([]),
  evidenceTurnIds: z.array(z.string()).default([]),
  evidenceCorrectionIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional()
});
const l1PlanSchema: z.ZodType<L1MaintenancePlan> = z.object({
  handledCorrectionIds: z.array(z.string()).default([]),
  items: z.array(
    z.object({
      operation: z.enum(["keep", "revise", "merge", "split", "delete", "noop"]),
      sourceTopicIds: z.array(z.string()).min(1),
      targetTopicId: z.string().optional(),
      title: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      sourceTurnIds: z.array(z.string()).optional(),
      components: z.array(l1ComponentSchema).optional(),
      reason: z.string().min(1),
      confidence: z.number().min(0).max(1)
    })
  )
});

const l2PlanSchema = z.object({
  handledCorrectionIds: z.array(z.string()).default([]),
  operations: z.array(
    z.object({
      operation: z.enum(["attach", "create", "reassign", "merge", "split", "remove", "ignore", "unchanged"]),
      targetAggregateId: z.string().optional(),
      sourceAggregateIds: z.array(z.string()).optional(),
      componentIds: z.array(z.string()),
      reason: z.string().min(1),
      confidence: z.number().min(0).max(1)
    })
  ),
  desiredMemberships: z.array(
    z.object({
      aggregateId: z.string().optional(),
      sourceAggregateIds: z.array(z.string()).optional(),
      componentIds: z.array(z.string()).min(1)
    })
  ),
  retireAggregateIds: z.array(z.string())
});

const statementSchema: z.ZodType<L2Statement> = z.object({
  id: z.string().optional(),
  content: z.string().min(1),
  evidenceComponentIds: z.array(z.string()).default([]),
  evidenceCorrectionIds: z.array(z.string()).default([]),
  semanticOrigin: z.literal("derived").optional(),
  evidenceAuthority: z.enum(["conversation", "human_correction"]).optional(),
  status: z.enum(["supported", "contested"]).default("supported"),
  conflictAssessment: z
    .object({
      summary: z.string().min(1),
      supportingEvidenceRefs: z.array(z.union([
        z.object({ kind: z.literal("component"), id: z.string() }),
        z.object({ kind: z.literal("correction"), id: z.string() })
      ])),
      conflictingEvidenceRefs: z.array(z.union([
        z.object({ kind: z.literal("component"), id: z.string() }),
        z.object({ kind: z.literal("correction"), id: z.string() })
      ])),
      alternatives: z.array(z.string().min(1))
    })
    .nullable()
    .default(null),
  confidence: z.number().min(0).max(1),
  qualifier: z.string().optional()
}) as z.ZodType<L2Statement>;
const statementOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("continue"), sourceRef: z.string(), statement: statementSchema }),
  z.object({ op: z.literal("create"), statement: statementSchema }),
  z.object({ op: z.literal("merge"), sourceRefs: z.array(z.string()).min(2), statement: statementSchema }),
  z.object({ op: z.literal("split"), sourceRef: z.string(), statements: z.array(statementSchema).min(1) }),
  z.object({ op: z.literal("retire"), sourceRef: z.string() })
]);
const l2ContentSchema = z.object({
  aggregateType: z.string().min(1),
  canonicalTitle: z.string().min(1),
  aliases: z.array(z.string()),
  externalKeys: z.record(z.string(), z.string()),
  labels: z.array(z.string()),
  summary: z.string().min(1),
  facts: z.array(statementSchema),
  decisions: z.array(statementSchema),
  constraints: z.array(statementSchema),
  openQuestions: z.array(statementSchema)
});

const canonicalProfileSchema = z.object({
  profileKey: z.string().min(1),
  category: z.enum(["preference", "identity", "habit", "constraint", "relationship", "other"]),
  value: z.string().min(1),
  summary: z.string().min(1),
  evidenceComponentIds: z.array(z.string()).default([]),
  evidenceAggregateIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
}) as z.ZodType<CanonicalProfileDraft>;

export class LlmL1MaintenancePlanner implements L1MaintenancePlanner {
  constructor(private readonly client: LlmCompletionClient) {}
  async plan(input: Parameters<L1MaintenancePlanner["plan"]>[0]): Promise<L1MaintenancePlan> {
    return parseJson(
      await this.client.complete(
        JSON.stringify({
          task: "Maintain L1 Topics within exactly one session. Return JSON only.",
          rules: [
            "Use only supplied Topic and Turn ids.",
            "Decide keep, revise, merge, split, delete, or noop.",
            "Extract self-contained Components with exact evidenceTurnIds.",
            "Every supplied Correction id must appear exactly once in handledCorrectionIds.",
            "Replacement Components cite the Correction in evidenceCorrectionIds.",
            "Never combine Topics from different sessions."
          ],
          scope: input.scope,
          sessionId: input.sessionId,
          topics: input.topics,
          turns: input.turns,
          corrections: input.corrections,
          responseSchema: "{handledCorrectionIds:[],items:[{operation,sourceTopicIds,targetTopicId?,title?,summary?,sourceTurnIds?,components?,reason,confidence}]}"
        })
      ),
      l1PlanSchema,
      "L1 maintenance"
    );
  }
}

export class LlmL2MembershipPlanner implements L2MembershipPlanner {
  constructor(private readonly client: LlmCompletionClient) {}
  async plan(input: Parameters<L2MembershipPlanner["plan"]>[0]): Promise<L2MembershipPlan> {
    return parseJson(
      await this.client.complete(
        JSON.stringify({
          task: "Plan cross-session L2 Component membership. Return JSON only.",
          rules: [
            "Use only supplied Component and Aggregate ids.",
            "LLM decides semantic membership; do not group only by string equality.",
            "desiredMemberships is the final complete membership for every changed aggregate.",
            "Every supplied ready Correction id must appear exactly once in handledCorrectionIds.",
            "Projects are one possible topic, not the definition of L2."
          ],
          uid: input.uid,
          agent: input.agent,
          watermark: input.watermark,
          components: input.components,
          aggregates: input.aggregates,
          corrections: input.corrections,
          responseSchema: "{handledCorrectionIds:[],operations:[...],desiredMemberships:[{aggregateId?,sourceAggregateIds?,componentIds}],retireAggregateIds:[]}"
        })
      ),
      l2PlanSchema,
      "L2 membership"
    );
  }
}

export class LlmL2RevisionSynthesizer implements L2RevisionSynthesizer {
  constructor(private readonly client: LlmCompletionClient) {}
  async synthesize(input: Parameters<L2RevisionSynthesizer["synthesize"]>[0]): Promise<{
    content: L2AggregateContent;
    statementOperations?: StatementOperation[];
    reason: string;
    confidence: number;
  }> {
    const schema = z.object({
      content: l2ContentSchema,
      statementOperations: z.array(statementOperationSchema).optional(),
      reason: z.string().min(1),
      confidence: z.number().min(0).max(1)
    });
    return parseJson(
      await this.client.complete(
        JSON.stringify({
          task: "Synthesize one L2 Knowledge Aggregate Revision from validated Components. Return JSON only.",
          rules: [
            "Every statement must cite evidenceComponentIds from the supplied membership.",
            "When sourceStatements are supplied, use statementOperations with only supplied sourceRef values.",
            "A replacement Correction successor must cite that Correction in evidenceCorrectionIds.",
            "A retract Correction must retire its sourceRef.",
            "Preserve current state, decisions, constraints, and open questions without inventing facts.",
            "The summary is a view; Components remain the evidence source."
          ],
          uid: input.uid,
          agent: input.agent,
          current: input.current,
          components: input.components,
          corrections: input.corrections,
          sourceStatements: input.sourceStatements,
          responseSchema: "{content:{aggregateType,canonicalTitle,aliases,externalKeys,labels,summary,facts,decisions,constraints,openQuestions},statementOperations?,reason,confidence}"
        })
      ),
      schema,
      "L2 synthesis"
    );
  }
}

export class LlmCanonicalProfileExtractor implements CanonicalProfileExtractor {
  constructor(private readonly client: LlmCompletionClient) {}

  async extract(input: Parameters<CanonicalProfileExtractor["extract"]>[0]): Promise<CanonicalProfileDraft[]> {
    const schema = z.object({ profiles: z.array(canonicalProfileSchema) });
    const parsed = parseJson(
      await this.client.complete(
        JSON.stringify({
          task: "Extract only cross-session stable L3 user profiles from canonical L1/L2 evidence. Return JSON only.",
          rules: [
            "Use only supplied canonical Component and active Aggregate ids.",
            "A profile must be supported across at least two distinct sessions; the server validates this strictly.",
            "Do not promote temporary tasks, one-off project state, or unresolved questions.",
            "Use a stable profileKey so repeated builds update the same profile.",
            "Prefer durable preferences, identity, habits, constraints, and relationships."
          ],
          uid: input.uid,
          agent: input.agent,
          components: input.components,
          componentSessions: input.componentSessions,
          aggregates: input.aggregates,
          existingProfiles: input.existingProfiles.map((profile) => ({
            id: profile.id,
            profileKey: profile.metadata.profileKey,
            category: profile.metadata.category,
            value: profile.object,
            summary: profile.summary
          })),
          responseSchema:
            "{profiles:[{profileKey,category,value,summary,evidenceComponentIds,evidenceAggregateIds,confidence,reason}]}"
        })
      ),
      schema,
      "L3 profile extraction"
    );
    return parsed.profiles;
  }
}

export class LlmLayeredRecallPlanner implements LayeredRecallPlanner {
  constructor(private readonly client: LlmCompletionClient) {}
  async plan(input: { query: string; candidates: LayeredRecallResult[] }): Promise<{
    shouldUseMemory: boolean;
    selectedIds: string[];
    reason: string;
  }> {
    const schema = z.object({
      shouldUseMemory: z.boolean(),
      selectedIds: z.array(z.string()),
      reason: z.string().min(1)
    });
    return parseJson(
      await this.client.complete(
        JSON.stringify({
          task: "Select a compact, complementary layered-memory evidence set. Return JSON only.",
          rules: [
            "Use memory only when it materially improves the answer.",
            "Avoid near-duplicate evidence.",
            "Prefer stable L2 context plus precise L1 Components when both are useful.",
            "Use only candidate ids."
          ],
          query: input.query,
          candidates: input.candidates,
          responseSchema: "{shouldUseMemory,selectedIds,reason}"
        })
      ),
      schema,
      "layered Recall"
    );
  }
}

function parseJson<T>(raw: string, schema: z.ZodType<T>, name: string): T {
  try {
    return schema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`Invalid ${name} response: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

function scoreText(query: string, text: string): number {
  const compactQuery = query.toLowerCase().replace(/\s+/g, "");
  const compactText = text.toLowerCase().replace(/\s+/g, "");
  return (compactText.includes(compactQuery) ? 1 : 0) + jaccard(query, text);
}

function diversify(results: LayeredRecallResult[]): LayeredRecallResult[] {
  const seen = new Set<string>();
  return [...results]
    .sort((left, right) => right.score - left.score)
    .filter((result) => {
      const key = result.text.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function snapshotDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceStatementsForView(view: L2AggregateView): Array<{
  sourceRef: string;
  revisionId: string;
  statementId: string;
  category: "facts" | "decisions" | "constraints" | "openQuestions";
  content: string;
}> {
  const sourceStatements: Array<{
    sourceRef: string;
    revisionId: string;
    statementId: string;
    category: "facts" | "decisions" | "constraints" | "openQuestions";
    content: string;
  }> = [];
  let index = 0;
  for (const category of ["facts", "decisions", "constraints", "openQuestions"] as const) {
    for (const statement of view.revision[category]) {
      if (!statement.id) throw new Error("L2 source Statement is missing an ID");
      sourceStatements.push({
        sourceRef: `s${index++}`,
        revisionId: view.revision.id,
        statementId: statement.id,
        category,
        content: statement.content
      });
    }
  }
  return sourceStatements;
}
