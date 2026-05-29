import type { ConversationTurn, CreateMemoryInput } from "./types.js";
import { isNoise } from "./text.js";

export type MemoryDraft = CreateMemoryInput;

export function extractMemories(turn: ConversationTurn, _window: ConversationTurn[]): MemoryDraft[] {
  const content = turn.content.trim();
  if (isNoise(content)) {
    return [];
  }

  const scope = {
    mis: turn.mis,
    source: turn.source,
    agent: turn.agent,
    channel: turn.channel,
    metadata: turn.metadata
  };

  const migration = content.match(/^(项目\s*\S+)\s*已迁移到\s*(\S+)/u);
  if (migration) {
    return [
      {
        level: "L2",
        type: "fact",
        subject: normalizeSubject(migration[1]),
        predicate: "使用",
        object: migration[2],
        summary: `${normalizeSubject(migration[1])} 使用 ${migration[2]}`,
        confidence: 0.9,
        status: "active",
        supersedesId: null,
        sourceTurnIds: [turn.id],
        ...scope
      }
    ];
  }

  const projectUsage = content.match(/^(项目\s*\S+)\s*(?:使用|用的是|用)\s*(\S+)/u);
  if (projectUsage) {
    return [
      {
        level: "L2",
        type: "fact",
        subject: normalizeSubject(projectUsage[1]),
        predicate: "使用",
        object: projectUsage[2],
        summary: `${normalizeSubject(projectUsage[1])} 使用 ${projectUsage[2]}`,
        confidence: 0.85,
        status: "active",
        supersedesId: null,
        sourceTurnIds: [turn.id],
        ...scope
      }
    ];
  }

  const preference = content.match(/^我(?:喜欢|偏好)\s*(.+)$/u);
  if (preference) {
    return [
      {
        level: "L2",
        type: "preference",
        subject: "用户",
        predicate: "偏好",
        object: preference[1],
        summary: `用户偏好 ${preference[1]}`,
        confidence: 0.8,
        status: "active",
        supersedesId: null,
        sourceTurnIds: [turn.id],
        ...scope
      }
    ];
  }

  const decision = content.match(/^(?:决定|决策)\s*(.+)$/u);
  if (decision) {
    return [
      {
        level: "L2",
        type: "decision",
        subject: "用户",
        predicate: "决定",
        object: decision[1],
        summary: `用户决定 ${decision[1]}`,
        confidence: 0.75,
        status: "active",
        supersedesId: null,
        sourceTurnIds: [turn.id],
        ...scope
      }
    ];
  }

  return [];
}

function normalizeSubject(subject: string): string {
  return subject.replace(/\s+/g, " ").trim();
}
