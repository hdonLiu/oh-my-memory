import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createMemoryService } from "../src/application/memory-service.js";
import { buildServer } from "../src/server.js";
import { createDatabase } from "../src/storage/database.js";
import { MemoryRepository } from "../src/storage/repositories.js";

const resources: Array<{ app: FastifyInstance; db: Database.Database }> = [];

afterEach(async () => {
  for (const { app, db } of resources.splice(0)) {
    await app.close();
    db.close();
  }
});

describe("HTTP API", () => {
  it("ingests by uid + agentId + externalSessionId and exposes no legacy identity aliases", async () => {
    const db = createDatabase(":memory:");
    const repository = new MemoryRepository(db);
    const app = buildServer(createMemoryService(repository), testAuth());
    resources.push({ app, db });

    const response = await app.inject({
      method: "POST",
      url: "/v1/turns",
      headers: { authorization: "Bearer token-u1" },
      payload: {
        agentId: "agent-a",
        externalSessionId: "external-1",
        eventId: "event-1",
        source: "web",
        channel: "main",
        role: "user",
        content: "你好"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().session.externalSessionId).toBe("external-1");

    const spoofedUid = await app.inject({
      method: "POST",
      url: "/v1/turns",
      headers: { authorization: "Bearer token-u1" },
      payload: {
        uid: "u2",
        agentId: "agent-a",
        externalSessionId: "external-1",
        eventId: "event-spoofed",
        source: "web",
        role: "user",
        content: "spoofed"
      }
    });
    expect(spoofedUid.statusCode).toBe(400);

    const legacy = await app.inject({
      method: "POST",
      url: "/turns",
      headers: { authorization: "Bearer token-u1" },
      payload: {
        uid: "u1",
        agent: "agent-a",
        sessionId: "external-1",
        eventId: "event-2",
        source: "web",
        channel: "main",
        role: "user",
        content: "legacy"
      }
    });
    expect(legacy.statusCode).toBe(404);
  });

  it("requires uid and agentId when resolving an external Session", async () => {
    const db = createDatabase(":memory:");
    const repository = new MemoryRepository(db);
    repository.resolveSession({
      uid: "u1",
      agentId: "agent-a",
      externalSessionId: "external-1",
      source: "web"
    });
    const app = buildServer(createMemoryService(repository), testAuth());
    resources.push({ app, db });

    const missingTenant = await app.inject({
      method: "GET",
      url: "/v1/sessions/external-1?agentId=agent-a"
    });
    expect(missingTenant.statusCode).toBe(401);
    const found = await app.inject({
      method: "GET",
      url: "/v1/sessions/external-1?agentId=agent-a",
      headers: { authorization: "Bearer token-u1" }
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().session.agentId).toBe("agent-a");

    const unauthorizedAgent = await app.inject({
      method: "GET",
      url: "/v1/sessions/external-1?agentId=agent-x",
      headers: { authorization: "Bearer token-u1" }
    });
    expect(unauthorizedAgent.statusCode).toBe(403);
  });
});

function testAuth() {
  return {
    async authenticate(authorization: string | undefined) {
      if (authorization !== "Bearer token-u1") throw new Error("unauthenticated");
      return { uid: "u1", agentIds: ["agent-a", "agent-b"] };
    }
  };
}
