import type { Memory, Scope } from "./types.js";
import type { MemoryStore } from "../storage/store.js";

export interface DreamingResult {
  createdOrUpdated: Memory[];
}

export function runDreaming(repo: MemoryStore, scope: Scope): DreamingResult {
  return new RuleBasedMemoryCompressor().compress(repo, scope);
}

export interface MemoryCompressor {
  compress(repo: MemoryStore, scope: Scope): DreamingResult;
}

export class RuleBasedMemoryCompressor implements MemoryCompressor {
  compress(repo: MemoryStore, scope: Scope): DreamingResult {
  const candidates = repo
    .listMemories(scope)
    .filter((memory) => memory.status === "active" && (memory.level === "L1" || memory.level === "L2"));
  const groups = new Map<string, Memory[]>();

  for (const memory of candidates) {
    const key = [memory.type, memory.subject, memory.predicate, memory.object].join("\u001f");
    groups.set(key, [...(groups.get(key) ?? []), memory]);
  }

  const createdOrUpdated: Memory[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first || (group.length < 2 && first.type !== "preference")) {
      continue;
    }
    const existing = repo
      .listMemories(scope)
      .find(
        (memory) =>
          memory.level === "L3" &&
          memory.subject === first.subject &&
          memory.predicate === first.predicate &&
          memory.object === first.object
      );
    const input = {
      level: "L3" as const,
      type: "profile" as const,
      subject: first.subject,
      predicate: first.predicate,
      object: first.object,
      summary: first.summary,
      confidence: Math.min(1, Math.max(...group.map((memory) => memory.confidence)) + 0.1),
      status: "active" as const,
      supersedesId: null,
      sourceTurnIds: Array.from(new Set(group.flatMap((memory) => memory.sourceTurnIds))),
      ...scope
    };

    const l3 = existing ? repo.updateMemory(existing.id, input) : repo.createMemory(input);
    createdOrUpdated.push(l3);

    for (const duplicate of group.slice(1)) {
      repo.updateMemory(duplicate.id, { status: "superseded" });
      repo.createRelation(duplicate.id, l3.id, "duplicate", 0.8);
    }
  }

  return { createdOrUpdated };
  }
}
