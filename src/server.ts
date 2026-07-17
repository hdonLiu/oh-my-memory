import cors from "@fastify/cors";
import type Database from "better-sqlite3";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { createMemoryService, type MemoryService } from "./application/memory-service.js";
import type { CorrectionStatus, MemoryStatus, Role, Scope, TopicStatus } from "./domain/types.js";
import { MemoryRepository } from "./storage/repositories.js";
import type { MemoryStore } from "./storage/store.js";

const scopeSchema = z.object({
  uid: z.string().min(1),
  source: z.string().min(1),
  agent: z.string().min(1),
  channel: z.string().min(1),
  metadata: z.record(z.unknown()).default({})
});

const turnSchema = scopeSchema.extend({
  eventId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1)
});

const searchSchema = scopeSchema.extend({
  query: z.string().min(1),
  includeInactive: z.boolean().optional(),
  limit: z.number().int().positive().optional()
});

const recallSchema = scopeSchema.extend({
  query: z.string().min(1),
  limit: z.number().int().positive().optional()
});

const patchSchema = z.object({
  status: z.enum(["active", "superseded", "deleted"]).optional(),
  summary: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});

const topicQuerySchema = z.object({
  uid: z.string().optional(),
  source: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  sessionId: z.string().optional(),
  status: z.enum(["complete", "partial", "noise"]).optional()
});

