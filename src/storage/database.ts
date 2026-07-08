import Database from "better-sqlite3";

export function createDatabase(path = process.env.MEMORY_DB_PATH ?? "memory.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists conversation_turns (
      id text primary key,
      event_id text,
      session_id text not null,
      role text not null,
      content text not null,
      uid text not null,
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
      uid text not null,
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
      uid text not null,
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

    create table if not exists l1_topics (
      id text primary key,
      session_id text not null,
      status text not null,
      current_revision_id text not null,
      uid text not null,
      source text not null,
      agent text not null,
      channel text not null,
      metadata text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists l1_topic_revisions (
      id text primary key,
      topic_id text not null,
      version integer not null,
      status text not null,
      title text not null,
      summary text not null,
      source_turn_ids text not null,
      source_segment_id text,
      stable_sequence integer,
      provider text,
      model text,
      prompt_version text not null,
      schema_version text not null,
      reason text not null,
      confidence real not null,
      created_at text not null,
      unique(topic_id, version),
      unique(source_segment_id)
    );

    create table if not exists l1_components (
      id text primary key,
      topic_revision_id text not null,
      content text not null,
      labels text not null,
      evidence_turn_ids text not null,
      provider text,
      model text,
      prompt_version text not null,
      schema_version text not null,
      reason text not null,
      confidence real not null,
      created_at text not null
    );

    create table if not exists l1_topic_lineage (
      id text primary key,
      from_topic_id text not null,
      to_topic_id text,
      operation text not null,
      run_id text not null,
      reason text not null,
      created_at text not null
    );

    create table if not exists l1_maintenance_runs (
      id text primary key,
      idempotency_key text unique,
      uid text not null,
      source text not null,
      agent text not null,
      channel text not null,
      session_id text not null,
      input_cutoff text not null,
      output_watermark integer,
      status text not null,
      plan text,
      error text,
      started_at text not null,
      ended_at text
    );

    create table if not exists l1_stable_sequence (
      sequence integer primary key autoincrement,
      topic_revision_id text not null unique,
      run_id text not null,
      uid text not null,
      agent text not null,
      created_at text not null
    );

    create table if not exists l2_aggregates (
      id text primary key,
      uid text not null,
      agent text not null,
      status text not null,
      current_revision_id text not null,
      merged_into_id text,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists l2_aggregate_revisions (
      id text primary key,
      aggregate_id text not null,
      version integer not null,
      aggregate_type text not null,
      canonical_title text not null,
      aliases text not null,
      external_keys text not null,
      labels text not null,
      summary text not null,
      facts text not null,
      decisions text not null,
      constraints text not null,
      open_questions text not null,
      source_l1_watermark integer not null,
      provider text,
      model text,
      prompt_version text not null,
      schema_version text not null,
      reason text not null,
      confidence real not null,
      created_at text not null,
      unique(aggregate_id, version)
    );

    create table if not exists l2_component_memberships (
      aggregate_revision_id text not null,
      component_id text not null,
      aggregation_run_id text not null,
      created_at text not null,
      primary key(aggregate_revision_id, component_id)
    );

    create table if not exists l2_aggregate_lineage (
      id text primary key,
      from_aggregate_id text not null,
      to_aggregate_id text,
      operation text not null,
      run_id text not null,
      reason text not null,
      created_at text not null
    );

    create table if not exists l2_aggregation_runs (
      id text primary key,
      idempotency_key text unique,
      uid text not null,
      agent text not null,
      source_l1_watermark integer not null,
      status text not null,
      plan text,
      error text,
      started_at text not null,
      ended_at text
    );
  `);
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  ensureUidColumns(db);
  ensureTurnEventId(db);
  ensureRunIdempotencyColumns(db);
  ensureReconciliationRunColumns(db);
  ensureL2RevisionIdentityColumns(db);
  ensureTopicProjectMemoryColumn(db);
  ensureReadableMemoryColumn(db);
  ensureGovernanceSchema(db);
  ensureIndexes(db);
  recordMigration(db, 1);
  recordMigration(db, 2);
  recordMigration(db, 3);
}

function ensureL2RevisionIdentityColumns(db: Database.Database): void {
  const columns = db.pragma("table_info(l2_aggregate_revisions)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "aggregate_type")) {
    db.exec("alter table l2_aggregate_revisions add column aggregate_type text not null default 'topic'");
  }
  if (!columns.some((column) => column.name === "external_keys")) {
    db.exec("alter table l2_aggregate_revisions add column external_keys text not null default '{}'");
  }
}

function ensureRunIdempotencyColumns(db: Database.Database): void {
  for (const table of ["l1_maintenance_runs", "l2_aggregation_runs"] as const) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "idempotency_key")) {
      db.exec(`alter table ${table} add column idempotency_key text`);
    }
    db.exec(`create unique index if not exists idx_${table}_idempotency on ${table} (idempotency_key)`);
  }
}

function ensureUidColumns(db: Database.Database): void {
  for (const table of ["conversation_turns", "memories", "topic_segments"] as const) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (columns.some((column) => column.name === "mis") && !columns.some((column) => column.name === "uid")) {
      db.exec(`alter table ${table} rename column mis to uid`);
    }
  }
}

function ensureTurnEventId(db: Database.Database): void {
  const columns = db.pragma("table_info(conversation_turns)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "event_id")) {
    db.exec("alter table conversation_turns add column event_id text");
  }
  db.exec("update conversation_turns set event_id = id where event_id is null or event_id = ''");
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

function ensureReconciliationRunColumns(db: Database.Database): void {
  const l1Columns = db.pragma("table_info(l1_maintenance_runs)") as Array<{ name: string }>;
  for (const [name, ddl] of [
    ["input_snapshot_hash", "alter table l1_maintenance_runs add column input_snapshot_hash text"],
    ["run_mode", "alter table l1_maintenance_runs add column run_mode text not null default 'incremental'"],
    ["caller_idempotency_key", "alter table l1_maintenance_runs add column caller_idempotency_key text"],
    ["prompt_version", "alter table l1_maintenance_runs add column prompt_version text"],
    ["schema_version", "alter table l1_maintenance_runs add column schema_version text"]
  ] as const) {
    if (!l1Columns.some((column) => column.name === name)) db.exec(ddl);
  }

  const l2Columns = db.pragma("table_info(l2_aggregation_runs)") as Array<{ name: string }>;
  for (const [name, ddl] of [
    ["source_governance_watermark", "alter table l2_aggregation_runs add column source_governance_watermark integer not null default 0"],
    ["input_snapshot_hash", "alter table l2_aggregation_runs add column input_snapshot_hash text"],
    ["run_mode", "alter table l2_aggregation_runs add column run_mode text not null default 'incremental'"],
    ["caller_idempotency_key", "alter table l2_aggregation_runs add column caller_idempotency_key text"],
    ["prompt_version", "alter table l2_aggregation_runs add column prompt_version text"],
    ["schema_version", "alter table l2_aggregation_runs add column schema_version text"],
    ["context_expansion_rounds", "alter table l2_aggregation_runs add column context_expansion_rounds integer not null default 0"],
    ["context_request_json", "alter table l2_aggregation_runs add column context_request_json text"]
  ] as const) {
    if (!l2Columns.some((column) => column.name === name)) db.exec(ddl);
  }
}

function ensureGovernanceSchema(db: Database.Database): void {
  const componentColumns = db.pragma("table_info(l1_components)") as Array<{ name: string }>;
  if (!componentColumns.some((column) => column.name === "evidence_authority")) {
    db.exec("alter table l1_components add column evidence_authority text not null default 'conversation'");
  }
  if (!componentColumns.some((column) => column.name === "evidence_correction_ids")) {
    db.exec("alter table l1_components add column evidence_correction_ids text not null default '[]'");
  }
  db.exec(`
    create table if not exists namespace_changes (
      sequence integer primary key autoincrement,
      uid text not null,
      agent text not null,
      kind text not null,
      entity_type text not null,
      entity_id text not null,
      correction_id text,
      created_at text not null
    );

    create table if not exists correction_records (
      id text primary key,
      event_id text not null,
      payload_hash text not null,
      uid text not null,
      agent text not null,
      target_type text not null,
      target_id text not null,
      target_revision_id text,
      action text not null,
      corrected_content text,
      reason text not null,
      authority text not null,
      status text not null,
      affected_source text,
      affected_channel text,
      affected_session_id text,
      created_sequence integer not null,
      ready_sequence integer,
      applied_sequence integer,
      error text,
      created_at text not null,
      updated_at text not null,
      applied_at text,
      unique(uid, agent, event_id)
    );

    create table if not exists statement_lineage_edges (
      id text primary key,
      uid text not null,
      agent text not null,
      from_revision_id text not null,
      from_statement_id text not null,
      to_revision_id text,
      to_statement_id text,
      operation text not null,
      created_at text not null
    );

    create table if not exists l2_checkpoints (
      uid text not null,
      agent text not null,
      l1_stable_watermark integer not null,
      governance_watermark integer not null,
      run_id text not null,
      prompt_version text not null,
      schema_version text not null,
      updated_at text not null,
      primary key(uid, agent)
    );
  `);
}

function ensureIndexes(db: Database.Database): void {
  db.exec(`
    create index if not exists idx_memories_scope_status_level_type
      on memories (uid, source, agent, channel, status, level, type);
    create index if not exists idx_topic_segments_scope_session_status
      on topic_segments (uid, source, agent, channel, session_id, status);
    create index if not exists idx_project_build_runs_started_at
      on project_build_runs (started_at);
    create unique index if not exists idx_turns_uid_source_event
      on conversation_turns (uid, source, event_id);
    create index if not exists idx_l1_topics_scope_session_status
      on l1_topics (uid, source, agent, channel, session_id, status);
    create index if not exists idx_l1_revisions_topic_status
      on l1_topic_revisions (topic_id, status, version);
    create index if not exists idx_l1_components_revision
      on l1_components (topic_revision_id);
    create index if not exists idx_l1_runs_scope_session
      on l1_maintenance_runs (uid, source, agent, channel, session_id, started_at);
    create index if not exists idx_l1_stable_namespace
      on l1_stable_sequence (uid, agent, sequence);
    create index if not exists idx_l2_aggregates_namespace_status
      on l2_aggregates (uid, agent, status);
    create index if not exists idx_l2_revisions_aggregate
      on l2_aggregate_revisions (aggregate_id, version);
    create index if not exists idx_l2_memberships_component
      on l2_component_memberships (component_id);
    create index if not exists idx_l2_runs_namespace
      on l2_aggregation_runs (uid, agent, started_at);
    create index if not exists idx_l1_runs_success_snapshot
      on l1_maintenance_runs (uid, source, agent, channel, session_id, status, input_snapshot_hash);
    create index if not exists idx_l2_runs_success_snapshot
      on l2_aggregation_runs (uid, agent, status, input_snapshot_hash);
    create index if not exists idx_corrections_status_created
      on correction_records (uid, agent, status, created_sequence);
    create index if not exists idx_corrections_status_ready
      on correction_records (uid, agent, status, ready_sequence);
    create index if not exists idx_corrections_l1_scope
      on correction_records (uid, affected_source, agent, affected_channel, affected_session_id, status);
    create index if not exists idx_corrections_target_namespace
      on correction_records (uid, agent, target_type, target_id);
    create index if not exists idx_namespace_changes_namespace_sequence
      on namespace_changes (uid, agent, sequence);
    create index if not exists idx_statement_lineage_from
      on statement_lineage_edges (uid, agent, from_revision_id, from_statement_id);
    create index if not exists idx_statement_lineage_to
      on statement_lineage_edges (uid, agent, to_revision_id, to_statement_id);
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
