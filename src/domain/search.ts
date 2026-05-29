import type { Memory, Scope } from "./types.js";
import { jaccard } from "./text.js";
import type { MemoryStore } from "../storage/store.js";

export interface SearchInput extends Scope {
  query: string;
  includeInactive?: boolean;
  limit?: number;
}

export interface SearchResult {
  memory: Memory;
  score: number;
}

const LEVEL_WEIGHT: Record<Memory["level"], number> = {
  L3: 0.35,
  L2: 0.25,
  topic: 0.2
};

export function searchMemories(repo: MemoryStore, input: SearchInput): SearchResult[] {
  const limit = input.limit ?? 10;
  return repo
    .listMemories(input)
    .filter((memory) => input.includeInactive || memory.status === "active")
    .map((memory) => ({ memory, score: scoreMemory(memory, input) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function scoreMemory(memory: Memory, input: SearchInput): number {
  if (memory.status === "deleted") {
    return -Infinity;
  }
  const haystack = [memory.subject, memory.predicate, memory.object, memory.summary].join(" ");
  const keywordScore = keywordOverlap(input.query, haystack);
  const semanticScore = jaccard(input.query, haystack);
  const levelWeight = LEVEL_WEIGHT[memory.level];
  const recencyScore = recency(memory.updatedAt);
  const scopeMatch = 1;
  const stalePenalty = memory.status === "active" ? 0 : 2;

  return keywordScore + semanticScore + levelWeight + recencyScore + memory.confidence + scopeMatch - stalePenalty;
}

function keywordOverlap(query: string, text: string): number {
  const compactQuery = query.replace(/\s+/g, "");
  const compactText = text.replace(/\s+/g, "");
  if (compactText.includes(compactQuery)) {
    return 1;
  }
  let score = 0;
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (compactText.includes(token)) {
      score += 0.25;
    }
  }
  return score;
}

function recency(updatedAt: string): number {
  const ageMs = Math.max(0, Date.now() - Date.parse(updatedAt));
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, 0.2 - ageMs / dayMs / 100);
}
