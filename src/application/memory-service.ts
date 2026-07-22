import { cosineSimilarity, OpenAICompatibleEmbeddingProvider, type EmbeddingProvider } from "../domain/embedding.js";
import {
  LlmAmbiguousTopicModel,
  LlmL2AggregationModel,
  LlmL3ProfilingModel,
  LlmRecallModel,
  LlmTopicMaintenanceModel,
  OpenAICompatibleCompletionClient,
  type AmbiguousTopicModel,
  type L2AggregationModel,
  type L3ProfilingModel,
  type RecallModel,
  type TopicMaintenanceModel
} from "../domain/models.js";
import { isHighPrecisionLowInformation } from "../domain/text.js";
import type { IngestTurnInput, RecallItem, Session, Topic, Turn } from "../domain/types.js";
import type { MemoryRepository } from "../storage/repositories.js";

export interface MemoryServiceOptions {
  embeddingProvider?: EmbeddingProvider;
  ambiguousTopicModel?: AmbiguousTopicModel;
  topicMaintenanceModel?: TopicMaintenanceModel;
  l2AggregationModel?: L2AggregationModel;
  l3ProfilingModel?: L3ProfilingModel;
  recallModel?: RecallModel;
  topicThresholds?: { join: number; split: number };
  maxTopicTurns?: number;
}

export function createRuntimeMemoryService(repository: MemoryRepository) {
  const client = new OpenAICompatibleCompletionClient();
  const boundaryClient = new OpenAICompatibleCompletionClient({
    baseUrl: process.env.TOPIC_BOUNDARY_LLM_BASE_URL ?? process.env.LLM_BASE_URL,
    apiKey: process.env.TOPIC_BOUNDARY_LLM_API_KEY ?? process.env.LLM_API_KEY,
    model: process.env.TOPIC_BOUNDARY_LLM_MODEL ?? process.env.LLM_MODEL ?? "gpt-4.1-mini"
  });
  return createMemoryService(repository, {
    embeddingProvider: new OpenAICompatibleEmbeddingProvider(),
    ambiguousTopicModel: new LlmAmbiguousTopicModel(boundaryClient),
    topicMaintenanceModel: new LlmTopicMaintenanceModel(client),
    l2AggregationModel: new LlmL2AggregationModel(client),
    l3ProfilingModel: new LlmL3ProfilingModel(client),
    recallModel: new LlmRecallModel(client)
  });
}

