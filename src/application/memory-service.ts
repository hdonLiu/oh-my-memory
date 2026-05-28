import { RuleBasedMemoryCompressor, type DreamingResult, type MemoryCompressor } from "../domain/dreaming.js";
import { RuleBasedMemoryExtractor, type MemoryExtractor } from "../domain/extractors.js";
import { RuleBasedProjectMemoryBuilder, type ProjectMemoryBuilder } from "../domain/project-memory.js";
import { RuleBasedMemoryResolver, type MemoryResolver } from "../domain/resolver.js";
import { searchMemories, type SearchInput, type SearchResult } from "../domain/search.js";
import type { ConversationTurn, CreateTurnInput, Memory, MemoryStatus, Scope } from "../domain/types.js";
import type { MemoryStore } from "../storage/store.js";

export interface IngestTurnResult {
  turn: ConversationTurn;
  memories: Memory[];
}

export interface MemoryService {
  ingestTurn(input: CreateTurnInput): Promise<IngestTurnResult>;
  search(input: SearchInput): { results: SearchResult[] };
  listMemories(scope: Partial<Scope>): { memories: Memory[] };
  updateMemory(id: string, patch: { status?: MemoryStatus; summary?: string; confidence?: number }): { memory: Memory };
  listRelations(memoryId: string): { relations: ReturnType<MemoryStore["listRelations"]> };
  runDreaming(scope: Scope): DreamingResult;
}

export interface MemoryServiceOptions {
  extractor?: MemoryExtractor;
  resolver?: MemoryResolver;
  projectMemoryBuilder?: ProjectMemoryBuilder;
  compressor?: MemoryCompressor;
}

export function createMemoryService(store: MemoryStore, options: MemoryServiceOptions = {}): MemoryService {
  const extractor = options.extractor ?? new RuleBasedMemoryExtractor();
  const resolver = options.resolver ?? new RuleBasedMemoryResolver();
  const projectMemoryBuilder = options.projectMemoryBuilder ?? new RuleBasedProjectMemoryBuilder();
  const compressor = options.compressor ?? new RuleBasedMemoryCompressor();

  return {
    async ingestTurn(input) {
      const turn = store.createTurn(input);
      const scope = toScope(input);
      const window = store.recentTurns(scope, 8);
      const drafts = await extractor.extract(turn, window);
      const memories = drafts.map((draft) => resolver.resolve(store, draft));
      if (memories.length > 0) {
        projectMemoryBuilder.rebuild(store, scope);
      }
      return { turn, memories };
    },

    search(input) {
      return { results: searchMemories(store, input) };
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

function toScope(input: CreateTurnInput): Scope {
  return {
    mis: input.mis,
    source: input.source,
    agent: input.agent,
    channel: input.channel,
    metadata: input.metadata
  };
}
