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
export type EvidenceAuthority = "conversation" | "human_correction";
export type CorrectionTargetType = "turn" | "l1_component" | "l2_statement";
export type CorrectionAction = "retract" | "replace";
export type CorrectionStatus = "pending_l1" | "ready_l2" | "applied";
export type NamespaceChangeKind =
  | "l1_revision"
  | "l1_delete"
  | "correction_created"
  | "correction_ready"
  | "correction_applied";
export type StatementStatus = "supported" | "contested";

export type StatementEvidenceRef =
  | { kind: "component"; id: string }
  | { kind: "correction"; id: string };

export interface ConflictAssessment {
  summary: string;
  supportingEvidenceRefs: StatementEvidenceRef[];
  conflictingEvidenceRefs: StatementEvidenceRef[];
  alternatives: string[];
}

export interface CorrectionRecord {
  id: string;
  eventId: string;
  payloadHash: string;
  uid: string;
  agent: string;
  targetType: CorrectionTargetType;
  targetId: string;
  targetRevisionId: string | null;
  action: CorrectionAction;
  correctedContent: string | null;
  reason: string;
  authority: "human_correction";
  status: CorrectionStatus;
  affectedSource: string | null;
  affectedChannel: string | null;
  affectedSessionId: string | null;
  createdSequence: number;
  readySequence: number | null;
  appliedSequence: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

export interface CreateCorrectionInput {
  eventId: string;
  uid: string;
  agent: string;
  source?: string;
  channel?: string;
  sessionId?: string;
  targetType: CorrectionTargetType;
  targetId: string;
  targetRevisionId: string | null;
  action: CorrectionAction;
  correctedContent: string | null;
  reason: string;
}

export interface NamespaceChange {
  sequence: number;
  uid: string;
  agent: string;
  kind: NamespaceChangeKind;
  entityType: string;
  entityId: string;
  correctionId: string | null;
  createdAt: string;
}

export interface GovernanceFreshness {
  status: "current" | "pending_reconciliation";
  pendingCorrectionCount: number;
  latestGovernanceSequence: number;
  appliedGovernanceSequence: number;
}

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
  evidenceCorrectionIds: string[];
  evidenceAuthority: EvidenceAuthority;
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
    evidenceTurnIds?: string[];
    evidenceCorrectionIds?: string[];
    confidence?: number;
  }>;
  reason: string;
  confidence: number;
}

export interface L1MaintenancePlan {
  items: L1MaintenancePlanItem[];
  handledCorrectionIds?: string[];
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
  id?: string;
  content: string;
  evidenceComponentIds: string[];
  evidenceCorrectionIds?: string[];
  semanticOrigin?: "derived";
  evidenceAuthority?: EvidenceAuthority;
  status?: StatementStatus;
  conflictAssessment?: ConflictAssessment | null;
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
  handledCorrectionIds?: string[];
}

export interface StatementDraft {
  content: string;
  evidenceComponentIds?: string[];
  evidenceCorrectionIds?: string[];
  status?: StatementStatus;
  conflictAssessment?: ConflictAssessment | null;
  confidence: number;
  qualifier?: string;
}

export type StatementOperation =
  | { op: "continue"; sourceRef: string; statement: StatementDraft }
  | { op: "create"; statement: StatementDraft }
  | { op: "merge"; sourceRefs: string[]; statement: StatementDraft }
  | { op: "split"; sourceRef: string; statements: StatementDraft[] }
  | { op: "retire"; sourceRef: string };

export interface StatementLineageEdge {
  fromRevisionId: string;
  fromStatementId: string;
  toRevisionId: string | null;
  toStatementId: string | null;
  operation: "continue" | "merge" | "split" | "retire";
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

export type ProfileCategory = "preference" | "identity" | "habit" | "constraint" | "relationship" | "other";

export interface CanonicalProfileDraft {
  profileKey: string;
  category: ProfileCategory;
  value: string;
  summary: string;
  evidenceComponentIds: string[];
  evidenceAggregateIds: string[];
  confidence: number;
  reason: string;
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
