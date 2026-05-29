import cors from "@fastify/cors";
import type Database from "better-sqlite3";
import Fastify from "fastify";
import { z } from "zod";
import { createMemoryService, type MemoryService } from "./application/memory-service.js";
import type { MemoryStatus, Role, Scope } from "./domain/types.js";
import { MemoryRepository } from "./storage/repositories.js";
import type { MemoryStore } from "./storage/store.js";

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

export function buildServer(storage: Database.Database | MemoryStore | MemoryService) {
  const app = Fastify({ logger: false });
  const service = isMemoryService(storage)
    ? storage
    : createMemoryService(isMemoryStore(storage) ? storage : new MemoryRepository(storage));

  app.register(cors);

  app.get("/health", async () => ({ ok: true }));

  app.post("/turns", async (request, reply) => {
    const parsed = turnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    return service.ingestTurn({
      sessionId: input.sessionId,
      role: input.role as Role,
      content: input.content,
      ...toScope(input)
    });
  });

  app.post("/search", async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.search({ ...parsed.data, metadata: parsed.data.metadata });
  });

  app.get("/memories", async (request) => {
    const query = request.query as Partial<Record<keyof Scope, string>>;
    return {
      ...service.listMemories({
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
      return service.updateMemory(params.id, patch);
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : "not found" });
    }
  });

  app.get("/memories/:id/relations", async (request) => {
    const params = request.params as { id: string };
    return service.listRelations(params.id);
  });

  app.post("/dreaming/run", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.runDreaming(toScope(parsed.data));
  });

  app.post("/projects/run", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.runProjectBuild(toScope(parsed.data));
  });

  return app;
}

function isMemoryService(value: Database.Database | MemoryStore | MemoryService): value is MemoryService {
  return (
    typeof (value as MemoryService).ingestTurn === "function" &&
    typeof (value as MemoryService).search === "function" &&
    typeof (value as MemoryService).runProjectBuild === "function" &&
    typeof (value as MemoryService).runDreaming === "function"
  );
}

function isMemoryStore(value: Database.Database | MemoryStore | MemoryService): value is MemoryStore {
  return (
    typeof (value as MemoryStore).createTurn === "function" &&
    typeof (value as MemoryStore).listMemories === "function" &&
    typeof (value as MemoryStore).createRelation === "function"
  );
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
