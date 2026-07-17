import {
  LlmMemoryCompressor,
  type DreamingResult,
  type MemoryCompressor
} from "../domain/dreaming.js";
import {
  OpenAICompatibleEmbeddingProvider,
  SqliteVectorIndex,
  type EmbeddingIndex,
  type EmbeddingProvider
} from "../domain/embedding.js";
import { OpenAICompatibleCompletionClient } from "../domain/extractors.js";
import {
  LlmProjectMemoryExtractor,
  ModelProjectMemoryBuilder,
  type ProjectMemoryBuilder
} from "../domain/project-memory.js";
import { LlmMemoryRecallPlanner, type MemoryRecallPlanner, type RecallInput } from "../domain/recall.js";
import { LlmMemoryResolver, type MemoryResolver } from "../domain/resolver.js";
import { searchMemories, type SearchInput, type SearchResult } from "../domain/search.js";
import { LlmTopicBoundaryDetector } from "../domain/topic-boundary.js";
import { LlmTopicMemoryGenerator, topicMemoryUnitToDraft } from "../domain/topic-memory.js";
import { SlidingTopicBuilder, type TopicBuilder } from "../domain/topics.js";
import type {
  ConversationTurn,
  CorrectionRecord,
  CorrectionStatus,
  CreateMemoryInput,
  CreateCorrectionInput,
  CreateTurnInput,
  GovernanceFreshness,
  Memory,
  MemoryStatus,
  ProjectBuildRun,
  ProjectBuildRunStatus,
  Scope,
  TopicSegment,
  TopicType
} from "../domain/types.js";
import type { MemoryStore } from "../storage/store.js";
import { loadTopicWindowConfig } from "./topic-config.js";
import {
  LayeredMemoryService,
  LlmCanonicalProfileExtractor,
  LlmL1MaintenancePlanner,
  LlmL2MembershipPlanner,
  LlmL2RevisionSynthesizer,
  LlmLayeredRecallPlanner,
  type LayeredRecallResult
} from "./layered-memory-service.js";
import type Database from "better-sqlite3";

export interface IngestTurnResult {
  turn: ConversationTurn;
  topic: TopicSegment | null;
  memories: Memory[];
}