export function createMemoryService(repository: MemoryRepository, options: MemoryServiceOptions = {}) {
  const thresholds = options.topicThresholds ?? { join: 0.82, split: 0.55 };
  if (!(thresholds.split >= -1 && thresholds.join <= 1 && thresholds.split < thresholds.join)) {
    throw new Error("Topic thresholds must satisfy -1 <= split < join <= 1");
  }
  const maxTopicTurns = options.maxTopicTurns ?? 100;

  return {
    async ingestTurn(input: IngestTurnInput) {
      const session = repository.resolveSession(input);
      const turn = repository.appendTurn({
        uid: input.uid,
        agentId: input.agentId,
        sessionId: session.id,
        eventId: input.eventId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ?? {}
      });

      const alreadyDerived = repository.listTopics(session.id).find((topic) => topic.turnIds.includes(turn.id));
      if (alreadyDerived) {
        return { session, turn, topic: alreadyDerived, derivation: { status: "applied" as const, reason: "idempotent" } };
      }

      try {
        const topic = await deriveRealtimeTopic(repository, session, turn, options, thresholds, maxTopicTurns);
        repository.setRebuildJob("topic", session.id, "dirty", "online_topic_changed");
        return { session, turn, topic, derivation: { status: "applied" as const, reason: "online_topic" } };
      } catch (error) {
        repository.setRebuildJob(
          "topic",
          session.id,
          "dirty",
          "online_model_deferred",
          error instanceof Error ? error.message : "unknown error"
        );
        return { session, turn, topic: repository.getOpenTopic(session.id), derivation: { status: "deferred" as const, reason: "model_unavailable" } };
      }
    },

    flushSession(input: { uid: string; agentId: string; externalSessionId: string }) {
      const session = requireSession(repository, input);
      const topic = repository.closeOpenTopic(session.id);
      if (topic) repository.setRebuildJob("topic", session.id, "dirty", "explicit_flush");
      return { session, topic };
    },

    async maintainTopics(input: { uid: string; agentId: string; externalSessionId: string }) {
      const model = requireModel(options.topicMaintenanceModel, "TopicMaintenanceModel");
      const session = requireSession(repository, input);
      const turns = repository.listTurns(session.id);
      repository.setRebuildJob("topic", session.id, "rebuilding", "topic_maintenance_started");
      try {
        const result = await model.rebuild({
          turns,
          currentTopics: repository.listTopics(session.id),
          corrections: repository.listCorrectionsForSession(session.id)
        });
        validateTopicSnapshot(turns, result.topics);
        const topics = repository.replaceTopics(session.id, result.topics);
        repository.markSpacesForAgentDirty(session.uid, session.agentId, "processed_topics_changed");
        return { session, topics };
      } catch (error) {
        repository.setRebuildJob(
          "topic",
          session.id,
          "dirty",
          "topic_maintenance_failed",
          error instanceof Error ? error.message : "unknown error"
        );
        throw error;
      }
    },

    async rebuildL2(input: { uid: string; agentId: string; memorySpaceId: string }) {
      const model = requireModel(options.l2AggregationModel, "L2AggregationModel");
      repository.assertSpaceAccess(input.uid, input.agentId, input.memorySpaceId);
      repository.setRebuildJob("L2", input.memorySpaceId, "rebuilding", "l2_rebuild_started");
      try {
        const topics = repository.listProcessedTopicsForSpace(input.memorySpaceId);
        const current = repository.listL2(input.memorySpaceId);
        const result = await model.rebuild({ topics, currentAggregates: current });
        validateL2Snapshot(topics, result.aggregates);
        return { aggregates: repository.replaceL2Snapshot(input.memorySpaceId, result.aggregates) };
      } catch (error) {
        repository.setRebuildJob(
          "L2",
          input.memorySpaceId,
          "dirty",
          "l2_rebuild_failed",
          error instanceof Error ? error.message : "unknown error"
        );
        throw error;
      }
    },

    async rebuildL3(input: { uid: string; agentId: string; memorySpaceId: string }) {
      const model = requireModel(options.l3ProfilingModel, "L3ProfilingModel");
      repository.assertSpaceAccess(input.uid, input.agentId, input.memorySpaceId);
      repository.setRebuildJob("L3", input.memorySpaceId, "rebuilding", "l3_rebuild_started");
      try {
        const aggregates = repository.listL2(input.memorySpaceId);
        const current = repository.listL3(input.memorySpaceId);
        const result = await model.rebuild({ aggregates, currentProfiles: current });
        validateL3Snapshot(aggregates, result.profiles);
        return { profiles: repository.replaceL3Snapshot(input.memorySpaceId, result.profiles) };
      } catch (error) {
        repository.setRebuildJob(
          "L3",
          input.memorySpaceId,
          "dirty",
          "l3_rebuild_failed",
          error instanceof Error ? error.message : "unknown error"
        );
        throw error;
      }
    },

    async recall(input: { uid: string; agentId: string; query: string; externalSessionId?: string }) {
      const model = requireModel(options.recallModel, "RecallModel");
      const session = input.externalSessionId
        ? repository.getSessionByExternal(input.uid, input.agentId, input.externalSessionId)
        : null;
      if (input.externalSessionId && !session) throw new Error("Session not found in uid + agentId tenant");
      const source = repository.listRecallCandidates(input.uid, input.agentId, session?.id);
      const candidates: RecallItem[] = [
        ...source.topics.map((topic) => ({
          id: topic.id,
          layer: "topic" as const,
          content: topic.summary || topic.recallText,
          provenanceTurnIds: topic.turnIds,
          memorySpaceId: null
        })),
        ...source.l2.map((item) => ({
          id: item.id,
          layer: "L2" as const,
          content: item.content,
          provenanceTurnIds: item.evidenceTurnIds,
          memorySpaceId: item.memorySpaceId
        })),
        ...source.l3.map((item) => ({
          id: item.id,
          layer: "L3" as const,
          content: item.content,
          provenanceTurnIds: source.l2
            .filter((l2) => item.evidenceL2Ids.includes(l2.id))
            .flatMap((l2) => l2.evidenceTurnIds),
          memorySpaceId: item.memorySpaceId
        }))
      ];
      if (candidates.length === 0) return { items: [], reason: "no_candidates", freshness: freshness(repository, []) };
      const ranking = await model.rank({ query: input.query, candidates });
      const allowed = new Set(candidates.map((candidate) => candidate.id));
      if (ranking.ids.some((id) => !allowed.has(id))) throw new Error("Recall model returned an unauthorized candidate ID");
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const items = ranking.ids.map((id) => byId.get(id)).filter((item): item is RecallItem => Boolean(item));
      return { items, reason: ranking.reason, freshness: freshness(repository, repository.listAuthorizedSpaces(input.uid, input.agentId).map((s) => s.id)) };
    },

    getSession(input: { uid: string; agentId: string; externalSessionId: string }) {
      return { session: requireSession(repository, input) };
    },

    listTopics(input: { uid: string; agentId: string; externalSessionId: string }) {
      const session = requireSession(repository, input);
      return { session, topics: repository.listTopics(session.id) };
    },

    listSpaces(input: { uid: string; agentId: string }) {
      return { spaces: repository.listAuthorizedSpaces(input.uid, input.agentId) };
    },

    createSharedSpace(input: { uid: string; agentId: string; name: string }) {
      return { space: repository.createSharedSpace(input.uid, input.name, input.agentId) };
    },

    addSpaceMember(input: { uid: string; agentId: string; memorySpaceId: string; memberAgentId: string }) {
      repository.assertSpaceAccess(input.uid, input.agentId, input.memorySpaceId);
      repository.addSpaceMember(input.uid, input.memorySpaceId, input.memberAgentId);
      return { space: repository.getMemorySpace(input.memorySpaceId) };
    },

    listL2(input: { uid: string; agentId: string; memorySpaceId: string }) {
      repository.assertSpaceAccess(input.uid, input.agentId, input.memorySpaceId);
      return { aggregates: repository.listL2(input.memorySpaceId) };
    },

    listL3(input: { uid: string; agentId: string; memorySpaceId: string }) {
      repository.assertSpaceAccess(input.uid, input.agentId, input.memorySpaceId);
      return { profiles: repository.listL3(input.memorySpaceId) };
    },

    correctTurn(input: {
      uid: string;
      agentId: string;
      targetTurnId: string;
      correctedContent: string | null;
      reason: string;
    }) {
      return { correction: repository.createCorrection(input) };
    }
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;

async function deriveRealtimeTopic(
  repository: MemoryRepository,
  session: Session,
  turn: Turn,
  options: MemoryServiceOptions,
  thresholds: { join: number; split: number },
  maxTopicTurns: number
): Promise<Topic | null> {
  const lowInformation = isHighPrecisionLowInformation(turn.content);
  const open = repository.getOpenTopic(session.id);
  if (!open) return lowInformation ? null : repository.createOpenTopic(session.id, turn, true);
  if (lowInformation) return repository.appendTurnToTopic(open.id, turn, false);
  if (open.turnIds.length >= maxTopicTurns) return repository.splitOpenTopic(session.id, turn).open;
  if (!open.recallText) return repository.appendTurnToTopic(open.id, turn, true);

  const embedding = requireModel(options.embeddingProvider, "EmbeddingProvider");
  const [topicVector, turnVector] = await embedding.embedMany([open.recallText, turn.content]);
  const similarity = cosineSimilarity(topicVector!, turnVector!);
  if (similarity >= thresholds.join) return repository.appendTurnToTopic(open.id, turn, true);
  if (similarity <= thresholds.split) return repository.splitOpenTopic(session.id, turn).open;

  const model = requireModel(options.ambiguousTopicModel, "AmbiguousTopicModel");
  const decision = await model.decide({ topicText: open.recallText, turnText: turn.content });
  return decision === "continue"
    ? repository.appendTurnToTopic(open.id, turn, true)
    : repository.splitOpenTopic(session.id, turn).open;
}

function requireSession(repository: MemoryRepository, input: { uid: string; agentId: string; externalSessionId: string }): Session {
  const session = repository.getSessionByExternal(input.uid, input.agentId, input.externalSessionId);
  if (!session) throw new Error("Session not found in uid + agentId tenant");
  return session;
}

function requireModel<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`${name} is required; no rule-based semantic fallback is available`);
  return value;
}

