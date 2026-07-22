#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createRuntimeMemoryService } from "./application/memory-service.js";
import { createDatabase } from "./storage/database.js";
import { MemoryRepository } from "./storage/repositories.js";

const turnSchema = z.object({
  uid: z.string().min(1),
  agentId: z.string().min(1),
  externalSessionId: z.string().min(1),
  eventId: z.string().min(1),
  source: z.string().min(1),
  channel: z.string().min(1).nullable().optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({})
});

export interface CliResult { exitCode: number; stdout: string; stderr: string }

export async function runCli(argv: string[]): Promise<CliResult> {
  let db: ReturnType<typeof createDatabase> | undefined;
  try {
    const [command, ...args] = argv;
    const options = parseOptions(args);
    db = createDatabase(value(options, "db") ?? process.env.MEMORY_DB_PATH ?? "memory.sqlite");
    const service = createRuntimeMemoryService(new MemoryRepository(db));

    if (command === "ingest") {
      return ok(await service.ingestTurn(turnFromOptions(options)));
    }
    if (command === "import") {
      const file = options.positionals[0];
      if (!file) return fail("import requires a JSON file path");
      const records = z.array(turnSchema).parse(JSON.parse(readFileSync(file, "utf8")));
      const results = [];
      for (const record of records) results.push(await service.ingestTurn(record));
      return ok({ imported: results.length, results });
    }
    if (command === "flush") {
      return ok(service.flushSession(sessionIdentity(options)));
    }
    if (command === "topics") {
      return ok(service.listTopics(sessionIdentity(options)));
    }
    if (command === "recall") {
      return ok(await service.recall({
        uid: required(options, "uid"),
        agentId: required(options, "agent-id"),
        query: required(options, "query"),
        externalSessionId: value(options, "external-session-id")
      }));
    }
    return fail(
      "usage: oh-my-memory ingest|import|flush|topics|recall --uid <uid> --agent-id <agent> --external-session-id <session>"
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : "unknown error");
  } finally {
    db?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

interface ParsedOptions { values: Record<string, string>; positionals: string[] }

function parseOptions(args: string[]): ParsedOptions {
  const parsed: ParsedOptions = { values: {}, positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) { parsed.positionals.push(arg); continue; }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
    parsed.values[arg.slice(2)] = next;
    index += 1;
  }
  return parsed;
}

function turnFromOptions(options: ParsedOptions) {
  return turnSchema.parse({
    ...sessionIdentity(options),
    eventId: required(options, "event-id"),
    source: required(options, "source"),
    channel: value(options, "channel"),
    role: value(options, "role") ?? "user",
    content: required(options, "content"),
    metadata: value(options, "metadata") ? JSON.parse(value(options, "metadata")!) : {}
  });
}

function sessionIdentity(options: ParsedOptions) {
  return {
    uid: required(options, "uid"),
    agentId: required(options, "agent-id"),
    externalSessionId: required(options, "external-session-id")
  };
}
function value(options: ParsedOptions, key: string): string | undefined { return options.values[key]; }
function required(options: ParsedOptions, key: string): string {
  const result = value(options, key);
  if (!result) throw new Error(`missing required --${key}`);
  return result;
}
function ok(value: unknown): CliResult { return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" }; }
function fail(message: string): CliResult { return { exitCode: 1, stdout: "", stderr: `${message}\n` }; }