export interface MemoryService {
  ingestTurn(input: CreateTurnInput): Promise<IngestTurnResult>;
  flushSessionTopic(scope: Scope, sessionId: string): Promise<{ topic: TopicSegment | null; memories: Memory[] }>;
  listTopicSegments(scope: Partial<Scope> & { sessionId?: string; status?: TopicSegment["status"] }): { topics: TopicSegment[] };
  listProjectMemories(
    scope: Partial<Scope> & { status?: MemoryStatus; projectType?: string; projectKey?: string }
  ): { projects: Memory[] };
  recordProjectBuildRun(input: {
    startedAt: string;
    endedAt: string;
    scopesRun: number;
    createdOrUpdated: number;
    status: ProjectBuildRunStatus;
    errors: Array<{ scope: Scope; error: string }>;
  }): { run: ProjectBuildRun };
  listProjectBuildRuns(limit?: number): { runs: ProjectBuildRun[] };
  runProjectBuild(scope: Scope): Promise<{ createdOrUpdated: Memory[] }>;
  search(input: SearchInput): Promise<{ results: SearchResult[] }>;
  listMemories(scope: Partial<Scope>): { memories: Memory[] };
  updateMemory(id: string, patch: { status?: MemoryStatus; summary?: string; confidence?: number }): { memory: Memory };
  listRelations(memoryId: string): { relations: ReturnType<MemoryStore["listRelations"]> };
  runDreaming(scope: Scope): DreamingResult | Promise<DreamingResult>;
  recall(input: RecallInput): Promise<{ shouldUseMemory: boolean; reason: string; memories: Memory[]; promptSnippets: string[] }>;
  listL1Topics(scope: Partial<Scope> & { sessionId?: string; includeInactive?: boolean }): ReturnType<LayeredMemoryService["listL1Topics"]>;
  runL1Maintenance(scope: Scope, sessionId: string): ReturnType<LayeredMemoryService["runL1Maintenance"]>;
  listL1MaintenanceRuns(limit?: number): ReturnType<MemoryStore["layered"]["listL1MaintenanceRuns"]>;
  listL2Aggregates(uid: string, agent: string, includeInactive?: boolean): ReturnType<MemoryStore["layered"]["listL2AggregateViews"]>;
  runL2Aggregation(uid: string, agent: string, watermark?: number): ReturnType<LayeredMemoryService["runL2Aggregation"]>;
  listL2AggregationRuns(limit?: number): ReturnType<MemoryStore["layered"]["listL2AggregationRuns"]>;
  listL3Profiles(uid: string, agent: string): { profiles: Memory[] };
  runL3ProfileBuild(uid: string, agent: string): ReturnType<LayeredMemoryService["runL3ProfileBuild"]>;
  createCorrection(input: CreateCorrectionInput): { correction: CorrectionRecord };
  getCorrection(uid: string, agent: string, id: string): { correction: CorrectionRecord | null };
  listCorrections(filter: {
    uid: string;
    agent: string;
    status?: CorrectionStatus;
    limit?: number;
  }): { corrections: CorrectionRecord[] };
  listPendingL1CorrectionSessions(): Array<{ scope: Scope; sessionId: string }>;
  listReadyL2CorrectionNamespaces(): Array<{ uid: string; agent: string }>;
  listDueL2Namespaces(): Array<{ uid: string; agent: string }>;
  listDueL3Namespaces(): Array<{ uid: string; agent: string }>;
  recallV2(input: { uid: string; agent: string; query: string; limit?: number; sessionId?: string; includeProvisional?: boolean }): Promise<{
    usagePolicy: "reference_only";
    shouldUseMemory: boolean;
    freshness: GovernanceFreshness;
    reason: string;
    results: LayeredRecallResult[];
  }>;
}

export interface MemoryServiceOptions {
  resolver?: MemoryResolver;
  projectMemoryBuilder?: ProjectMemoryBuilder;
  compressor?: MemoryCompressor;
  topicBuilder?: TopicBuilder;
  embeddingProvider?: EmbeddingProvider;
  embeddingIndex?: EmbeddingIndex;
  recallPlanner?: MemoryRecallPlanner;
  layeredService?: LayeredMemoryService;
  legacyCompatibility?: boolean;
}

export function createRuntimeMemoryService(
  store: MemoryStore,
  options: MemoryServiceOptions = {},
  db?: Database.Database
): MemoryService {
  const embedding =
    options.embeddingProvider || options.embeddingIndex || !db || !isEmbeddingConfigured()
      ? {}
      : {
          embeddingProvider: new OpenAICompatibleEmbeddingProvider(),
          embeddingIndex: new SqliteVectorIndex(db)
        };
  return createMemoryService(store, { ...embedding, ...options });
}