function validateTopicSnapshot(turns: Turn[], topics: Array<{ id: string; turnIds: string[] }>): void {
  const order = new Map(turns.map((turn) => [turn.id, turn.sequence]));
  const seenIds = new Set<string>();
  const seenTurns = new Set<string>();
  let previousGlobalSequence = 0;
  for (const topic of topics) {
    if (seenIds.has(topic.id)) throw new Error(`Duplicate Topic id: ${topic.id}`);
    if (topic.turnIds.length === 0) throw new Error(`Topic has no Turns: ${topic.id}`);
    seenIds.add(topic.id);
    for (const turnId of topic.turnIds) {
      const sequence = order.get(turnId);
      if (!sequence) throw new Error(`Topic references a Turn outside the Session: ${turnId}`);
      if (seenTurns.has(turnId)) throw new Error(`Turn appears in multiple Topics: ${turnId}`);
      if (sequence <= previousGlobalSequence) throw new Error(`Topic order or Turn interval is invalid: ${topic.id}`);
      previousGlobalSequence = sequence;
      seenTurns.add(turnId);
    }
  }
  for (const turn of turns) {
    if (!isHighPrecisionLowInformation(turn.content) && !seenTurns.has(turn.id)) {
      throw new Error(`Topic snapshot omitted meaningful Turn: ${turn.id}`);
    }
  }
}

