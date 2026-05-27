import cors from "@fastify/cors";
import type Database from "better-sqlite3";
import Fastify from "fastify";
import { z } from "zod";
import { runDreaming } from "./domain/dreaming.js";
import { extractMemories } from "./domain/extractor.js";
import { rebuildProjectMemories } from "./domain/project-memory.js";
import { resolveMemory } from "./domain/resolver.js";
import { searchMemories } from "./domain/search.js";
import type { MemoryStatus, Role, Scope } from "./domain/types.js";
import { MemoryRepository } from "./storage/repositories.js";

const scopeSchema = z.object({
  mis: z.string().min(1),
  source: z.string().min(1),
  agent: z.string().min(1),
  channel: z.string().min(1),
  metadata: z.record(z.unknown()).default({})
});

const turnSchema = scopeSchema.extend({
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1)
});

const searchSchema = scopeSchema.extend({
  query: z.string().min(1),
  includeInactive: z.boolean().optional(),
  limit: z.number().int().positive().optional()
});

const patchSchema = z.object({
  status: z.enum(["active", "superseded", "deleted"]).optional(),
  summary: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});

export function buildServer(db: Database.Database) {
  const app = Fastify({ logger: false });
  const repo = new MemoryRepository(db);

  app.register(cors);

  app.get("/health", async () => ({ ok: true }));

  app.post("/turns", async (request, reply) => {
    const parsed = turnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    const turn = repo.createTurn({
      sessionId: input.sessionId,
      role: input.role as Role,
      content: input.content,
      ...toScope(input)
    });
    const window = repo.recentTurns(toScope(input), 8);
    const memories = extractMemories(turn, window).map((draft) => resolveMemory(repo, draft));
    if (memories.length > 0) {
      rebuildProjectMemories(repo, toScope(input));
    }
    return { turn, memories };
  });

  app.post("/search", async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return { results: searchMemories(repo, { ...parsed.data, metadata: parsed.data.metadata }) };
  });

  app.get("/memories", async (request) => {
    const query = request.query as Partial<Record<keyof Scope, string>>;
    return {
      memories: repo.listMemories({
        mis: query.mis,
        source: query.source,
        agent: query.agent,
        channel: query.channel
      })
    };
  });

  app.patch("/memories/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const patch: { status?: MemoryStatus; summary?: string; confidence?: number } = parsed.data;
    try {
      return { memory: repo.updateMemory(params.id, patch) };
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : "not found" });
    }
  });

  app.get("/memories/:id/relations", async (request) => {
    const params = request.params as { id: string };
    return { relations: repo.listRelations(params.id) };
  });

  app.post("/dreaming/run", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return runDreaming(repo, toScope(parsed.data));
  });

  return app;
}

function toScope(input: z.infer<typeof scopeSchema>): Scope {
  return {
    mis: input.mis,
    source: input.source,
    agent: input.agent,
    channel: input.channel,
    metadata: input.metadata
  };
}