export function createMemoryService(store: MemoryStore, options: MemoryServiceOptions = {}): MemoryService {
  const resolver = options.resolver ?? createDefaultMemoryResolver();
  const projectMemoryBuilder = options.projectMemoryBuilder ?? createDefaultProjectMemoryBuilder(resolver);
  const compressor = options.compressor ?? createDefaultMemoryCompressor(resolver);
  const topicBuilder = options.topicBuilder ?? createDefaultTopicBuilder();
  const embeddingProvider = options.embeddingProvider;
  const embeddingIndex = options.embeddingIndex;
  const recallPlanner = options.recallPlanner ?? createDefaultRecallPlanner();
  const layeredService = options.layeredService ?? (isLlmConfigured() ? createDefaultLayeredService(store) : undefined);
  const legacyCompatibility = options.legacyCompatibility ?? false;

  return {
    async ingestTurn(input) {
      const turn = store.createTurn(input);
      const scope = toScope(input);
      const topic = await topicBuilder.build(store, scope, turn.sessionId);
      if (topic) appendProvisionalTopic(store, layeredService, topic);
      if (!topic || topic.status !== "complete") {
        return { turn, topic, memories: [] };
      }
      if (!legacyCompatibility) {
        return { turn, topic, memories: [] };
      }
      const topicMemory = store.createMemory(topicToDraftFromSegment(topic));
      const memories = [topicMemory];
      if (embeddingProvider && embeddingIndex) {
        await Promise.all(memories.map((memory) => indexMemory(memory, embeddingProvider, embeddingIndex)));
      }
      return { turn, topic, memories };
    },

    async flushSessionTopic(scope, sessionId) {
      const topic = await topicBuilder.flush(store, scope, sessionId);
      if (topic) appendProvisionalTopic(store, layeredService, topic);
      if (!topic || topic.status !== "complete") {
        return { topic, memories: [] };
      }
      if (!legacyCompatibility) {
        return { topic, memories: [] };
      }
      const topicMemory = store.createMemory(topicToDraftFromSegment(topic));
      const memories = [topicMemory];
      if (embeddingProvider && embeddingIndex) {
        await Promise.all(memories.map((memory) => indexMemory(memory, embeddingProvider, embeddingIndex)));
      }
      return { topic, memories };
    },

    listTopicSegments(scope) {
      const { sessionId, status, ...baseScope } = scope;
      const topics = store
        .listTopicSegments(baseScope)
        .filter((topic) => (!sessionId || topic.sessionId === sessionId) && (!status || topic.status === status));
      return { topics };
    },

    listProjectMemories(scope) {
      const { status, projectType, projectKey, ...baseScope } = scope;
      const projects = store
        .listMemories(baseScope)
        .filter((memory) => memory.level === "L2" && memory.type === "project")
        .filter((memory) => !status || memory.status === status)
        .filter((memory) => !projectType || memory.metadata.projectType === projectType)
        .filter((memory) => !projectKey || memory.metadata.projectKey === projectKey);
      return { projects };
    },

    recordProjectBuildRun(input) {
      return { run: store.createProjectBuildRun(input) };
    },

    listProjectBuildRuns(limit) {
      return { runs: store.listProjectBuildRuns(limit) };
    },

    async runProjectBuild(scope) {
      const createdOrUpdated = await projectMemoryBuilder.rebuild(store, scope);
      if (embeddingProvider && embeddingIndex) {
        await Promise.all(createdOrUpdated.map((memory) => indexMemory(memory, embeddingProvider, embeddingIndex)));
      }
      return { createdOrUpdated };
    },

    async search(input) {
      return { results: await runSearch(store, input, embeddingProvider, embeddingIndex) };
    },

    listMemories(scope) {
      return { memories: store.listMemories(scope) };
    },

    updateMemory(id, patch) {
      return { memory: store.updateMemory(id, patch) };
    },

    listRelations(memoryId) {
      return { relations: store.listRelations(memoryId) };
    },

    runDreaming(scope) {
      if (!legacyCompatibility) {
        return requireLayeredService(layeredService).runL3ProfileBuild(scope.uid, scope.agent);
      }
      return compressor.compress(store, scope);
    },

    async recall(input) {
      const candidates = (
        await runSearch(store, { ...input, includeInactive: false }, embeddingProvider, embeddingIndex)
      ).map((result) => result.memory);
      const plan = await recallPlanner.plan({ query: input.query, candidates, scope: toScope(input) });
      const selected = plan.shouldUseMemory
        ? plan.selectedMemoryIds
            .map((id) => candidates.find((memory) => memory.id === id))
            .filter((memory): memory is Memory => Boolean(memory))
        : [];
      return {
        shouldUseMemory: plan.shouldUseMemory && selected.length > 0,
        reason: plan.reason,
        memories: selected,
        promptSnippets: selected.map((memory) => memory.readableText)
      };
    },

    listL1Topics(scope) {
      return store.layered.listL1TopicViews(scope);
    },

    runL1Maintenance(scope, sessionId) {
      return requireLayeredService(layeredService).runL1Maintenance(scope, sessionId);
    },

    listL1MaintenanceRuns(limit) {
      return store.layered.listL1MaintenanceRuns(limit);
    },

    listL2Aggregates(uid, agent, includeInactive) {
      return store.layered.listL2AggregateViews(uid, agent, includeInactive);
    },

    runL2Aggregation(uid, agent, watermark) {
      return requireLayeredService(layeredService).runL2Aggregation(uid, agent, watermark);
    },

    listL2AggregationRuns(limit) {
      return store.layered.listL2AggregationRuns(limit);
    },

    listL3Profiles(uid, agent) {
      return {
        profiles: store
          .listMemories({ uid, agent })
          .filter(
            (memory) =>
              memory.level === "L3" &&
              memory.type === "profile" &&
              memory.status === "active" &&
              memory.metadata.canonicalProfile === true
          )
      };
    },

    runL3ProfileBuild(uid, agent) {
      return requireLayeredService(layeredService).runL3ProfileBuild(uid, agent);
    },

    createCorrection(input) {
      return { correction: store.layered.createCorrection(input) };
    },

    getCorrection(uid, agent, id) {
      return { correction: store.layered.getCorrection(uid, agent, id) };
    },

    listCorrections(filter) {
      return { corrections: store.layered.listCorrections(filter) };
    },

    listPendingL1CorrectionSessions() {
      return store.layered.listPendingL1CorrectionSessions();
    },

    listReadyL2CorrectionNamespaces() {
      return store.layered.listReadyL2CorrectionNamespaces();
    },

    listDueL2Namespaces() {
      return store.layered.listDueL2Namespaces();
    },

    listDueL3Namespaces() {
      return store.layered.listDueL3Namespaces();
    },

    recallV2(input) {
      return requireLayeredService(layeredService).recall(input);
    }
  };
}

