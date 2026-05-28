import type { Memory, Scope } from "./types.js";
import type { MemoryStore } from "../storage/store.js";

export function rebuildProjectMemories(repo: MemoryStore, scope: Scope): Memory[] {
  const activeL1 = repo
    .listMemories(scope)
    .filter((memory) => memory.level === "L1" && memory.status === "active" && memory.subject.startsWith("项目"));
  const groups = new Map<string, Memory[]>();
  for (const memory of activeL1) {
    groups.set(memory.subject, [...(groups.get(memory.subject) ?? []), memory]);
  }

  const results: Memory[] = [];
  for (const [subject, memories] of groups) {
    const summary = `${subject}：${memories.map((memory) => `${memory.predicate} ${memory.object}`).join("，")}`;
    const existing = repo
      .listMemories(scope)
      .find((memory) => memory.level === "L2" && memory.type === "project" && memory.subject === subject);
    if (existing) {
      results.push(
        repo.updateMemory(existing.id, {
          summary,
          object: summary,
          sourceTurnIds: Array.from(new Set(memories.flatMap((memory) => memory.sourceTurnIds))),
          status: "active"
        })
      );
    } else {
      results.push(
        repo.createMemory({
          level: "L2",
          type: "project",
          subject,
          predicate: "聚合",
          object: summary,
          summary,
          confidence: average(memories.map((memory) => memory.confidence)),
          status: "active",
          supersedesId: null,
          sourceTurnIds: Array.from(new Set(memories.flatMap((memory) => memory.sourceTurnIds))),
          ...scope
        })
      );
    }
  }
  return results;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