const projectQuerySchema = z.object({
  uid: z.string().optional(),
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

const l2RunSchema = z.object({
  uid: z.string().min(1),
  agent: z.string().min(1),
  watermark: z.number().int().nonnegative().optional()
});

const canonicalNamespaceSchema = z.object({
  uid: z.string().min(1),
  agent: z.string().min(1)
});

const correctionCreateSchema = z.object({
  eventId: z.string().min(1),
  uid: z.string().min(1),
  agent: z.string().min(1),
  source: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  targetType: z.enum(["turn", "l1_component", "l2_statement"]),
  targetId: z.string().min(1),
  targetRevisionId: z.string().min(1).nullable(),
  action: z.enum(["retract", "replace"]),
  correctedContent: z.string().min(1).nullable(),
  reason: z.string().min(1)
});

const correctionQuerySchema = z.object({
  uid: z.string().min(1),
  agent: z.string().min(1),
  status: z.enum(["pending_l1", "ready_l2", "applied"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional()
});

const layeredRecallSchema = z.object({
  uid: z.string().min(1),
  agent: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  sessionId: z.string().min(1).optional(),
  includeProvisional: z.boolean().optional()
});

export function buildServer(storage: Database.Database | MemoryStore | MemoryService) {
  const app = Fastify({ logger: false });
  const service = isMemoryService(storage)
    ? storage
    : createMemoryService(isMemoryStore(storage) ? storage : new MemoryRepository(storage));

  app.register(cors);

  app.get("/health", async () => ({ ok: true }));

  const ingestTurn = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = turnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    return service.ingestTurn({
      eventId: input.eventId,
      sessionId: input.sessionId,
      role: input.role as Role,
      content: input.content,
      ...toScope(input)
    });
  };
  app.post("/turns", ingestTurn);
  app.post("/v1/turns", ingestTurn);

  app.post("/sessions/:sessionId/topics/flush", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.flushSessionTopic(toScope(parsed.data), params.sessionId);
  });

  app.post("/v1/sessions/:sessionId/topics/flush", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return service.flushSessionTopic(toScope(parsed.data), params.sessionId);
  });

  app.post("/search", async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.search({ ...parsed.data, metadata: parsed.data.metadata });
  });

  app.post("/recall", async (request, reply) => {
    const parsed = recallSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return service.recall({ ...parsed.data, metadata: parsed.data.metadata });
  });

  app.get("/memories", async (request) => {
    const query = request.query as Partial<Record<keyof Scope, string>>;
    return {
      ...service.listMemories({
        uid: query.uid,
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
      uid: parsed.data.uid,
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
      uid: parsed.data.uid,
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

  app.get("/v1/l1/topics", async (request, reply) => {
    const parsed = z
      .object({
        uid: z.string().optional(),
        source: z.string().optional(),
        agent: z.string().optional(),
        channel: z.string().optional(),
        sessionId: z.string().optional(),
        includeInactive: z.coerce.boolean().optional()
      })
      .safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return { topics: service.listL1Topics({ ...parsed.data, metadata: {} }) };
  });

  app.post("/v1/jobs/l1-maintenance/run", async (request, reply) => {
    const parsed = scopeSchema.extend({ sessionId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { sessionId, ...scope } = parsed.data;
    return service.runL1Maintenance(toScope(scope), sessionId);
  });

  app.get("/v1/jobs/l1-maintenance/runs", async (request, reply) => {
    const parsed = projectRunQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return { runs: service.listL1MaintenanceRuns(parsed.data.limit) };
  });

  app.get("/v1/l2/aggregates", async (request, reply) => {
    const parsed = z
      .object({ uid: z.string().min(1), agent: z.string().min(1), includeInactive: z.coerce.boolean().optional() })
      .safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return { aggregates: service.listL2Aggregates(parsed.data.uid, parsed.data.agent, parsed.data.includeInactive) };
  });

  app.post("/v1/jobs/l2-aggregation/run", async (request, reply) => {
    const parsed = l2RunSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return service.runL2Aggregation(parsed.data.uid, parsed.data.agent, parsed.data.watermark);
  });

  app.get("/v1/jobs/l2-aggregation/runs", async (request, reply) => {
    const parsed = projectRunQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return { runs: service.listL2AggregationRuns(parsed.data.limit) };
  });

  app.get("/v1/l3/profiles", async (request, reply) => {
    const parsed = canonicalNamespaceSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return service.listL3Profiles(parsed.data.uid, parsed.data.agent);
  });

  app.post("/v1/jobs/l3-profile/run", async (request, reply) => {
    const parsed = canonicalNamespaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return service.runL3ProfileBuild(parsed.data.uid, parsed.data.agent);
  });

  app.post("/v1/corrections", async (request, reply) => {
    const parsed = correctionCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return service.createCorrection(parsed.data);
    } catch (error) {
      const mapped = mapCorrectionError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get("/v1/corrections", async (request, reply) => {
    const parsed = correctionQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return service.listCorrections({
      uid: parsed.data.uid,
      agent: parsed.data.agent,
      status: parsed.data.status as CorrectionStatus | undefined,
      limit: parsed.data.limit
    });
  });

  app.get("/v1/corrections/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = correctionQuerySchema.pick({ uid: true, agent: true }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const result = service.getCorrection(parsed.data.uid, parsed.data.agent, params.id);
    if (!result.correction) return reply.status(404).send({ error: "Correction not found" });
    return result;
  });

  app.post("/v1/recall", async (request, reply) => {
    const parsed = layeredRecallSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return service.recallV2(parsed.data);
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
    typeof (value as MemoryService).recall === "function" &&
    typeof (value as MemoryService).runProjectBuild === "function" &&
    typeof (value as MemoryService).runDreaming === "function" &&
    typeof (value as MemoryService).runL1Maintenance === "function" &&
    typeof (value as MemoryService).runL2Aggregation === "function"
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
    uid: input.uid,
    source: input.source,
    agent: input.agent,
    channel: input.channel,
    metadata: input.metadata
  };
}

function mapCorrectionError(error: unknown): { status: 400 | 404 | 409; body: { error: string; retryable?: boolean } } {
  const message = error instanceof Error ? error.message : "correction rejected";
  if (message === "Correction target not found") return { status: 404, body: { error: message } };
  if (message.includes("idempotency conflict")) return { status: 409, body: { error: message } };
  if (message.includes("stale")) return { status: 409, body: { error: message, retryable: true } };
  if (
    message.includes("requires") ||
    message.includes("rejects") ||
    message.includes("outside") ||
    message.includes("unknown") ||
    message.includes("out-of-scope")
  ) {
    return { status: 400, body: { error: message } };
  }
  return { status: 409, body: { error: message } };
}
