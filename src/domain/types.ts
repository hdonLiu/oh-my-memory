export type Role = "user" | "assistant" | "system";
export type TopicStatus = "open" | "pending" | "processed";
export type MemorySpaceType = "private" | "shared";
export type RebuildLayer = "topic" | "L2" | "L3";
export type RebuildStatus = "clean" | "dirty" | "rebuilding";

export interface Session {
  id: string;
  uid: string;
  agentId: string;
  externalSessionId: string;
  source: string;
  channel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolveSessionInput {
  uid: string;
  agentId: string;
  externalSessionId: string;
  source: string;
  channel?: string | null;
}

export interface Turn {
  id: string;
  eventId: string;
  sessionId: string;
  sequence: number;
  uid: string;
  agentId: string;
  role: Role;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AppendTurnInput {
  eventId: string;
  sessionId: string;
  uid: string;
  agentId: string;
  role: Role;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface Topic {
  id: string;
  sessionId: string;
  status: TopicStatus;
  turnIds: string[];
  title: string | null;
  summary: string | null;
  structuredContent: Record<string, unknown> | null;
  recallText: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicSnapshotInput {
  id: string;
  turnIds: string[];
  title: string;
  summary: string;
  structuredContent: Record<string, unknown>;
  recallText: string;
}

export interface MemorySpace {
  id: string;
  uid: string;
  type: MemorySpaceType;
  name: string;
  ownerAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface L2AggregateInput {
  id: string;
  key: string;
  content: string;
  kind: string;
  evidenceTurnIds: string[];
  sourceAgentIds: string[];
  confidence: number;
}

export interface L2Aggregate extends L2AggregateInput {
  memorySpaceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface L3ProfileInput {
  id: string;
  key: string;
  content: string;
  evidenceL2Ids: string[];
  confidence: number;
}

export interface L3Profile extends L3ProfileInput {
  memorySpaceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RebuildJob {
  layer: RebuildLayer;
  scopeId: string;
  status: RebuildStatus;
  reason: string;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
}

export interface Correction {
  id: string;
  uid: string;
  agentId: string;
  targetTurnId: string;
  correctedContent: string | null;
  reason: string;
  createdAt: string;
}

export interface IngestTurnInput {
  uid: string;
  agentId: string;
  externalSessionId: string;
  eventId: string;
  source: string;
  channel?: string | null;
  role: Role;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RecallItem {
  id: string;
  layer: "topic" | "L2" | "L3";
  content: string;
  provenanceTurnIds: string[];
  memorySpaceId: string | null;
}
