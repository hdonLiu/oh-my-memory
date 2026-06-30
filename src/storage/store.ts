import type {
  ConversationTurn,
  CreateMemoryInput,
  CreateProjectBuildRunInput,
  CreateTopicSegmentInput,
  CreateTurnInput,
  Memory,
  ProjectBuildRun,
  MemoryRelation,
  RelationType,
  Scope,
  TopicSegment
} from "../domain/types.js";
import type { LayeredMemoryRepository } from "./layered-repository.js";

export type MemoryPatch = Partial<Omit<Memory, "id" | "createdAt">>;

export interface MemoryStore {
  readonly layered: LayeredMemoryRepository;
  createTurn(input: CreateTurnInput): ConversationTurn;
  listTurns(): ConversationTurn[];
  recentTurns(scope: Partial<Scope> & { sessionId?: string }, limit: number): ConversationTurn[];
  createMemory(input: CreateMemoryInput): Memory;
  updateMemory(id: string, patch: MemoryPatch): Memory;
  getMemory(id: string): Memory | null;
  listMemories(scope?: Partial<Scope>): Memory[];
  createTopicSegment(input: CreateTopicSegmentInput): TopicSegment;
  updateTopicSegment(id: string, patch: Partial<Omit<TopicSegment, "id" | "createdAt">>): TopicSegment;
  getTopicSegmentByFingerprint(fingerprint: string): TopicSegment | null;
  listTopicSegments(scope?: Partial<Scope>): TopicSegment[];
  createRelation(
    fromMemoryId: string,
    toMemoryId: string,
    relationType: RelationType,
    confidence: number
  ): MemoryRelation;
  listRelations(memoryId: string): MemoryRelation[];
  createProjectBuildRun(input: CreateProjectBuildRunInput): ProjectBuildRun;
  listProjectBuildRuns(limit?: number): ProjectBuildRun[];
}
