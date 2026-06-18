import Database from "better-sqlite3";

export function createDatabase(path = process.env.MEMORY_DB_PATH ?? "memory.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists conversation_turns (
      id text primary key,
      session_id text not null,
      role text not null,
      content text not null,
      mis text not null,
      source text not null,
      agent text not null,
      channel text not null,
      metadata text not null,
      created_at text not null
    );

    create table if not exists memories (
      id text primary key,
      level text not null,
      type text not null,
      subject text not null,
      predicate text not null,
      object text not null,
      summary text not null,
      readable_text text not null default '',
      confidence real not null,
      status text not null,
      supersedes_id text,
      source_turn_ids text not null,
      mis text not null,
      source text not null,
      agent text not null,
      channel text not null,
      metadata text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists topic_segments (
      id text primary key,
      session_id text not null default '',
      title text not null,
      summary text not null,
      status text not null,
      confidence real not null,
      turn_ids text not null,
      reason text not null,
      fingerprint text not null unique,
      project_memory_ids text not null,
      mis text not null,
      source text not null,
      agent text not null,
      channel text not null,
      metadata text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists memory_relations (
      id text primary key,
      from_memory_id text not null,
      to_memory_id text not null,
      relation_type text not null,
      confidence real not null,
      created_at text not null
    );

    create table if not exists project_build_runs (
      id text primary key,
      started_at text not null,
      ended_at text not null,
      scopes_run integer not null,
      created_or_updated integer not null,
      status text not null,
      errors text not null
    );

    create table if not exists schema_migrations (
      version integer primary key,
      applied_at text not null
    );
  `);
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  ensureTopicProjectMemoryColumn(db);
  ensureReadableMemoryColumn(db);
  ensureIndexes(db);
  recordMigration(db, 1);
}

function ensureReadableMemoryColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(memories)") as Array<{ name: string }>;
  const hasMemoryTable = columns.length > 0;
  const hasReadableText = columns.some((column) => column.name === "readable_text");
  if (hasMemoryTable && !hasReadableText) {
    db.exec("alter table memories add column readable_text text not null default ''");
  }
  db.exec(`
    update memories
    set readable_text = level || ' ' || type || ': ' || subject || ' ' || predicate || ' ' || object || char(10) || summary
    where readable_text = ''
  `);
}

function ensureIndexes(db: Database.Database): void {
  db.exec(`
    create index if not exists idx_memories_scope_status_level_type
      on memories (mis, source, agent, channel, status, level, type);
    create index if not exists idx_topic_segments_scope_session_status
      on topic_segments (mis, source, agent, channel, session_id, status);
    create index if not exists idx_project_build_runs_started_at
      on project_build_runs (started_at);
  `);
}

function recordMigration(db: Database.Database, version: number): void {
  db.prepare(
    "insert or ignore into schema_migrations (version, applied_at) values (?, ?)"
  ).run(version, new Date().toISOString());
}

function ensureTopicProjectMemoryColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(topic_segments)") as Array<{ name: string }>;
  const hasTopicTable = columns.length > 0;
  const hasProjectMemoryIds = columns.some((column) => column.name === "project_memory_ids");
  if (hasTopicTable && !hasProjectMemoryIds) {
    db.exec("alter table topic_segments add column project_memory_ids text not null default '[]'");
  }
  const hasSessionId = columns.some((column) => column.name === "session_id");
  if (hasTopicTable && !hasSessionId) {
    db.exec("alter table topic_segments add column session_id text not null default ''");
  }
}
