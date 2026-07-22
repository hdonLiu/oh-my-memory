import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  AppendTurnInput,
  Correction,
  L2Aggregate,
  L2AggregateInput,
  L3Profile,
  L3ProfileInput,
  MemorySpace,
  RebuildJob,
  RebuildLayer,
  ResolveSessionInput,
  Session,
  Topic,
  TopicSnapshotInput,
  Turn
} from "../domain/types.js";

export class MemoryRepository {
  constructor(private readonly db: Database.Database) {}

  resolveSession(input: ResolveSessionInput): Session {
    const existing = this.getSessionByExternal(input.uid, input.agentId, input.externalSessionId);
    const timestamp = now();
    if (existing) {
      if (existing.source !== input.source || existing.channel !== (input.channel ?? null)) {
        this.db
          .prepare("update sessions set source = ?, channel = ?, updated_at = ? where id = ?")
          .run(input.source, input.channel ?? null, timestamp, existing.id);
      }
      return this.getSessionByExternal(input.uid, input.agentId, input.externalSessionId)!;
    }
    const id = nanoid();
    this.db
      .prepare(
        `insert into sessions
         (id, uid, agent_id, external_session_id, source, channel, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.uid, input.agentId, input.externalSessionId, input.source, input.channel ?? null, timestamp, timestamp);
    this.ensurePrivateSpace(input.uid, input.agentId);
    return this.getSession(id, input.uid, input.agentId)!;
  }

  getSessionByExternal(uid: string, agentId: string, externalSessionId: string): Session | null {
    const row = this.db
      .prepare("select * from sessions where uid = ? and agent_id = ? and external_session_id = ?")
      .get(uid, agentId, externalSessionId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getSession(id: string, uid: string, agentId: string): Session | null {
    const row = this.db
      .prepare("select * from sessions where id = ? and uid = ? and agent_id = ?")
      .get(id, uid, agentId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getSessionForRebuild(id: string): Session | null {
    const row = this.db.prepare("select * from sessions where id = ?").get(id) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  appendTurn(input: AppendTurnInput): Turn {
    const session = this.getSession(input.sessionId, input.uid, input.agentId);
    if (!session) throw new Error("Session not found in uid + agentId tenant");
    const existing = this.db
      .prepare("select * from turns where uid = ? and agent_id = ? and event_id = ?")
      .get(input.uid, input.agentId, input.eventId) as TurnRow | undefined;
    if (existing) {
      const turn = mapTurn(existing);
      if (
        turn.sessionId !== input.sessionId ||
        turn.role !== input.role ||
        turn.content !== input.content ||
        JSON.stringify(turn.metadata) !== JSON.stringify(input.metadata ?? {})
      ) {
        throw new Error(`Idempotency conflict for eventId: ${input.eventId}`);
      }
      return turn;
    }

    const insert = this.db.transaction(() => {
      const next = this.db
        .prepare("select coalesce(max(sequence), 0) + 1 as value from turns where session_id = ?")
        .get(input.sessionId) as { value: number };
      const turn: Turn = {
        id: nanoid(),
        eventId: input.eventId,
        sessionId: input.sessionId,
        sequence: next.value,
        uid: input.uid,
        agentId: input.agentId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ?? {},
        createdAt: now()
      };
      this.db
        .prepare(
          `insert into turns
           (id, event_id, session_id, sequence, uid, agent_id, role, content, metadata, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          turn.id,
          turn.eventId,
          turn.sessionId,
          turn.sequence,
          turn.uid,
          turn.agentId,
          turn.role,
          turn.content,
          JSON.stringify(turn.metadata),
          turn.createdAt
        );
      return turn;
    });
    return insert();
  }

  listTurns(sessionId: string): Turn[] {
    return this.db
      .prepare("select * from turns where session_id = ? order by sequence asc")
      .all(sessionId)
      .map((row) => mapTurn(row as TurnRow));
  }

  getTurn(id: string, uid: string, agentId: string): Turn | null {
    const row = this.db
      .prepare("select * from turns where id = ? and uid = ? and agent_id = ?")
      .get(id, uid, agentId) as TurnRow | undefined;
    return row ? mapTurn(row) : null;
  }

  createCorrection(input: {
    uid: string;
    agentId: string;
    targetTurnId: string;
    correctedContent: string | null;
    reason: string;
  }): Correction {
    const turn = this.getTurn(input.targetTurnId, input.uid, input.agentId);
    if (!turn) throw new Error("Correction target Turn not found in uid + agentId tenant");
    const correction: Correction = { id: nanoid(), ...input, createdAt: now() };
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `insert into corrections(id, uid, agent_id, target_turn_id, corrected_content, reason, created_at)
           values (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          correction.id,
          correction.uid,
          correction.agentId,
          correction.targetTurnId,
          correction.correctedContent,
          correction.reason,
          correction.createdAt
        );
      this.setRebuildJob("topic", turn.sessionId, "dirty", "turn_correction_created");
      for (const space of this.listAuthorizedSpaces(input.uid, input.agentId)) {
        this.setRebuildJob("L2", space.id, "dirty", "turn_correction_created");
        this.setRebuildJob("L3", space.id, "dirty", "turn_correction_created");
      }
    });
    create();
    return correction;
  }

  listCorrectionsForSession(sessionId: string): Correction[] {
    return this.db
      .prepare(
        `select c.* from corrections c join turns t on t.id = c.target_turn_id
         where t.session_id = ? order by c.created_at asc, c.id asc`
      )
      .all(sessionId)
      .map((row) => mapCorrection(row as CorrectionRow));
  }

  getOpenTopic(sessionId: string): Topic | null {
    const row = this.db
      .prepare("select * from topics where session_id = ? and status = 'open'")
      .get(sessionId) as TopicRow | undefined;
    return row ? mapTopic(row) : null;
  }

  listTopics(sessionId: string): Topic[] {
    return this.db
      .prepare("select * from topics where session_id = ? order by start_sequence asc, id asc")
      .all(sessionId)
      .map((row) => mapTopic(row as TopicRow));
  }

  createOpenTopic(sessionId: string, turn: Turn, includeInRecall: boolean): Topic {
    const timestamp = now();
    const id = nanoid();
    this.db
      .prepare(
        `insert into topics
         (id, session_id, start_sequence, status, turn_ids, title, summary, structured_content, recall_text, created_at, updated_at)
         values (?, ?, ?, 'open', ?, null, null, null, ?, ?, ?)`
      )
      .run(id, sessionId, turn.sequence, JSON.stringify([turn.id]), includeInRecall ? turn.content : "", timestamp, timestamp);
    return this.getOpenTopic(sessionId)!;
  }

  appendTurnToTopic(topicId: string, turn: Turn, includeInRecall: boolean): Topic {
    const row = this.db.prepare("select * from topics where id = ?").get(topicId) as TopicRow | undefined;
    if (!row) throw new Error(`Topic not found: ${topicId}`);
    const topic = mapTopic(row);
    if (topic.status !== "open") throw new Error("Only an open Topic can accept a Turn");
    if (!topic.turnIds.includes(turn.id)) topic.turnIds.push(turn.id);
    const recallText = includeInRecall
      ? [topic.recallText, turn.content].filter((value) => value.length > 0).join("\n")
      : topic.recallText;
    this.db
      .prepare("update topics set turn_ids = ?, recall_text = ?, updated_at = ? where id = ?")
      .run(JSON.stringify(topic.turnIds), recallText, now(), topic.id);
    return this.dbTopic(topic.id);
  }

  splitOpenTopic(sessionId: string, turn: Turn): { pending: Topic; open: Topic } {
    const split = this.db.transaction(() => {
      const open = this.getOpenTopic(sessionId);
      if (!open) throw new Error("Open Topic not found");
      this.db.prepare("update topics set status = 'pending', updated_at = ? where id = ?").run(now(), open.id);
      return { pending: this.dbTopic(open.id), open: this.createOpenTopic(sessionId, turn, true) };
    });
    return split();
  }

  closeOpenTopic(sessionId: string): Topic | null {
    const open = this.getOpenTopic(sessionId);
    if (!open) return null;
    if (open.recallText.length === 0) return open;
    this.db.prepare("update topics set status = 'pending', updated_at = ? where id = ?").run(now(), open.id);
    return this.dbTopic(open.id);
  }

  replaceTopics(sessionId: string, topics: TopicSnapshotInput[]): Topic[] {
    const replace = this.db.transaction(() => {
      this.db.prepare("delete from topics where session_id = ?").run(sessionId);
      const timestamp = now();
      const insert = this.db.prepare(
        `insert into topics
         (id, session_id, start_sequence, status, turn_ids, title, summary, structured_content, recall_text, created_at, updated_at)
         values (?, ?, ?, 'processed', ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const topic of topics) {
        const start = this.db
          .prepare("select min(sequence) as value from turns where session_id = ? and id in (select value from json_each(?))")
          .get(sessionId, JSON.stringify(topic.turnIds)) as { value: number };
        insert.run(
          topic.id,
          sessionId,
          start.value,
          JSON.stringify(topic.turnIds),
          topic.title,
          topic.summary,
          JSON.stringify(topic.structuredContent),
          topic.recallText,
          timestamp,
          timestamp
        );
      }
      this.setRebuildJob("topic", sessionId, "clean", "topic_snapshot_replaced");
      return this.listTopics(sessionId);
    });
    return replace();
  }

  ensurePrivateSpace(uid: string, agentId: string): MemorySpace {
    const existing = this.db
      .prepare("select * from memory_spaces where uid = ? and owner_agent_id = ? and type = 'private'")
      .get(uid, agentId) as MemorySpaceRow | undefined;
    if (existing) return mapMemorySpace(existing);
    const timestamp = now();
    const id = nanoid();
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `insert into memory_spaces(id, uid, type, name, owner_agent_id, created_at, updated_at)
           values (?, ?, 'private', ?, ?, ?, ?)`
        )
        .run(id, uid, `private:${agentId}`, agentId, timestamp, timestamp);
      this.db
        .prepare("insert into memory_space_members(memory_space_id, agent_id, created_at) values (?, ?, ?)")
        .run(id, agentId, timestamp);
    });
    create();
    return this.getMemorySpace(id)!;
  }

  createSharedSpace(uid: string, name: string, creatorAgentId: string): MemorySpace {
    const timestamp = now();
    const id = nanoid();
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `insert into memory_spaces(id, uid, type, name, owner_agent_id, created_at, updated_at)
           values (?, ?, 'shared', ?, null, ?, ?)`
        )
        .run(id, uid, name, timestamp, timestamp);
      this.db
        .prepare("insert into memory_space_members(memory_space_id, agent_id, created_at) values (?, ?, ?)")
        .run(id, creatorAgentId, timestamp);
    });
    create();
    return this.getMemorySpace(id)!;
  }

  addSpaceMember(uid: string, memorySpaceId: string, agentId: string): void {
    const space = this.getMemorySpace(memorySpaceId);
    if (!space || space.uid !== uid) throw new Error("MemorySpace member must belong to the same uid");
    if (space.type !== "shared") throw new Error("Private MemorySpace membership cannot be changed");
    this.db
      .prepare("insert or ignore into memory_space_members(memory_space_id, agent_id, created_at) values (?, ?, ?)")
      .run(memorySpaceId, agentId, now());
  }

  getMemorySpace(id: string): MemorySpace | null {
    const row = this.db.prepare("select * from memory_spaces where id = ?").get(id) as MemorySpaceRow | undefined;
    return row ? mapMemorySpace(row) : null;
  }

  listSpaceMembers(memorySpaceId: string): string[] {
    return (this.db
      .prepare("select agent_id from memory_space_members where memory_space_id = ? order by created_at asc")
      .all(memorySpaceId) as Array<{ agent_id: string }>).map((row) => row.agent_id);
  }

  listAuthorizedSpaces(uid: string, agentId: string): MemorySpace[] {
    this.ensurePrivateSpace(uid, agentId);
    return this.db
      .prepare(
        `select s.* from memory_spaces s
         join memory_space_members m on m.memory_space_id = s.id
         where s.uid = ? and m.agent_id = ?
         order by case s.type when 'private' then 0 else 1 end, s.created_at asc`
      )
      .all(uid, agentId)
      .map((row) => mapMemorySpace(row as MemorySpaceRow));
  }

  assertSpaceAccess(uid: string, agentId: string, memorySpaceId: string): MemorySpace {
    const space = this.db
      .prepare(
        `select s.* from memory_spaces s
         join memory_space_members m on m.memory_space_id = s.id
         where s.id = ? and s.uid = ? and m.agent_id = ?`
      )
      .get(memorySpaceId, uid, agentId) as MemorySpaceRow | undefined;
    if (!space) throw new Error("MemorySpace is not authorized for uid + agentId");
    return mapMemorySpace(space);
  }

  markSpacesForAgentDirty(uid: string, agentId: string, reason: string): void {
    for (const space of this.listAuthorizedSpaces(uid, agentId)) {
      this.setRebuildJob("L2", space.id, "dirty", reason);
    }
  }

  listProcessedTopicsForSpace(memorySpaceId: string): Topic[] {
    const space = this.getMemorySpace(memorySpaceId);
    if (!space) throw new Error("MemorySpace not found");
    return this.db
      .prepare(
        `select distinct t.* from topics t
         join sessions s on s.id = t.session_id
         join memory_space_members m on m.memory_space_id = ? and m.agent_id = s.agent_id
         where s.uid = ? and t.status = 'processed'
         order by t.created_at asc`
      )
      .all(memorySpaceId, space.uid)
      .map((row) => mapTopic(row as TopicRow));
  }

  replaceL2Snapshot(memorySpaceId: string, aggregates: L2AggregateInput[]): L2Aggregate[] {
    const replace = this.db.transaction(() => {
      const existing = new Map(this.listL2(memorySpaceId).map((item) => [item.id, item]));
      this.db.prepare("delete from l2_aggregates where memory_space_id = ?").run(memorySpaceId);
      const insert = this.db.prepare(
        `insert into l2_aggregates
         (id, memory_space_id, memory_key, content, kind, evidence_turn_ids, source_agent_ids, confidence, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const timestamp = now();
      for (const item of aggregates) {
        insert.run(
          item.id,
          memorySpaceId,
          item.key,
          item.content,
          item.kind,
          JSON.stringify(item.evidenceTurnIds),
          JSON.stringify(item.sourceAgentIds),
          item.confidence,
          existing.get(item.id)?.createdAt ?? timestamp,
          timestamp
        );
      }
      this.setRebuildJob("L2", memorySpaceId, "clean", "l2_snapshot_replaced");
      this.setRebuildJob("L3", memorySpaceId, "dirty", "l2_snapshot_changed");
      return this.listL2(memorySpaceId);
    });
    return replace();
  }

  listL2(memorySpaceId: string): L2Aggregate[] {
    return this.db
      .prepare("select * from l2_aggregates where memory_space_id = ? order by created_at asc, id asc")
      .all(memorySpaceId)
      .map((row) => mapL2(row as L2Row));
  }

  replaceL3Snapshot(memorySpaceId: string, profiles: L3ProfileInput[]): L3Profile[] {
    const replace = this.db.transaction(() => {
      const existing = new Map(this.listL3(memorySpaceId).map((item) => [item.id, item]));
      this.db.prepare("delete from l3_profiles where memory_space_id = ?").run(memorySpaceId);
      const insert = this.db.prepare(
        `insert into l3_profiles
         (id, memory_space_id, profile_key, content, evidence_l2_ids, confidence, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const timestamp = now();
      for (const item of profiles) {
        insert.run(
          item.id,
          memorySpaceId,
          item.key,
          item.content,
          JSON.stringify(item.evidenceL2Ids),
          item.confidence,
          existing.get(item.id)?.createdAt ?? timestamp,
          timestamp
        );
      }
      this.setRebuildJob("L3", memorySpaceId, "clean", "l3_snapshot_replaced");
      return this.listL3(memorySpaceId);
    });
    return replace();
  }

  listL3(memorySpaceId: string): L3Profile[] {
    return this.db
      .prepare("select * from l3_profiles where memory_space_id = ? order by created_at asc, id asc")
      .all(memorySpaceId)
      .map((row) => mapL3(row as L3Row));
  }

  setRebuildJob(layer: RebuildLayer, scopeId: string, status: RebuildJob["status"], reason: string, error?: string): void {
    const previous = this.getRebuildJob(layer, scopeId);
    this.db
      .prepare(
        `insert into rebuild_jobs(layer, scope_id, status, reason, last_error, attempts, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(layer, scope_id) do update set
           status = excluded.status,
           reason = excluded.reason,
           last_error = excluded.last_error,
           attempts = excluded.attempts,
           updated_at = excluded.updated_at`
      )
      .run(
        layer,
        scopeId,
        status,
        reason,
        error ?? null,
        status === "dirty" && error ? (previous?.attempts ?? 0) + 1 : previous?.attempts ?? 0,
        now()
      );
  }

  getRebuildJob(layer: RebuildLayer, scopeId: string): RebuildJob | null {
    const row = this.db
      .prepare("select * from rebuild_jobs where layer = ? and scope_id = ?")
      .get(layer, scopeId) as RebuildJobRow | undefined;
    return row ? mapRebuildJob(row) : null;
  }

  listDirtyJobs(layer?: RebuildLayer): RebuildJob[] {
    const rows = layer
      ? this.db.prepare("select * from rebuild_jobs where status = 'dirty' and layer = ? order by updated_at asc").all(layer)
      : this.db
          .prepare(
            `select * from rebuild_jobs where status = 'dirty'
             order by case layer when 'topic' then 0 when 'L2' then 1 else 2 end, updated_at asc`
          )
          .all();
    return rows.map((row) => mapRebuildJob(row as RebuildJobRow));
  }

  listRecallCandidates(uid: string, agentId: string, sessionId?: string) {
    const topics = sessionId
      ? this.db
          .prepare(
            `select t.* from topics t join sessions s on s.id = t.session_id
             where t.session_id = ? and s.uid = ? and s.agent_id = ? and t.status in ('pending', 'processed')`
          )
          .all(sessionId, uid, agentId)
          .map((row) => mapTopic(row as TopicRow))
      : [];
    const spaces = this.listAuthorizedSpaces(uid, agentId);
    return {
      topics,
      l2: spaces.flatMap((space) => this.listL2(space.id)),
      l3: spaces.flatMap((space) => this.listL3(space.id))
    };
  }

  private dbTopic(id: string): Topic {
    const row = this.db.prepare("select * from topics where id = ?").get(id) as TopicRow | undefined;
    if (!row) throw new Error(`Topic not found: ${id}`);
    return mapTopic(row);
  }
}

type SessionRow = {
  id: string; uid: string; agent_id: string; external_session_id: string; source: string; channel: string | null;
  created_at: string; updated_at: string;
};
type TurnRow = {
  id: string; event_id: string; session_id: string; sequence: number; uid: string; agent_id: string;
  role: Turn["role"]; content: string; metadata: string; created_at: string;
};
type TopicRow = {
  id: string; session_id: string; start_sequence: number; status: Topic["status"]; turn_ids: string; title: string | null;
  summary: string | null; structured_content: string | null; recall_text: string; created_at: string; updated_at: string;
};
type MemorySpaceRow = {
  id: string; uid: string; type: MemorySpace["type"]; name: string; owner_agent_id: string | null;
  created_at: string; updated_at: string;
};
type L2Row = {
  id: string; memory_space_id: string; memory_key: string; content: string; kind: string;
  evidence_turn_ids: string; source_agent_ids: string; confidence: number; created_at: string; updated_at: string;
};
type L3Row = {
  id: string; memory_space_id: string; profile_key: string; content: string; evidence_l2_ids: string;
  confidence: number; created_at: string; updated_at: string;
};
type RebuildJobRow = {
  layer: RebuildLayer; scope_id: string; status: RebuildJob["status"]; reason: string; last_error: string | null;
  attempts: number; updated_at: string;
};
type CorrectionRow = {
  id: string; uid: string; agent_id: string; target_turn_id: string; corrected_content: string | null;
  reason: string; created_at: string;
};

function mapSession(row: SessionRow): Session {
  return { id: row.id, uid: row.uid, agentId: row.agent_id, externalSessionId: row.external_session_id,
    source: row.source, channel: row.channel, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapTurn(row: TurnRow): Turn {
  return { id: row.id, eventId: row.event_id, sessionId: row.session_id, sequence: row.sequence, uid: row.uid,
    agentId: row.agent_id, role: row.role, content: row.content, metadata: parseObject(row.metadata), createdAt: row.created_at };
}
function mapTopic(row: TopicRow): Topic {
  return { id: row.id, sessionId: row.session_id, status: row.status, turnIds: parseArray(row.turn_ids), title: row.title,
    summary: row.summary, structuredContent: row.structured_content ? parseObject(row.structured_content) : null,
    recallText: row.recall_text, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapMemorySpace(row: MemorySpaceRow): MemorySpace {
  return { id: row.id, uid: row.uid, type: row.type, name: row.name, ownerAgentId: row.owner_agent_id,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapL2(row: L2Row): L2Aggregate {
  return { id: row.id, memorySpaceId: row.memory_space_id, key: row.memory_key, content: row.content, kind: row.kind,
    evidenceTurnIds: parseArray(row.evidence_turn_ids), sourceAgentIds: parseArray(row.source_agent_ids),
    confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapL3(row: L3Row): L3Profile {
  return { id: row.id, memorySpaceId: row.memory_space_id, key: row.profile_key, content: row.content,
    evidenceL2Ids: parseArray(row.evidence_l2_ids), confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapRebuildJob(row: RebuildJobRow): RebuildJob {
  return { layer: row.layer, scopeId: row.scope_id, status: row.status, reason: row.reason, lastError: row.last_error,
    attempts: row.attempts, updatedAt: row.updated_at };
}
function mapCorrection(row: CorrectionRow): Correction {
  return { id: row.id, uid: row.uid, agentId: row.agent_id, targetTurnId: row.target_turn_id,
    correctedContent: row.corrected_content, reason: row.reason, createdAt: row.created_at };
}
function parseArray(value: string): string[] { return JSON.parse(value) as string[]; }
function parseObject(value: string): Record<string, unknown> { return JSON.parse(value) as Record<string, unknown>; }
function now(): string { return new Date().toISOString(); }
