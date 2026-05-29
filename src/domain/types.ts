export type MemoryLevel = "topic" | "L2" | "L3";
export type MemoryType = "topic" | "fact" | "preference" | "decision" | "profile" | "project";
export type MemoryStatus = "active" | "superseded" | "deleted";
export type RelationType = "duplicate" | "update" | "contradict" | "support" | "related";
export type Role = "user" | "assistant" | "system";
export type TopicStatus = "complete" | "partial" | "noise";

export interface Scope {
  mis: string;
  source: string;
  agent: string;
  channel: string;
  metadata: Record<string, unknown>;
}

export interface ConversationTurn extends Scope {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface Memory extends Scope {
  id: string;
  level: MemoryLevel;
  type: MemoryType;
  subject: string;
  predicate: string;
  object: string;
  summary: string;
  confidence: number;
  status: MemoryStatus;
  supersedesId: string | null;
  sourceTurnIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRelation {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: RelationType;
  confidence: number;
  createdAt: string;
}

export interface TopicSegment extends Scope {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  status: TopicStatus;
  confidence: number;
  turnIds: string[];
  reason: string;
  fingerprint: string;
  projectMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type CreateTurnInput = Omit<ConversationTurn, "id" | "createdAt">;
export type CreateMemoryInput = Omit<Memory, "id" | "createdAt" | "updatedAt">;
export type CreateTopicSegmentInput = Omit<TopicSegment, "id" | "createdAt" | "updatedAt">;