function appendProvisionalTopic(store: MemoryStore, service: LayeredMemoryService | undefined, topic: TopicSegment): void {
  if (service) {
    service.appendProvisionalTopic(topic);
    return;
  }
  store.layered.appendProvisionalTopic(topic, {
    promptVersion: "online-topic-v1",
    schemaVersion: "v2",
    reason: topic.reason,
    confidence: topic.confidence
  });
}

function requireLayeredService(service: LayeredMemoryService | undefined): LayeredMemoryService {
  if (!service) throw new Error("LLM configuration is required for layered maintenance and recall");
  return service;
}

async function runSearch(
  store: MemoryStore,
  input: SearchInput,
  embeddingProvider?: EmbeddingProvider,
  embeddingIndex?: EmbeddingIndex
): Promise<SearchResult[]> {
  const lexicalResults = searchMemories(store, input);
  if (!embeddingProvider || !embeddingIndex) {
    return lexicalResults;
  }
  const queryVector = await embeddingProvider.embed(input.query);
  const vectorResults = await embeddingIndex.search(queryVector, {
    limit: input.limit ?? 10,
    filter: {
      uid: input.uid,
      source: input.source,
      agent: input.agent,
      channel: input.channel
    }
  });
  const byId = new Map<string, SearchResult>();
  for (const result of lexicalResults) {
    byId.set(result.memory.id, result);
  }
  for (const vectorResult of vectorResults) {
    const memory = store.getMemory(vectorResult.id);
    if (!memory || (!input.includeInactive && memory.status !== "active")) {
      continue;
    }
    const existing = byId.get(memory.id);
    byId.set(memory.id, {
      memory,
      score: (existing?.score ?? 0) + vectorResult.score
    });
  }
  return Array.from(byId.values())
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 10);
}

