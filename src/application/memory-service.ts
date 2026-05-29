import { RuleBasedMemoryCompressor, type DreamingResult, type MemoryCompressor } from "../domain/dreaming.js";
import type { EmbeddingIndex, EmbeddingProvider } from "../domain/embedding.js";
import { OpenAICompatibleCompletionClient } from "../domain/extractors.js";
import {
  LlmProjectMemoryExtractor,
  ModelProjectMemoryBuilder,
  NoopProjectMemoryExtractor,
  type ProjectMemoryBuilder
} from "../domain/project-memory.js";
import { RuleBasedMemoryResolver, type MemoryResolver } from "../domain/resolver.js";
import { searchMemories, type SearchInput, type SearchResult } from "../domain/search.js";
import { SlidingTopicBuilder, topicToMemoryDraft, type TopicBuilder } from "../domain/topics.js";
import type { ConversationTurn, CreateTurnInput, Memory, MemoryStatus, Scope, TopicSegment } from "../domain/types.js";
import type { MemoryStore } from "../storage/store.js";

export interface IngestTurnResult {
  turn: ConversationTurn;
  topic: TopicSegment | null;
  memories: Memory[];
}

export interface MemoryService {
  ingestTurn(input: CreateTurnInput): Promise<IngestTurnResult>;
  runProjectBuild(scope: Scope): Promise<{ createdOrUpdated: Memory[] }>;
  search(input: SearchInput): Promise<{ results: SearchResult[] }>;
  listMemories(scope: Partial<Scope>): { memories: Memory[] };
  updateMemory(id: string, patch: { status?: MemoryStatus; summary?: string; confidence?: number }): { memory: Memory };
  listRelations(memoryId: string): { relations: ReturnType<MemoryStore["listRelations"]> };
  runDreaming(scope: Scope): DreamingResult;
}

export interface MemoryServiceOptions {
  resolver?: MemoryResolver;
  projectMemoryBuilder?: ProjectMemoryBuilder;
  compressor?: MemoryCompressor;
  topicBuilder?: TopicBuilder;
  embeddingProvider?: EmbeddingProvider;
  embeddingIndex?: EmbeddingIndex;
}

export function createMemoryService(store: MemoryStore, options: MemoryServiceOptions = {}): MemoryService {
  const resolver = options.resolver ?? new RuleBasedMemoryResolver();
  const projectMemoryBuilder = options.projectMemoryBuilder ?? createDefaultProjectMemoryBuilder(resolver);
  const compressor = options.compressor ?? new RuleBasedMemoryCompressor();
  const topicBuilder = options.topicBuilder ?? new SlidingTopicBuilder();
  const embeddingProvider = options.embeddingProvider;
  const embeddingIndex = options.embeddingIndex;

  return {
    async ingestTurn(input) {
      const turn = store.createTurn(input);
      const scope = toScope(input);
      const topic = await topicBuilder.build(store, scope, turn.sessionId);
      if (!topic || topic.status !== "complete") {
        return { turn, topic, memories: [] };
      }
      const topicMemory = resolver.resolve(store, topicToMemoryDraft(topic));
      const memories = [topicMemory];
      if (embeddingProvider && embeddingIndex) {
        await Promise.all(memories.map((memory) => indexMemory(memory, embeddingProvider, embeddingIndex)));
      }
      return { turn, topic, memories };
    },

    async runProjectBuild(scope) {
      const createdOrUpdated = await projectMemoryBuilder.rebuild(store, scope);
      if (embeddingProvider && embeddingIndex) {
        await Promise.all(createdOrUpdated.map((memory) => indexMemory(memory, embeddingProvider, embeddingIndex)));
      }
      return { createdOrUpdated };
    },

    async search(input) {
      const lexicalResults = searchMemories(store, input);
      if (!embeddingProvider || !embeddingIndex) {
        return { results: lexicalResults };
      }
      const queryVector = await embeddingProvider.embed(input.query);
      const vectorResults = await embeddingIndex.search(queryVector, {
        limit: input.limit ?? 10,
        filter: {
          mis: input.mis,
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
      return {
        results: Array.from(byId.values())
          .filter((result) => result.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, input.limit ?? 10)
      };
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
      return compressor.compress(store, scope);
    }
  };
}

async function indexMemory(
  memory: Memory,
  embeddingProvider: EmbeddingProvider,
  embeddingIndex: EmbeddingIndex
): Promise<void> {
  const vector = await embeddingProvider.embed([memory.subject, memory.predicate, memory.object, memory.summary].join(" "));
  await embeddingIndex.upsert({
    id: memory.id,
    vector,
    metadata: {
      level: memory.level,
      type: memory.type,
      mis: memory.mis,
      source: memory.source,
      agent: memory.agent,
      channel: memory.channel
    }
  });
}

function toScope(input: CreateTurnInput): Scope {
  return {
    mis: input.mis,
    source: input.source,
    agent: input.agent,
    channel: input.channel,
    metadata: input.metadata
  };
}

function createDefaultProjectMemoryBuilder(resolver: MemoryResolver): ProjectMemoryBuilder {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    return new ModelProjectMemoryBuilder(new NoopProjectMemoryExtractor(), resolver);
  }
  return new ModelProjectMemoryBuilder(
    new LlmProjectMemoryExtractor(new OpenAICompatibleCompletionClient({ baseUrl, apiKey, model })),
    resolver
  );
}