function validateL2Snapshot(
  topics: Topic[],
  aggregates: Array<{ id: string; key: string; evidenceTurnIds: string[]; sourceAgentIds: string[]; confidence: number }>
): void {
  assertUnique(aggregates.map((item) => item.id), "L2 id");
  assertUnique(aggregates.map((item) => item.key), "L2 key");
  const evidence = new Set(topics.flatMap((topic) => topic.turnIds));
  for (const item of aggregates) {
    if (item.evidenceTurnIds.length === 0 || item.sourceAgentIds.length === 0) {
      throw new Error(`L2 aggregate requires direct Turn evidence and source Agent IDs: ${item.id}`);
    }
    assertConfidence(item.confidence, `L2 aggregate ${item.id}`);
    for (const turnId of item.evidenceTurnIds) {
      if (!evidence.has(turnId)) throw new Error(`L2 evidence is not in current processed Topics: ${turnId}`);
    }
  }
}

function validateL3Snapshot(
  aggregates: Array<{ id: string }>,
  profiles: Array<{ id: string; key: string; evidenceL2Ids: string[]; confidence: number }>
): void {
  assertUnique(profiles.map((item) => item.id), "L3 id");
  assertUnique(profiles.map((item) => item.key), "L3 key");
  const evidence = new Set(aggregates.map((item) => item.id));
  for (const item of profiles) {
    if (item.evidenceL2Ids.length === 0) throw new Error(`L3 profile requires current L2 evidence: ${item.id}`);
    assertConfidence(item.confidence, `L3 profile ${item.id}`);
    for (const l2Id of item.evidenceL2Ids) {
      if (!evidence.has(l2Id)) throw new Error(`L3 evidence is not in the current L2 snapshot: ${l2Id}`);
    }
  }
}

function assertConfidence(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} confidence must be between 0 and 1`);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function freshness(repository: MemoryRepository, spaceIds: string[]) {
  const jobs = spaceIds.flatMap((id) => [repository.getRebuildJob("L2", id), repository.getRebuildJob("L3", id)]).filter(Boolean);
  return { stale: jobs.some((job) => job!.status !== "clean"), jobs };
}
