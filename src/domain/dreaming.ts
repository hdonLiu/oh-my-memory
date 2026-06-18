import { z } from "zod";
import type { LlmCompletionClient } from "./extractors.js";
import type { MemoryResolver } from "./resolver.js";
import type { CreateMemoryInput, Memory, MemoryType, Scope } from "./types.js";
import type { MemoryStore } from "../storage/store.js";

export interface DreamingResult {
  createdOrUpdated: Memory[];
}

export function runDreaming(repo: MemoryStore, scope: Scope): DreamingResult {
  return new RuleBasedMemoryCompressor().compress(repo, scope);
}

export interface MemoryCompressor {
  compress(repo: MemoryStore, scope: Scope): DreamingResult | Promise<DreamingResult>;
}

class DirectMemoryResolver implements MemoryResolver {
  resolve(repo: MemoryStore, draft: CreateMemoryInput): Memory {
    return repo.createMemory(draft);
  }
}

export class RuleBasedMemoryCompressor implements MemoryCompressor {
  compress(repo: MemoryStore, scope: Scope): DreamingResult {
  const candidates = repo
    .listMemories(scope)
    .filter((memory) => memory.status === "active" && memory.level === "L2");
  const groups = new Map<string, Memory[]>();

  for (const memory of candidates) {
    const key = [memory.type, memory.subject, memory.predicate, memory.object].join("\u001f");
    groups.set(key, [...(groups.get(key) ?? []), memory]);
  }

  const createdOrUpdated: Memory[] = promotePreferenceTopics(repo, scope);
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

const llmDreamMemorySchema = z.object({
  type: z.enum(["fact", "preference", "decision", "profile"]),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidenceMemoryIds: z.array(z.string()).min(1)
});

const llmDreamResponseSchema = z.object({
  memories: z.array(llmDreamMemorySchema)
});

export class LlmMemoryCompressor implements MemoryCompressor {
  constructor(
    private readonly client: LlmCompletionClient,
    private readonly resolver: MemoryResolver = new DirectMemoryResolver()
  ) {}

  async compress(repo: MemoryStore, scope: Scope): Promise<DreamingResult> {
    const candidates = repo
      .listMemories(scope)
      .filter((memory) => memory.status === "active" && (memory.level === "L2" || memory.level === "topic"));
    const raw = await this.client.complete(buildDreamingPrompt(candidates));
    const parsed = parseDreamingResponse(raw);
    const createdOrUpdated: Memory[] = [];
    for (const memory of parsed.memories) {
      assertKnownEvidenceIds(memory.evidenceMemoryIds, candidates.map((candidate) => candidate.id));
      const evidence = candidates.filter((candidate) => memory.evidenceMemoryIds.includes(candidate.id));
      const draft: CreateMemoryInput = {
        level: "L3",
        type: memory.type as MemoryType,
        subject: memory.subject,
        predicate: memory.predicate,
        object: memory.object,
        summary: memory.summary,
        confidence: memory.confidence,
        status: "active",
        supersedesId: null,
        sourceTurnIds: Array.from(new Set(evidence.flatMap((item) => item.sourceTurnIds))),
        mis: scope.mis,
        source: scope.source,
        agent: scope.agent,
        channel: scope.channel,
        metadata: {
          ...scope.metadata,
          evidenceMemoryIds: memory.evidenceMemoryIds
        }
      };
      createdOrUpdated.push(await this.resolver.resolve(repo, draft));
    }
    return { createdOrUpdated };
  }
}

function assertKnownEvidenceIds(evidenceMemoryIds: string[], knownIds: string[]): void {
  const known = new Set(knownIds);
  const unknown = evidenceMemoryIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`LLM dreaming returned unknown evidenceMemoryIds: ${unknown.join(", ")}`);
  }
}

export class HybridMemoryCompressor implements MemoryCompressor {
  constructor(
    private readonly primary: MemoryCompressor,
    private readonly fallback: MemoryCompressor = new RuleBasedMemoryCompressor()
  ) {}

  async compress(repo: MemoryStore, scope: Scope): Promise<DreamingResult> {
    try {
      return await this.primary.compress(repo, scope);
    } catch {
      return this.fallback.compress(repo, scope);
    }
  }
}

function parseDreamingResponse(raw: string): z.infer<typeof llmDreamResponseSchema> {
  try {
    return llmDreamResponseSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`Invalid LLM dreaming response: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

function buildDreamingPrompt(candidates: Memory[]): string {
  return JSON.stringify({
    task: "Extract stable L3 global/profile memories from active topic and L2 memories. Return strict JSON only.",
    rules: [
      "Only output stable long-term memories.",
      "Use evidenceMemoryIds from the provided candidates.",
      "Do not output temporary task chatter."
    ],
    candidates: candidates.map((memory) => ({
      id: memory.id,
      level: memory.level,
      type: memory.type,
      subject: memory.subject,
      predicate: memory.predicate,
      object: memory.object,
      summary: memory.summary,
      confidence: memory.confidence,
      metadata: memory.metadata
    })),
    responseSchema: {
      memories: [
        {
          type: "fact|preference|decision|profile",
          subject: "string",
          predicate: "string",
          object: "string",
          summary: "string",
          confidence: "0..1",
          evidenceMemoryIds: "string[]"
        }
      ]
    }
  });
}

function promotePreferenceTopics(repo: MemoryStore, scope: Scope): Memory[] {
  const groups = new Map<string, Memory[]>();
  for (const topic of repo
    .listMemories(scope)
    .filter((memory) => memory.level === "topic" && memory.type === "topic" && memory.status === "active")) {
    const preference = inferPreference(topic.summary);
    if (!preference) {
      continue;
    }
    groups.set(preference, [...(groups.get(preference) ?? []), topic]);
  }

  const results: Memory[] = [];
  for (const [preference, topics] of groups) {
    const existing = repo
      .listMemories(scope)
      .find(
        (memory) =>
          memory.level === "L3" &&
          memory.type === "profile" &&
          memory.subject === "用户" &&
          memory.predicate === "偏好" &&
          memory.object === preference
      );
    const input = {
      level: "L3" as const,
      type: "profile" as const,
      subject: "用户",
      predicate: "偏好",
      object: preference,
      summary: `用户偏好 ${preference}`,
      confidence: Math.min(1, Math.max(...topics.map((topic) => topic.confidence)) + 0.1),
      status: "active" as const,
      supersedesId: null,
      sourceTurnIds: Array.from(new Set(topics.flatMap((topic) => topic.sourceTurnIds))),
      ...scope
    };
    results.push(existing ? repo.updateMemory(existing.id, input) : repo.createMemory(input));
  }
  return results;
}

function inferPreference(text: string): string | null {
  const match = text.match(/(?:用户|我)?(?:喜欢|偏好)\s*(.+)$/u);
  return match?.[1]?.trim() || null;
}
