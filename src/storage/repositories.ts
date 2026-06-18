import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  ConversationTurn,
  CreateMemoryInput,
  CreateProjectBuildRunInput,
  CreateTopicSegmentInput,
  CreateTurnInput,
  Memory,
  MemoryRelation,
  MemoryStatus,
  ProjectBuildRun,
  ProjectBuildRunStatus,
  RelationType,
  Scope,
  TopicSegment,
  TopicStatus
} from "../domain/types.js";
import type { MemoryPatch, MemoryStore } from "./store.js";

type TurnRow = {
  id: string;
  session_id: string;
  role: ConversationTurn["role"];
  content: string;
  mis: string;
  source: string;
  agent: string;
  channel: string;
  metadata: string;
  created_at: string;
};

type MemoryRow = {
  id: string;
  level: Memory["level"];
  type: Memory["type"];
  subject: string;
  predicate: string;
  object: string;
  summary: string;
  confidence: number;
  status: MemoryStatus;
  supersedes_id: string | null;
  source_turn_ids: string;
  mis: string;
  source: string;
  agent: string;
  channel: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type RelationRow = {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: RelationType;
  confidence: number;
  created_at: string;
};

type TopicSegmentRow = {
  id: string;
  session_id: string;
  title: string;
  summary: string;
  status: TopicStatus;
  confidence: number;
  turn_ids: string;
  reason: string;
  fingerprint: string;
  project_memory_ids: string;
  mis: string;
  source: string;
  agent: string;
  channel: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type ProjectBuildRunRow = {
  id: string;
  started_at: string;
  ended_at: string;
  scopes_run: number;
  created_or_updated: number;
  status: ProjectBuildRunStatus;
  errors: string;
};

export class MemoryRepository implements MemoryStore {
  constructor(private readonly db: Database.Database) {}

  createTurn(input: CreateTurnInput): ConversationTurn {
    const turn: ConversationTurn = { ...input, id: nanoid(), createdAt: now() };
    this.db
      .prepare(
        `insert into conversation_turns
        (id, session_id, role, content, mis, source, agent, channel, metadata, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turn.id,
        turn.sessionId,
        turn.role,
        turn.content,
        turn.mis,
        turn.source,
        turn.agent,
        turn.channel,
        JSON.stringify(turn.metadata),
        turn.createdAt
      );
    return turn;
  }

  listTurns(): ConversationTurn[] {
    return this.db
      .prepare("select * from conversation_turns order by created_at asc")
      .all()
      .map((row) => mapTurn(row as TurnRow));
  }

  recentTurns(scope: Partial<Scope> & { sessionId?: string }, limit: number): ConversationTurn[] {
    const rows = this.listTurns()
      .filter((turn) => matchesScope(turn, scope) && (!scope.sessionId || turn.sessionId === scope.sessionId))
      .slice(-limit);
    return rows;
  }

  createMemory(input: CreateMemoryInput): Memory {
    const timestamp = now();
    const memory: Memory = { ...input, id: nanoid(), createdAt: timestamp, updatedAt: timestamp };
    this.db
      .prepare(
        `insert into memories
        (id, level, type, subject, predicate, object, summary, confidence, status, supersedes_id,
         source_turn_ids, mis, source, agent, channel, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memory.id,
        memory.level,
        memory.type,
        memory.subject,
        memory.predicate,
        memory.object,
        memory.summary,
        memory.confidence,
        memory.status,
        memory.supersedesId,
        JSON.stringify(memory.sourceTurnIds),
        memory.mis,
        memory.source,
        memory.agent,
        memory.channel,
        JSON.stringify(memory.metadata),
        memory.createdAt,
        memory.updatedAt
      );
    return memory;
  }

  updateMemory(id: string, patch: MemoryPatch): Memory {
    const current = this.getMemory(id);
    if (!current) {
      throw new Error(`Memory not found: ${id}`);
    }
    const updated: Memory = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: now() };
    this.db
      .prepare(
        `update memories set
          level = ?, type = ?, subject = ?, predicate = ?, object = ?, summary = ?, confidence = ?,
          status = ?, supersedes_id = ?, source_turn_ids = ?, mis = ?, source = ?, agent = ?,
          channel = ?, metadata = ?, updated_at = ?
        where id = ?`
      )
      .run(
        updated.level,
        updated.type,
        updated.subject,
        updated.predicate,
        updated.object,
        updated.summary,
        updated.confidence,
        updated.status,
        updated.supersedesId,
        JSON.stringify(updated.sourceTurnIds),
        updated.mis,
        updated.source,
        updated.agent,
        updated.channel,
        JSON.stringify(updated.metadata),
        updated.updatedAt,
        id
      );
    return updated;
  }

  getMemory(id: string): Memory | null {
    const row = this.db.prepare("select * from memories where id = ?").get(id) as MemoryRow | undefined;
    return row ? mapMemory(row) : null;
  }

  listMemories(scope: Partial<Scope> = {}): Memory[] {
    return this.db
      .prepare("select * from memories order by created_at asc")
      .all()
      .map((row) => mapMemory(row as MemoryRow))
      .filter((memory) => matchesScope(memory, scope));
  }

  createTopicSegment(input: CreateTopicSegmentInput): TopicSegment {
    const timestamp = now();
    const topic: TopicSegment = { ...input, id: nanoid(), createdAt: timestamp, updatedAt: timestamp };
    this.db
      .prepare(
        `insert into topic_segments
        (id, session_id, title, summary, status, confidence, turn_ids, reason, fingerprint, project_memory_ids,
         mis, source, agent, channel, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        topic.id,
        topic.sessionId,
        topic.title,
        topic.summary,
        topic.status,
        topic.confidence,
        JSON.stringify(topic.turnIds),
        topic.reason,
        topic.fingerprint,
        JSON.stringify(topic.projectMemoryIds),
        topic.mis,
        topic.source,
        topic.agent,
        topic.channel,
        JSON.stringify(topic.metadata),
        topic.createdAt,
        topic.updatedAt
      );
    return topic;
  }

  updateTopicSegment(id: string, patch: Partial<Omit<TopicSegment, "id" | "createdAt">>): TopicSegment {
    const current = this.listTopicSegments().find((topic) => topic.id === id);
    if (!current) {
      throw new Error(`Topic segment not found: ${id}`);
    }
    const updated: TopicSegment = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: now() };
    this.db
      .prepare(
        `update topic_segments set
          session_id = ?, title = ?, summary = ?, status = ?, confidence = ?, turn_ids = ?, reason = ?, fingerprint = ?,
          project_memory_ids = ?, mis = ?, source = ?, agent = ?, channel = ?, metadata = ?, updated_at = ?
        where id = ?`
      )
      .run(
        updated.sessionId,
        updated.title,
        updated.summary,
        updated.status,
        updated.confidence,
        JSON.stringify(updated.turnIds),
        updated.reason,
        updated.fingerprint,
        JSON.stringify(updated.projectMemoryIds),
        updated.mis,
        updated.source,
        updated.agent,
        updated.channel,
        JSON.stringify(updated.metadata),
        updated.updatedAt,
        id
      );
    return updated;
  }

  getTopicSegmentByFingerprint(fingerprint: string): TopicSegment | null {
    const row = this.db.prepare("select * from topic_segments where fingerprint = ?").get(fingerprint) as
      | TopicSegmentRow
      | undefined;
    return row ? mapTopicSegment(row) : null;
  }

  listTopicSegments(scope: Partial<Scope> = {}): TopicSegment[] {
    return this.db
      .prepare("select * from topic_segments order by created_at asc")
      .all()
      .map((row) => mapTopicSegment(row as TopicSegmentRow))
      .filter((topic) => matchesScope(topic, scope));
  }

  createRelation(
    fromMemoryId: string,
    toMemoryId: string,
    relationType: RelationType,
    confidence: number
  ): MemoryRelation {
    const relation: MemoryRelation = {
      id: nanoid(),
      fromMemoryId,
      toMemoryId,
      relationType,
      confidence,
      createdAt: now()
    };
    this.db
      .prepare(
        `insert into memory_relations
        (id, from_memory_id, to_memory_id, relation_type, confidence, created_at)
        values (?, ?, ?, ?, ?, ?)`
      )
      .run(
        relation.id,
        relation.fromMemoryId,
        relation.toMemoryId,
        relation.relationType,
        relation.confidence,
        relation.createdAt
      );
    return relation;
  }

  listRelations(memoryId: string): MemoryRelation[] {
    return this.db
      .prepare("select * from memory_relations where from_memory_id = ? or to_memory_id = ? order by created_at asc")
      .all(memoryId, memoryId)
      .map((row) => mapRelation(row as RelationRow));
  }

  createProjectBuildRun(input: CreateProjectBuildRunInput): ProjectBuildRun {
    const run: ProjectBuildRun = { ...input, id: nanoid() };
    this.db
      .prepare(
        `insert into project_build_runs
        (id, started_at, ended_at, scopes_run, created_or_updated, status, errors)
        values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.startedAt,
        run.endedAt,
        run.scopesRun,
        run.createdOrUpdated,
        run.status,
        JSON.stringify(run.errors)
      );
    return run;
  }

  listProjectBuildRuns(limit = 20): ProjectBuildRun[] {
    return this.db
      .prepare("select * from project_build_runs order by started_at desc limit ?")
      .all(limit)
      .map((row) => mapProjectBuildRun(row as ProjectBuildRunRow));
  }
}

export function sameScope(left: Scope, right: Partial<Scope>): boolean {
  return matchesScope(left, right);
}

function matchesScope(value: Scope, scope: Partial<Scope>): boolean {
  return (
    (!scope.mis || value.mis === scope.mis) &&
    (!scope.source || value.source === scope.source) &&
    (!scope.agent || value.agent === scope.agent) &&
    (!scope.channel || value.channel === scope.channel)
  );
}

function mapTurn(row: TurnRow): ConversationTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    mis: row.mis,
    source: row.source,
    agent: row.agent,
    channel: row.channel,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    level: row.level,
    type: row.type,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    summary: row.summary,
    confidence: row.confidence,
    status: row.status,
    supersedesId: row.supersedes_id,
    sourceTurnIds: JSON.parse(row.source_turn_ids) as string[],
    mis: row.mis,
    source: row.source,
    agent: row.agent,
    channel: row.channel,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTopicSegment(row: TopicSegmentRow): TopicSegment {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    confidence: row.confidence,
    turnIds: JSON.parse(row.turn_ids) as string[],
    reason: row.reason,
    fingerprint: row.fingerprint,
    projectMemoryIds: JSON.parse(row.project_memory_ids) as string[],
    mis: row.mis,
    source: row.source,
    agent: row.agent,
    channel: row.channel,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRelation(row: RelationRow): MemoryRelation {
  return {
    id: row.id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    relationType: row.relation_type,
    confidence: row.confidence,
    createdAt: row.created_at
  };
}

function mapProjectBuildRun(row: ProjectBuildRunRow): ProjectBuildRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    scopesRun: row.scopes_run,
    createdOrUpdated: row.created_or_updated,
    status: row.status,
    errors: JSON.parse(row.errors) as ProjectBuildRun["errors"]
  };
}

function now(): string {
  return new Date().toISOString();
}
