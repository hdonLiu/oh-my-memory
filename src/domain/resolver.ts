import { z } from "zod";
import type { LlmCompletionClient, MemoryDraft } from "./extractors.js";
import type { Memory } from "./types.js";
import { jaccard } from "./text.js";
import { sameScope } from "../storage/repositories.js";
import type { MemoryStore } from "../storage/store.js";

export function resolveMemory(repo: MemoryStore, draft: MemoryDraft): Memory {
  return new RuleBasedMemoryResolver().resolve(repo, draft);
}

export type MemoryResolveResult = Memory | Promise<Memory>;

export interface MemoryResolver {
  resolve(repo: MemoryStore, draft: MemoryDraft): MemoryResolveResult;
}

export class RuleBasedMemoryResolver implements MemoryResolver {
  resolve(repo: MemoryStore, draft: MemoryDraft): Memory {
  const candidates = findCandidates(repo, draft);

  const exact = candidates.find(
    (memory) =>
      sameMemoryIdentity(memory, draft) &&
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
      sameMemoryIdentity(memory, draft) &&
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

const llmResolutionSchema = z.object({
  operation: z.enum(["add", "update", "delete", "none"]),
  targetMemoryId: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional()
});

export class LlmMemoryResolver implements MemoryResolver {
  constructor(private readonly client: LlmCompletionClient) {}

  async resolve(repo: MemoryStore, draft: MemoryDraft): Promise<Memory> {
    const candidates = findCandidates(repo, draft);
    const raw = await this.client.complete(buildResolutionPrompt(draft, candidates));
    const decision = parseResolutionDecision(raw);
    return applyResolutionDecision(repo, draft, candidates, decision);
  }
}

export class HybridMemoryResolver implements MemoryResolver {
  constructor(
    private readonly primary: MemoryResolver,
    private readonly fallback: MemoryResolver = new RuleBasedMemoryResolver()
  ) {}

  async resolve(repo: MemoryStore, draft: MemoryDraft): Promise<Memory> {
    try {
      return await this.primary.resolve(repo, draft);
    } catch {
      return this.fallback.resolve(repo, draft);
    }
  }
}

type ResolutionDecision = z.infer<typeof llmResolutionSchema>;

function findCandidates(repo: MemoryStore, draft: MemoryDraft): Memory[] {
  return repo
    .listMemories(draft)
    .filter(
      (memory) =>
        memory.status === "active" &&
        memory.level === draft.level &&
        sameScope(memory, draft) &&
        sameMemorySession(memory, draft)
    );
}

function parseResolutionDecision(raw: string): ResolutionDecision {
  try {
    return llmResolutionSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`Invalid LLM memory resolution response: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

function applyResolutionDecision(
  repo: MemoryStore,
  draft: MemoryDraft,
  candidates: Memory[],
  decision: ResolutionDecision
): Memory {
  const target = decision.targetMemoryId
    ? candidates.find((memory) => memory.id === decision.targetMemoryId)
    : undefined;

  if (decision.operation === "add") {
    return repo.createMemory(draft);
  }

  if (!target) {
    throw new Error(`LLM memory resolution selected ${decision.operation} without a valid targetMemoryId`);
  }

  if (decision.operation === "none") {
    const sourceTurnIds = Array.from(new Set([...target.sourceTurnIds, ...draft.sourceTurnIds]));
    const merged = repo.updateMemory(target.id, {
      sourceTurnIds,
      confidence: Math.max(target.confidence, draft.confidence)
    });
    repo.createRelation(target.id, target.id, "duplicate", decision.confidence ?? 0.95);
    return merged;
  }

  if (decision.operation === "update") {
    repo.updateMemory(target.id, { status: "superseded" });
    const created = repo.createMemory({ ...draft, supersedesId: target.id, status: "active" });
    repo.createRelation(target.id, created.id, "update", decision.confidence ?? 0.9);
    return created;
  }

  repo.updateMemory(target.id, { status: "deleted" });
  repo.createRelation(target.id, target.id, "contradict", decision.confidence ?? 0.8);
  return repo.getMemory(target.id) ?? target;
}

function buildResolutionPrompt(draft: MemoryDraft, candidates: Memory[]): string {
  return JSON.stringify({
    task: "Decide how to resolve a new memory draft against existing memories. Return JSON only.",
    operations: {
      add: "New memory is valuable and does not replace an existing memory.",
      update: "New memory changes an existing memory; keep the new draft and supersede the target.",
      delete: "New draft proves an existing memory should be deleted.",
      none: "Existing memory already captures the draft; merge evidence into the target."
    },
    rules: [
      "Prefer none for duplicates or paraphrases.",
      "Prefer update when the same subject and predicate now have a different object.",
      "Prefer add when the draft is related but independent.",
      "Use targetMemoryId only from candidates."
    ],
    draft,
    candidates: candidates.map((memory) => ({
      id: memory.id,
      level: memory.level,
      type: memory.type,
      subject: memory.subject,
      predicate: memory.predicate,
      object: memory.object,
      summary: memory.summary,
      confidence: memory.confidence,
      sourceTurnIds: memory.sourceTurnIds
    })),
    responseSchema: {
      operation: "add|update|delete|none",
      targetMemoryId: "required for update/delete/none",
      confidence: "0..1 optional",
      reason: "string optional"
    }
  });
}

function sameMemorySession(memory: Memory, draft: MemoryDraft): boolean {
  if (draft.type !== "topic") {
    return true;
  }
  return memory.metadata.sessionId === draft.metadata.sessionId;
}

function sameMemoryIdentity(memory: Memory, draft: MemoryDraft): boolean {
  if (memory.level === "L2" && memory.type === "project" && draft.level === "L2" && draft.type === "project") {
    const memoryProjectKey = memory.metadata.projectKey;
    const draftProjectKey = draft.metadata.projectKey;
    if (typeof memoryProjectKey === "string" && typeof draftProjectKey === "string") {
      return memoryProjectKey === draftProjectKey;
    }
  }
  return memory.subject === draft.subject && memory.predicate === draft.predicate;
}
