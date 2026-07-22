import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("direct legacy replacement migration", () => {
  it("preserves raw Turns, assigns internal Sessions, drops old derived tables, and marks rebuild dirty", () => {
    const path = legacyDatabase([
      { id: "t1", eventId: "e1", sessionId: "external-1", content: "first" },
      { id: "t2", eventId: "e2", sessionId: "external-1", content: "second" }
    ]);

    const db = createDatabase(path);
    const repository = new MemoryRepository(db);
    const session = repository.getSessionByExternal("u1", "agent-a", "external-1")!;

    expect(session.id).not.toBe("external-1");
    expect(repository.listTurns(session.id).map((turn) => turn.id)).toEqual(["t1", "t2"]);
    expect(repository.getRebuildJob("topic", session.id)?.status).toBe("dirty");
    expect(tableNames(db)).not.toContain("conversation_turns");
    expect(tableNames(db)).not.toContain("l1_topics");
    expect(tableNames(db)).toContain("topics");
    db.close();
  });

  it("fails instead of guessing when legacy event IDs conflict in the new tenant boundary", () => {
    const path = legacyDatabase([
      { id: "t1", eventId: "same", sessionId: "external-1", content: "first", source: "web" },
      { id: "t2", eventId: "same", sessionId: "external-2", content: "second", source: "slack" }
    ]);

    expect(() => createDatabase(path)).toThrow(/migration conflict/);
    const db = new Database(path);
    expect(tableNames(db)).toContain("conversation_turns");
    db.close();
  });
});

function legacyDatabase(
  turns: Array<{ id: string; eventId: string; sessionId: string; content: string; source?: string }>
): string {
  const directory = mkdtempSync(join(tmpdir(), "oh-my-memory-migration-"));
  directories.push(directory);
  const path = join(directory, "legacy.sqlite");
  const db = new Database(path);
  db.exec(`
    create table conversation_turns (
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
    create table l1_topics (id text primary key);
    create table l2_aggregates (id text primary key);
  `);
  const insert = db.prepare(
    `insert into conversation_turns
     (id, event_id, session_id, role, content, uid, source, agent, channel, metadata, created_at)
     values (?, ?, ?, 'user', ?, 'u1', ?, 'agent-a', 'main', '{}', ?)`
  );
  turns.forEach((turn, index) =>
    insert.run(turn.id, turn.eventId, turn.sessionId, turn.content, turn.source ?? "web", new Date(index).toISOString())
  );
  db.close();
  return path;
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}
