import cors from "@fastify/cors";
import type Database from "better-sqlite3";
import Fastify from "fastify";
import { z } from "zod";
import { createMemoryService, type MemoryService } from "./application/memory-service.js";
import type { MemoryStatus, Role, Scope, TopicStatus } from "./domain/types.js";
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

const topicQuerySchema = z.object({
  mis: z.string().optional(),
  source: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  sessionId: z.string().optional(),
  status: z.enum(["complete", "partial", "noise"]).optional()
});

const projectQuerySchema = z.object({
  mis: z.string().optional(),
  source: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  status: z.enum(["active", "superseded", "deleted"]).optional(),
  projectType: z.string().optional(),
  projectKey: z.string().optional()
});

const projectRunQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional()
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

  app.post("/sessions/:sessionId/topics/flush", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.flushSessionTopic(toScope(parsed.data), params.sessionId);
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

  app.get("/topics", async (request, reply) => {
    const parsed = topicQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.listTopicSegments({
      mis: parsed.data.mis,
      source: parsed.data.source,
      agent: parsed.data.agent,
      channel: parsed.data.channel,
      sessionId: parsed.data.sessionId,
      status: parsed.data.status as TopicStatus | undefined
    });
  });

  app.get("/projects", async (request, reply) => {
    const parsed = projectQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.listProjectMemories({
      mis: parsed.data.mis,
      source: parsed.data.source,
      agent: parsed.data.agent,
      channel: parsed.data.channel,
      status: parsed.data.status,
      projectType: parsed.data.projectType,
      projectKey: parsed.data.projectKey
    });
  });

  app.get("/projects/runs", async (request, reply) => {
    const parsed = projectRunQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.listProjectBuildRuns(parsed.data.limit);
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
    typeof (value as MemoryService).flushSessionTopic === "function" &&
    typeof (value as MemoryService).listTopicSegments === "function" &&
    typeof (value as MemoryService).listProjectMemories === "function" &&
    typeof (value as MemoryService).listProjectBuildRuns === "function" &&
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
