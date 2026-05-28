import type {
  ConversationTurn,
  CreateMemoryInput,
  CreateTurnInput,
  Memory,
  MemoryRelation,
  RelationType,
  Scope
} from "../domain/types.js";

export type MemoryPatch = Partial<Omit<Memory, "id" | "createdAt">>;

export interface MemoryStore {
  createTurn(input: CreateTurnInput): ConversationTurn;
  listTurns(): ConversationTurn[];
  recentTurns(scope: Partial<Scope>, limit: number): ConversationTurn[];
  createMemory(input: CreateMemoryInput): Memory;
  updateMemory(id: string, patch: MemoryPatch): Memory;
  getMemory(id: string): Memory | null;
  listMemories(scope?: Partial<Scope>): Memory[];
  createRelation(
    fromMemoryId: string,
    toMemoryId: string,
    relationType: RelationType,
    confidence: number
  ): MemoryRelation;
  listRelations(memoryId: string): MemoryRelation[];
}