async function indexMemory(
  memory: Memory,
  embeddingProvider: EmbeddingProvider,
  embeddingIndex: EmbeddingIndex
): Promise<void> {
  const vector = await embeddingProvider.embed(memory.readableText);
  await embeddingIndex.upsert({
    id: memory.id,
    vector,
    metadata: {
      level: memory.level,
      type: memory.type,
      uid: memory.uid,
      source: memory.source,
      agent: memory.agent,
      channel: memory.channel
    }
  });
}

function isEmbeddingConfigured(): boolean {
  return Boolean(process.env.EMBEDDING_API_KEY || process.env.EMBEDDING_BASE_URL || process.env.EMBEDDING_MODEL);
}

function isLlmConfigured(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

function toScope(input: Scope): Scope {
  return {
    uid: input.uid,
    source: input.source,
    agent: input.agent,
    channel: input.channel,
    metadata: input.metadata
  };
}

function createDefaultMemoryResolver(): MemoryResolver {
  return new LlmMemoryResolver(createDefaultCompletionClient());
}

function createDefaultMemoryCompressor(resolver: MemoryResolver): MemoryCompressor {
  return new LlmMemoryCompressor(createDefaultCompletionClient(), resolver);
}

function createDefaultRecallPlanner(): MemoryRecallPlanner {
  return new LlmMemoryRecallPlanner(createDefaultCompletionClient());
}

function createDefaultProjectMemoryBuilder(resolver: MemoryResolver): ProjectMemoryBuilder {
  return new ModelProjectMemoryBuilder(
    new LlmProjectMemoryExtractor(createDefaultCompletionClient()),
    resolver
  );
}

function createDefaultTopicBuilder(): TopicBuilder {
  const client = createDefaultCompletionClient();
  return new SlidingTopicBuilder(new LlmTopicBoundaryDetector(client), new LlmTopicMemoryGenerator(client), loadTopicWindowConfig());
}

function createDefaultCompletionClient(): OpenAICompatibleCompletionClient {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error("LLM configuration is required: set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL");
  }
  return new OpenAICompatibleCompletionClient({ baseUrl, apiKey, model });
}

function createDefaultLayeredService(store: MemoryStore): LayeredMemoryService {
  const client = createDefaultCompletionClient();
  return new LayeredMemoryService(store, {
    l1Planner: new LlmL1MaintenancePlanner(client),
    l2Planner: new LlmL2MembershipPlanner(client),
    l2Synthesizer: new LlmL2RevisionSynthesizer(client),
    recallPlanner: new LlmLayeredRecallPlanner(client),
    profileExtractor: new LlmCanonicalProfileExtractor(client),
    provenance: {
      provider: "openai-compatible",
      model: process.env.LLM_MODEL,
      promptVersion: "v2",
      schemaVersion: "v2",
      reason: "runtime",
      confidence: 1
    }
  });
}

function topicToDraftFromSegment(topic: TopicSegment): CreateMemoryInput {
  return topicMemoryUnitToDraft(
    {
      title: topic.title,
      summary: topic.summary,
      topicType: toTopicType(topic.metadata.topicType),
      entities: toStringArray(topic.metadata.entities),
      decisions: toStringArray(topic.metadata.decisions),
      tasks: toStringArray(topic.metadata.tasks),
      preferences: toStringArray(topic.metadata.preferences),
      confidence: topic.confidence,
      reason: topic.reason,
      evidenceTurnIds: topic.turnIds
    },
    {
      sessionId: topic.sessionId,
      uid: topic.uid,
      source: topic.source,
      agent: topic.agent,
      channel: topic.channel,
      metadata: topic.metadata
    }
  );
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toTopicType(value: unknown): TopicType {
  const allowed = new Set<TopicType>([
    "project_work",
    "product_design",
    "technical_decision",
    "workflow",
    "preference",
    "personal_context",
    "research",
    "other"
  ]);
  return typeof value === "string" && allowed.has(value as TopicType) ? (value as TopicType) : "other";
}
