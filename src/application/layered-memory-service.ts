import { z } from "zod";
import type { LlmCompletionClient } from "../domain/extractors.js";
import { jaccard } from "../domain/text.js";
import type {
  GenerationProvenance,
  L1MaintenancePlan,
  L1TopicRevision,
  L2AggregateContent,
  L2MembershipPlan,
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
  }): Promise<L1MaintenancePlan>;
}

export interface L2MembershipPlanner {
  plan(input: {
    uid: string;
    agent: string;
    watermark: number;
    components: ReturnType<MemoryStore["layered"]["listStableComponents"]>;
    aggregates: L2AggregateView[];
  }): Promise<L2MembershipPlan>;
}

export interface L2RevisionSynthesizer {
  synthesize(input: {
    uid: string;
    agent: string;
    componentIds: string[];
    components: ReturnType<MemoryStore["layered"]["listStableComponents"]>;
    current?: L2AggregateView;
  }): Promise<{ content: L2AggregateContent; reason: string; confidence: number }>;
}

export interface LayeredRecallResult {
  level: "L2" | "L1_COMPONENT" | "L1_TOPIC";
  id: string;
  text: string;
  score: number;
  stability: "stable" | "provisional";
  evidence: {
    componentIds: string[];
    topicRevisionIds: string[];
    turnIds: string[];
  };
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
    const topics = this.store.layered.listL1TopicViews({ ...scope, sessionId, includeInactive: true });
    const turns = this.store.recentTurns({ ...scope, sessionId }, 10_000);
    const inputCutoff = turns.at(-1)?.createdAt ?? new Date().toISOString();
    const plan = await this.options.l1Planner.plan({ scope, sessionId, topics, turns });
    const base = this.provenance("l1-maintenance-v1", "offline L1 maintenance", 1);
    const run = this.store.layered.runL1Maintenance(scope, sessionId, inputCutoff, plan, {
      provider: base.provider,
      model: base.model,
      promptVersion: base.promptVersion,
      schemaVersion: base.schemaVersion
    });
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
    const plan = await this.options.l2Planner.plan({ uid, agent, watermark, components, aggregates });
    const outputs: L2SynthesisOutput[] = [];
    for (const membership of plan.desiredMemberships) {
      const selected = components.filter((component) => membership.componentIds.includes(component.id));
      const current = membership.aggregateId ? aggregates.find((view) => view.aggregate.id === membership.aggregateId) : undefined;
      const generated = await this.options.l2Synthesizer.synthesize({
        uid,
        agent,
        componentIds: membership.componentIds,
        components: selected,
        current
      });
      outputs.push({
        membership,
        content: generated.content,
        provenance: this.provenance("l2-synthesis-v1", generated.reason, generated.confidence)
      });
    }
    const run = this.store.layered.runL2Aggregation(uid, agent, watermark, plan, outputs);
    return { run, aggregates: this.store.layered.listL2AggregateViews(uid, agent, true) };
  }

  async recall(input: { uid: string; agent: string; query: string; limit?: number; sessionId?: string; includeProvisional?: boolean }): Promise<{
    shouldUseMemory: boolean;
    reason: string;
    results: LayeredRecallResult[];
  }> {
    const limit = input.limit ?? 10;
    const stableComponents = this.store.layered.listStableComponents(input.uid, input.agent);
    const componentsById = new Map(stableComponents.map((component) => [component.id, component]));
    const results: LayeredRecallResult[] = [];

    for (const view of this.store.layered.listL2AggregateViews(input.uid, input.agent)) {
      const text = [view.revision.canonicalTitle, view.revision.summary].join("\n");
      const score = scoreText(input.query, text) + 0.4;
      if (score <= 0) continue;
      const components = view.componentIds.map((id) => componentsById.get(id)).filter((value): value is NonNullable<typeof value> => Boolean(value));
      const topicRevisionIds = unique(components.map((component) => component.topicRevisionId));
      const turnIds = unique(components.flatMap((component) => component.evidenceTurnIds));
      results.push({
        level: "L2",
        id: view.aggregate.id,
        text,
        score,
        stability: "stable",
        evidence: { componentIds: view.componentIds, topicRevisionIds, turnIds }
      });
    }

    for (const component of stableComponents) {
      const score = scoreText(input.query, component.content) + 0.2;
      if (score <= 0) continue;
      results.push({
        level: "L1_COMPONENT",
        id: component.id,
        text: component.content,
        score,
        stability: "stable",
        evidence: {
          componentIds: [component.id],
          topicRevisionIds: [component.topicRevisionId],
          turnIds: component.evidenceTurnIds
        }
      });
    }

    if (input.includeProvisional && input.sessionId) {
      const topics = this.store.layered.listL1TopicViews({ uid: input.uid, agent: input.agent, sessionId: input.sessionId });
      for (const view of topics.filter((value) => value.revision.status === "provisional")) {
        const score = scoreText(input.query, `${view.revision.title}\n${view.revision.summary}`);
        if (score <= 0) continue;
        results.push({
          level: "L1_TOPIC",
          id: view.topic.id,
          text: `${view.revision.title}\n${view.revision.summary}`,
          score,
          stability: "provisional",
          evidence: { componentIds: [], topicRevisionIds: [view.revision.id], turnIds: view.revision.sourceTurnIds }
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
    return { shouldUseMemory: plan.shouldUseMemory && selected.length > 0, reason: plan.reason, results: selected };
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
  evidenceTurnIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1).optional()
});
const l1PlanSchema: z.ZodType<L1MaintenancePlan> = z.object({
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

const statementSchema = z.object({
  content: z.string().min(1),
  evidenceComponentIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  qualifier: z.string().optional()
});
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
            "Never combine Topics from different sessions."
          ],
          scope: input.scope,
          sessionId: input.sessionId,
          topics: input.topics,
          turns: input.turns,
          responseSchema: "{items:[{operation,sourceTopicIds,targetTopicId?,title?,summary?,sourceTurnIds?,components?,reason,confidence}]}"
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
            "Projects are one possible topic, not the definition of L2."
          ],
          uid: input.uid,
          agent: input.agent,
          watermark: input.watermark,
          components: input.components,
          aggregates: input.aggregates,
          responseSchema: "{operations:[...],desiredMemberships:[{aggregateId?,sourceAggregateIds?,componentIds}],retireAggregateIds:[]}"
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
    reason: string;
    confidence: number;
  }> {
    const schema = z.object({ content: l2ContentSchema, reason: z.string().min(1), confidence: z.number().min(0).max(1) });
    return parseJson(
      await this.client.complete(
        JSON.stringify({
          task: "Synthesize one L2 Knowledge Aggregate Revision from validated Components. Return JSON only.",
          rules: [
            "Every statement must cite evidenceComponentIds from the supplied membership.",
            "Preserve current state, decisions, constraints, and open questions without inventing facts.",
            "The summary is a view; Components remain the evidence source."
          ],
          uid: input.uid,
          agent: input.agent,
          current: input.current,
          components: input.components,
          responseSchema: "{content:{aggregateType,canonicalTitle,aliases,externalKeys,labels,summary,facts,decisions,constraints,openQuestions},reason,confidence}"
        })
      ),
      schema,
      "L2 synthesis"
    );
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
