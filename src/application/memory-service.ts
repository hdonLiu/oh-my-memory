import { runDreaming, type DreamingResult } from "../domain/dreaming.js";
import { extractMemories } from "../domain/extractor.js";
import { rebuildProjectMemories } from "../domain/project-memory.js";
import { resolveMemory } from "../domain/resolver.js";
import { searchMemories, type SearchInput, type SearchResult } from "../domain/search.js";
import type { ConversationTurn, CreateTurnInput, Memory, MemoryStatus, Scope } from "../domain/types.js";
import type { MemoryStore } from "../storage/store.js";

export interface IngestTurnResult {
  turn: ConversationTurn;
  memories: Memory[];
}

export interface MemoryService {
  ingestTurn(input: CreateTurnInput): IngestTurnResult;
  search(input: SearchInput): { results: SearchResult[] };
  listMemories(scope: Partial<Scope>): { memories: Memory[] };
  updateMemory(id: string, patch: { status?: MemoryStatus; summary?: string; confidence?: number }): { memory: Memory };
  listRelations(memoryId: string): { relations: ReturnType<MemoryStore["listRelations"]> };
  runDreaming(scope: Scope): DreamingResult;
}

export function createMemoryService(store: MemoryStore): MemoryService {
  return {
    ingestTurn(input) {
      const turn = store.createTurn(input);
      const scope = toScope(input);
      const window = store.recentTurns(scope, 8);
      const memories = extractMemories(turn, window).map((draft) => resolveMemory(store, draft));
      if (memories.length > 0) {
        rebuildProjectMemories(store, scope);
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
      return runDreaming(store, scope);
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
