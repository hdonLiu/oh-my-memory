#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createMemoryService } from "./application/memory-service.js";
import type { CreateTurnInput, Role } from "./domain/types.js";
import { createDatabase } from "./storage/database.js";
import { SqliteMemoryStore } from "./storage/sqlite-store.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: string[]): Promise<CliResult> {
  try {
    const [command, ...args] = argv;
    if (command === "ingest") {
      const parsed = parseOptions(args);
      const dbPath = getOption(parsed, "db") ?? process.env.MEMORY_DB_PATH ?? "memory.sqlite";
      const input = turnFromOptions(parsed);
      const service = createMemoryService(new SqliteMemoryStore(createDatabase(dbPath)));
      const result = await service.ingestTurn(input);
      const flushed = await service.flushSessionTopic(toScope(input), input.sessionId);
      const provisionalL1 = service.listL1Topics({
        uid: input.uid,
        source: input.source,
        agent: input.agent,
        channel: input.channel,
        sessionId: input.sessionId
      });
      return ok({ turn: result.turn, topic: flushed.topic, provisionalL1, memories: flushed.memories });
    }

    if (command === "import") {
      const parsed = parseOptions(args);
      const dbPath = getOption(parsed, "db") ?? process.env.MEMORY_DB_PATH ?? "memory.sqlite";
      const file = parsed.positionals[0];
      if (!file) {
        return fail("import requires a JSON file path");
      }
      const records = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(records)) {
        return fail("import file must contain a JSON array");
      }
      const service = createMemoryService(new SqliteMemoryStore(createDatabase(dbPath)));
      let success = 0;
      const failures: Array<{ index: number; error: string }> = [];
      const sessionsToFlush = new Map<string, CreateTurnInput>();
      for (const [index, record] of records.entries()) {
        try {
          const input = validateTurn(record);
          await service.ingestTurn(input);
          sessionsToFlush.set(sessionFlushKey(input), input);
          success += 1;
        } catch (error) {
          failures.push({ index, error: error instanceof Error ? error.message : "unknown error" });
        }
      }
      for (const input of sessionsToFlush.values()) {
        await service.flushSessionTopic(toScope(input), input.sessionId);
      }
      return {
        exitCode: failures.length > 0 ? 1 : 0,
        stdout: `${JSON.stringify({ success, failed: failures.length, failures })}\n`,
        stderr: ""
      };
    }

    return fail("usage: oh-my-memory ingest --content <text> ... | oh-my-memory import <file>");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "unknown error");
  }
}

function toScope(input: CreateTurnInput): Omit<CreateTurnInput, "sessionId" | "role" | "content"> {
  return {
    uid: input.uid,
    source: input.source,
    agent: input.agent,
    channel: input.channel,
    metadata: input.metadata
  };
}

function sessionFlushKey(input: CreateTurnInput): string {
  return [input.uid, input.source, input.agent, input.channel, input.sessionId].join("\0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

interface ParsedOptions {
  values: Record<string, string>;
  positionals: string[];
}

function parseOptions(args: string[]): ParsedOptions {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for --${key}`);
      }
      values[key] = value;
      index += 1;
    } else {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

function turnFromOptions(options: ParsedOptions): CreateTurnInput {
  return validateTurn({
    sessionId: getRequiredOption(options, "session-id"),
    eventId: getOption(options, "event-id"),
    role: getOption(options, "role") ?? "user",
    content: getRequiredOption(options, "content"),
    uid: getRequiredOption(options, "uid"),
    source: getRequiredOption(options, "source"),
    agent: getRequiredOption(options, "agent"),
    channel: getRequiredOption(options, "channel"),
    metadata: parseMetadata(getOption(options, "metadata"))
  });
}

function validateTurn(value: unknown): CreateTurnInput {
  const input = value as Partial<CreateTurnInput>;
  if (!input.sessionId || !input.role || !input.content || !input.uid || !input.source || !input.agent || !input.channel) {
    throw new Error("turn requires sessionId, role, content, uid, source, agent, and channel");
  }
  if (!["user", "assistant", "system"].includes(input.role)) {
    throw new Error(`invalid role: ${input.role}`);
  }
  return {
    sessionId: input.sessionId,
    eventId: input.eventId,
    role: input.role as Role,
    content: input.content,
    uid: input.uid,
    source: input.source,
    agent: input.agent,
    channel: input.channel,
    metadata: input.metadata ?? {}
  };
}

function parseMetadata(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--metadata must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function getOption(options: ParsedOptions, key: string): string | undefined {
  return options.values[key];
}

function getRequiredOption(options: ParsedOptions, key: string): string {
  const value = getOption(options, key);
  if (!value) {
    throw new Error(`missing required --${key}`);
  }
  return value;
}

function ok(value: unknown): CliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function fail(message: string): CliResult {
  return { exitCode: 1, stdout: "", stderr: `${message}\n` };
}
