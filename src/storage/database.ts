import Database from "better-sqlite3";
import { nanoid } from "nanoid";

const LEGACY_TABLES = [
  "memories",
  "topic_segments",
  "memory_relations",
  "project_build_runs",
  "l1_topics",
  "l1_topic_revisions",
  "l1_components",
  "l1_topic_lineage",
  "l1_maintenance_runs",
  "l1_stable_sequence",
  "l2_aggregates",
  "l2_aggregate_revisions",
  "l2_component_memberships",
  "l2_aggregate_lineage",
  "l2_aggregation_runs",
  "namespace_changes",
  "correction_records",
  "statement_lineage_edges",
  "l2_checkpoints",
  "l3_profile_checkpoints",
  "memory_vectors",
  "schema_migrations"
] as const;

export function createDatabase(path = process.env.MEMORY_DB_PATH ?? "memory.sqlite"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateLegacyTurns(db);
  createCurrentSchema(db);
  return db;
}

function createCurrentSchema(db: Database.Database): void {
  db.exec(`
    create table if not exists memory_schema (
      version integer primary key,
      applied_at text not null
    );

    create table if not exists sessions (
      id text primary key,
      uid text not null,
      agent_id text not null,
      external_session_id text not null,
      source text not null,
      channel text,
      created_at text not null,
      updated_at text not null,
      unique(uid, agent_id, external_session_id)
    );

    create table if not exists turns (
      id text primary key,
      event_id text not null,
      session_id text not null references sessions(id),
      sequence integer not null,
      uid text not null,
      agent_id text not null,
      role text not null check(role in ('user', 'assistant', 'system')),
      content text not null,
      metadata text not null,
      created_at text not null,
      unique(uid, agent_id, event_id),
      unique(session_id, sequence)
    );

    create table if not exists topics (
      id text primary key,
      session_id text not null references sessions(id),
      start_sequence integer not null,
      status text not null check(status in ('open', 'pending', 'processed')),
      turn_ids text not null,
      title text,
      summary text,
      structured_content text,
      recall_text text not null,
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists one_open_topic_per_session
      on topics(session_id) where status = 'open';
    create index if not exists topics_by_session on topics(session_id, created_at);

    create table if not exists memory_spaces (
      id text primary key,
      uid text not null,
      type text not null check(type in ('private', 'shared')),
      name text not null,
      owner_agent_id text,
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists one_private_space_per_agent
      on memory_spaces(uid, owner_agent_id) where type = 'private';

    create table if not exists memory_space_members (
      memory_space_id text not null references memory_spaces(id) on delete cascade,
      agent_id text not null,
      created_at text not null,
      primary key(memory_space_id, agent_id)
    );

    create table if not exists l2_aggregates (
      id text primary key,
      memory_space_id text not null references memory_spaces(id) on delete cascade,
      memory_key text not null,
      content text not null,
      kind text not null,
      evidence_turn_ids text not null,
      source_agent_ids text not null,
      confidence real not null,
      created_at text not null,
      updated_at text not null,
      unique(memory_space_id, memory_key)
    );

    create table if not exists l3_profiles (
      id text primary key,
      memory_space_id text not null references memory_spaces(id) on delete cascade,
      profile_key text not null,
      content text not null,
      evidence_l2_ids text not null,
      confidence real not null,
      created_at text not null,
      updated_at text not null,
      unique(memory_space_id, profile_key)
    );

    create table if not exists rebuild_jobs (
      layer text not null check(layer in ('topic', 'L2', 'L3')),
      scope_id text not null,
      status text not null check(status in ('clean', 'dirty', 'rebuilding')),
      reason text not null,
      last_error text,
      attempts integer not null default 0,
      updated_at text not null,
      primary key(layer, scope_id)
    );

    create table if not exists corrections (
      id text primary key,
      uid text not null,
      agent_id text not null,
      target_turn_id text not null references turns(id),
      corrected_content text,
      reason text not null,
      created_at text not null
    );

    create trigger if not exists turns_are_immutable_update
    before update on turns
    begin
      select raise(abort, 'turns are immutable');
    end;

    create trigger if not exists turns_are_immutable_delete
    before delete on turns
    begin
      select raise(abort, 'turns are immutable');
    end;
  `);
  const topicColumns = db.pragma("table_info(topics)") as Array<{ name: string }>;
  if (!topicColumns.some((column) => column.name === "start_sequence")) {
    db.exec("alter table topics add column start_sequence integer not null default 0");
  }
  db.prepare("insert or ignore into memory_schema(version, applied_at) values(?, ?)").run(1, new Date().toISOString());
}

function migrateLegacyTurns(db: Database.Database): void {
  if (!tableExists(db, "conversation_turns")) return;

  const migrate = db.transaction(() => {
    db.exec("alter table conversation_turns rename to legacy_conversation_turns");
    for (const table of LEGACY_TABLES) db.exec(`drop table if exists ${table}`);
    createCurrentSchema(db);

    const rows = db.prepare("select * from legacy_conversation_turns order by created_at asc, id asc").all() as LegacyTurnRow[];
    const eventKeys = new Set<string>();
    for (const row of rows) {
      const key = `${row.uid}\u0000${row.agent}\u0000${row.event_id || row.id}`;
      if (eventKeys.has(key)) {
        throw new Error(`Legacy Turn migration conflict for uid=${row.uid}, agentId=${row.agent}, eventId=${row.event_id}`);
      }
      eventKeys.add(key);
    }

    const sessions = new Map<string, { id: string; sequence: number }>();
    for (const row of rows) {
      const externalSessionId = row.session_id;
      const sessionKey = `${row.uid}\u0000${row.agent}\u0000${externalSessionId}`;
      let session = sessions.get(sessionKey);
      if (!session) {
        session = { id: nanoid(), sequence: 0 };
        sessions.set(sessionKey, session);
        db.prepare(
          `insert into sessions
           (id, uid, agent_id, external_session_id, source, channel, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(session.id, row.uid, row.agent, externalSessionId, row.source, row.channel, row.created_at, row.created_at);
      }
      session.sequence += 1;
      db.prepare(
        `insert into turns
         (id, event_id, session_id, sequence, uid, agent_id, role, content, metadata, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.event_id || row.id,
        session.id,
        session.sequence,
        row.uid,
        row.agent,
        row.role,
        row.content,
        row.metadata,
        row.created_at
      );
    }

    for (const session of sessions.values()) markDirty(db, "topic", session.id, "legacy_turn_migration");
    db.exec("drop table legacy_conversation_turns");
  });
  migrate();
}

function markDirty(db: Database.Database, layer: string, scopeId: string, reason: string): void {
  db.prepare(
    `insert into rebuild_jobs(layer, scope_id, status, reason, last_error, attempts, updated_at)
     values (?, ?, 'dirty', ?, null, 0, ?)`
  ).run(layer, scopeId, reason, new Date().toISOString());
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));
}

interface LegacyTurnRow {
  id: string;
  event_id: string | null;
  session_id: string;
  role: string;
  content: string;
  uid: string;
  source: string;
  agent: string;
  channel: string;
  metadata: string;
  created_at: string;
}
