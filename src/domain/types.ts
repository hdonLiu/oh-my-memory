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
  uid: string;
  source: string;
  agent: string;
  channel: string;
  metadata: Record<string, unknown>;
}

export interface ConversationTurn extends Scope {
  id: string;
  eventId?: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export type RevisionStatus = "provisional" | "canonical" | "superseded" | "deleted";
export type EntityStatus = "active" | "superseded" | "merged" | "deleted";
export type OfflineRunStatus = "running" | "success" | "failed";

export interface GenerationProvenance {
  provider?: string;
  model?: string;
  promptVersion: string;
  schemaVersion: string;
  reason: string;
  confidence: number;
}

export interface L1Topic extends Scope {
  id: string;
  sessionId: string;
  status: EntityStatus;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface L1TopicRevision extends GenerationProvenance {
  id: string;
  topicId: string;
  version: number;
  status: RevisionStatus;
  title: string;
  summary: string;
  sourceTurnIds: string[];
  sourceSegmentId: string | null;
  stableSequence: number | null;
  createdAt: string;
}

export interface L1Component extends GenerationProvenance {
  id: string;
  topicRevisionId: string;
  content: string;
  labels: string[];
  evidenceTurnIds: string[];
  createdAt: string;
}

export type L1MaintenanceOperation = "keep" | "revise" | "merge" | "split" | "delete" | "noop";

export interface L1MaintenancePlanItem {
  operation: L1MaintenanceOperation;
  sourceTopicIds: string[];
  targetTopicId?: string;
  title?: string;
  summary?: string;
  sourceTurnIds?: string[];
  components?: Array<{
    content: string;
    labels?: string[];
    evidenceTurnIds: string[];
    confidence?: number;
  }>;
  reason: string;
  confidence: number;
}

export interface L1MaintenancePlan {
  items: L1MaintenancePlanItem[];
}

export interface L1MaintenanceRun {
  id: string;
  uid: string;
  source: string;
  agent: string;
  channel: string;
  sessionId: string;
  inputCutoff: string;
  outputWatermark: number | null;
  status: OfflineRunStatus;
  plan: L1MaintenancePlan | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface L2Aggregate {
  id: string;
  uid: string;
  agent: string;
  status: EntityStatus;
  currentRevisionId: string;
  mergedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface L2Statement {
  content: string;
  evidenceComponentIds: string[];
  confidence: number;
  qualifier?: string;
}

export interface L2AggregateContent {
  aggregateType: string;
  canonicalTitle: string;
  aliases: string[];
  externalKeys: Record<string, string>;
  labels: string[];
  summary: string;
  facts: L2Statement[];
  decisions: L2Statement[];
  constraints: L2Statement[];
  openQuestions: L2Statement[];
}

export interface L2AggregateRevision extends GenerationProvenance, L2AggregateContent {
  id: string;
  aggregateId: string;
  version: number;
  sourceL1Watermark: number;
  createdAt: string;
}

export type L2MembershipOperation =
  | "attach"
  | "create"
  | "reassign"
  | "merge"
  | "split"
  | "remove"
  | "ignore"
  | "unchanged";

export interface L2MembershipPlanOperation {
  operation: L2MembershipOperation;
  targetAggregateId?: string;
  sourceAggregateIds?: string[];
  componentIds: string[];
  reason: string;
  confidence: number;
}

export interface L2DesiredMembership {
  aggregateId?: string;
  sourceAggregateIds?: string[];
  componentIds: string[];
}

export interface L2MembershipPlan {
  operations: L2MembershipPlanOperation[];
  desiredMemberships: L2DesiredMembership[];
  retireAggregateIds: string[];
}

export interface L2AggregationRun {
  id: string;
  uid: string;
  agent: string;
  sourceL1Watermark: number;
  status: OfflineRunStatus;
  plan: L2MembershipPlan | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
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

export type CreateTurnInput = Omit<ConversationTurn, "id" | "eventId" | "createdAt"> & { eventId?: string };
export type CreateMemoryInput = Omit<Memory, "id" | "createdAt" | "updatedAt" | "readableText"> & {
  readableText?: string;
};
export type CreateTopicSegmentInput = Omit<TopicSegment, "id" | "createdAt" | "updatedAt">;
export type CreateProjectBuildRunInput = Omit<ProjectBuildRun, "id">;
