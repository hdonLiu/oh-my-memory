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
