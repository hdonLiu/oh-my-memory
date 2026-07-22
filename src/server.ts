import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { MemoryService } from "./application/memory-service.js";
import {
  EnvironmentBearerAuthenticationProvider,
  type AuthenticationProvider
} from "./auth.js";

const agentSchema = z.object({ agentId: z.string().min(1) }).strict();
const sessionAgentSchema = agentSchema.extend({ externalSessionId: z.string().min(1) }).strict();
const turnSchema = sessionAgentSchema
  .extend({
    eventId: z.string().min(1),
    source: z.string().min(1),
    channel: z.string().min(1).nullable().optional(),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().min(1),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();
const spaceSchema = agentSchema.extend({ name: z.string().min(1) }).strict();
const memberSchema = agentSchema.extend({ memberAgentId: z.string().min(1) }).strict();
const recallSchema = agentSchema
  .extend({ query: z.string().min(1), externalSessionId: z.string().min(1).optional() })
  .strict();
const correctionSchema = agentSchema
  .extend({
    targetTurnId: z.string().min(1),
    correctedContent: z.string().min(1).nullable(),
    reason: z.string().min(1)
  })
  .strict();

export function buildServer(
  service: MemoryService,
  authentication: AuthenticationProvider = new EnvironmentBearerAuthenticationProvider()
) {
  const app = Fastify({ logger: false });
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.register(cors, { origin: allowedOrigins.length > 0 ? allowedOrigins : false });

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/turns", async (request, reply) => {
    const input = parse(turnSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return service.ingestTurn({ ...input, uid: tenant.uid });
  });

  app.get("/v1/sessions/:externalSessionId", async (request, reply) => {
    const input = parse(agentSchema, request.query, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.getSession({
        uid: tenant.uid,
        agentId: input.agentId,
        externalSessionId: (request.params as { externalSessionId: string }).externalSessionId
      })
    );
  });

  app.get("/v1/sessions/:externalSessionId/topics", async (request, reply) => {
    const input = parse(agentSchema, request.query, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.listTopics({
        uid: tenant.uid,
        agentId: input.agentId,
        externalSessionId: (request.params as { externalSessionId: string }).externalSessionId
      })
    );
  });

  app.post("/v1/sessions/:externalSessionId/topics/flush", async (request, reply) => {
    const input = parse(agentSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.flushSession({
        uid: tenant.uid,
        agentId: input.agentId,
        externalSessionId: (request.params as { externalSessionId: string }).externalSessionId
      })
    );
  });

  app.post("/v1/sessions/:externalSessionId/topics/rebuild", async (request, reply) => {
    const input = parse(agentSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.maintainTopics({
        uid: tenant.uid,
        agentId: input.agentId,
        externalSessionId: (request.params as { externalSessionId: string }).externalSessionId
      })
    );
  });

  app.get("/v1/memory-spaces", async (request, reply) => {
    const input = parse(agentSchema, request.query, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return service.listSpaces({ uid: tenant.uid, agentId: input.agentId });
  });

  app.post("/v1/memory-spaces", async (request, reply) => {
    const input = parse(spaceSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return service.createSharedSpace({ uid: tenant.uid, agentId: input.agentId, name: input.name });
  });

  app.post("/v1/memory-spaces/:memorySpaceId/members", async (request, reply) => {
    const input = parse(memberSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    if (!tenant.agentIds.includes(input.memberAgentId)) {
      return reply.status(403).send({ error: "memberAgentId is not authorized for the authenticated uid" });
    }
    return call(reply, () =>
      service.addSpaceMember({
        uid: tenant.uid,
        agentId: input.agentId,
        memberAgentId: input.memberAgentId,
        memorySpaceId: (request.params as { memorySpaceId: string }).memorySpaceId
      })
    );
  });

  app.get("/v1/memory-spaces/:memorySpaceId/l2", async (request, reply) => {
    const input = parse(agentSchema, request.query, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.listL2({
        uid: tenant.uid,
        agentId: input.agentId,
        memorySpaceId: (request.params as { memorySpaceId: string }).memorySpaceId
      })
    );
  });

  app.post("/v1/memory-spaces/:memorySpaceId/l2/rebuild", async (request, reply) => {
    const input = parse(agentSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.rebuildL2({
        uid: tenant.uid,
        agentId: input.agentId,
        memorySpaceId: (request.params as { memorySpaceId: string }).memorySpaceId
      })
    );
  });

  app.get("/v1/memory-spaces/:memorySpaceId/l3", async (request, reply) => {
    const input = parse(agentSchema, request.query, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.listL3({
        uid: tenant.uid,
        agentId: input.agentId,
        memorySpaceId: (request.params as { memorySpaceId: string }).memorySpaceId
      })
    );
  });

  app.post("/v1/memory-spaces/:memorySpaceId/l3/rebuild", async (request, reply) => {
    const input = parse(agentSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () =>
      service.rebuildL3({
        uid: tenant.uid,
        agentId: input.agentId,
        memorySpaceId: (request.params as { memorySpaceId: string }).memorySpaceId
      })
    );
  });

  app.post("/v1/recall", async (request, reply) => {
    const input = parse(recallSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () => service.recall({ ...input, uid: tenant.uid }));
  });

  app.post("/v1/corrections", async (request, reply) => {
    const input = parse(correctionSchema, request.body, reply);
    if (!input) return;
    const tenant = await authorize(authentication, request, input.agentId, reply);
    if (!tenant) return;
    return call(reply, () => service.correctTurn({ ...input, uid: tenant.uid }));
  });

  return app;
}

async function authorize(
  provider: AuthenticationProvider,
  request: FastifyRequest,
  agentId: string,
  reply: FastifyReply
) {
  try {
    const context = await provider.authenticate(request.headers.authorization);
    if (!context.agentIds.includes(agentId)) {
      void reply.status(403).send({ error: "agentId is not authorized for the authenticated uid" });
      return null;
    }
    return context;
  } catch {
    void reply.status(401).send({ error: "unauthenticated" });
    return null;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  void reply.status(400).send({ error: parsed.error.flatten() });
  return null;
}

async function call(reply: FastifyReply, operation: () => unknown | Promise<unknown>) {
  try {
    return await operation();
  } catch (error) {
    return sendServiceError(reply, error);
  }
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error";
  const status = /not found/i.test(message)
    ? 404
    : /not authorized|same uid|tenant/i.test(message)
      ? 403
      : /Model is required/.test(message)
        ? 503
        : 400;
  return reply.status(status).send({ error: message });
}
