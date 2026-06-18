export type MemoryLevel = "topic" | "L2" | "L3";
export type TopicType =
  | "project_work"
  | "product_design"
  | "technical_decision"
  | "workflow"
  | "preference"
  | "personal_context"
  | "research"
  | "other";
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
  readableText: string;
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

export type ProjectBuildRunStatus = "success" | "partial_failure" | "failed";

export interface ProjectBuildRun {
  id: string;
  startedAt: string;
  endedAt: string;
  scopesRun: number;
  createdOrUpdated: number;
  status: ProjectBuildRunStatus;
  errors: Array<{ scope: Scope; error: string }>;
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
export type CreateMemoryInput = Omit<Memory, "id" | "createdAt" | "updatedAt" | "readableText"> & {
  readableText?: string;
};
export type CreateTopicSegmentInput = Omit<TopicSegment, "id" | "createdAt" | "updatedAt">;
export type CreateProjectBuildRunInput = Omit<ProjectBuildRun, "id">;
