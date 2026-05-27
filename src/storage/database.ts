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

    create table if not exists memory_relations (
      id text primary key,
      from_memory_id text not null,
      to_memory_id text not null,
      relation_type text not null,
      confidence real not null,
      created_at text not null
    );
  `);
  return db;
}
