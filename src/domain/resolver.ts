import type { MemoryDraft } from "./extractor.js";
import type { Memory } from "./types.js";
import { jaccard } from "./text.js";
import { sameScope } from "../storage/repositories.js";
import type { MemoryStore } from "../storage/store.js";

export function resolveMemory(repo: MemoryStore, draft: MemoryDraft): Memory {
  return new RuleBasedMemoryResolver().resolve(repo, draft);
}

export interface MemoryResolver {
  resolve(repo: MemoryStore, draft: MemoryDraft): Memory;
}

export class RuleBasedMemoryResolver implements MemoryResolver {
  resolve(repo: MemoryStore, draft: MemoryDraft): Memory {
  const candidates = repo
    .listMemories(draft)
    .filter((memory) => memory.status === "active" && memory.level === draft.level && sameScope(memory, draft));

  const exact = candidates.find(
    (memory) =>
      memory.subject === draft.subject &&
      memory.predicate === draft.predicate &&
      memory.object === draft.object &&
      memory.type === draft.type
  );
  if (exact) {
    const sourceTurnIds = Array.from(new Set([...exact.sourceTurnIds, ...draft.sourceTurnIds]));
    const merged = repo.updateMemory(exact.id, {
      sourceTurnIds,
      confidence: Math.max(exact.confidence, draft.confidence)
    });
    repo.createRelation(exact.id, exact.id, "duplicate", 0.95);
    return merged;
  }

  const updated = candidates.find(
    (memory) =>
      memory.subject === draft.subject &&
      memory.predicate === draft.predicate &&
      memory.object !== draft.object &&
      memory.type === draft.type
  );
  if (updated) {
    repo.updateMemory(updated.id, { status: "superseded" });
    const created = repo.createMemory({ ...draft, supersedesId: updated.id, status: "active" });
    repo.createRelation(updated.id, created.id, "update", 0.9);
    return created;
  }

  const related = candidates.find((memory) => jaccard(memory.summary, draft.summary) >= 0.2);
  const created = repo.createMemory(draft);
  if (related) {
    repo.createRelation(related.id, created.id, related.subject === created.subject ? "support" : "related", 0.6);
  }
  return created;
  }
}
