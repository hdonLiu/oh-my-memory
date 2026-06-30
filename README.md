# oh-my-memory

A local, LLM-first layered memory service for agents and personal tools.

oh-my-memory records conversation turns, creates session-scoped L1 Topics online, maintains fine-grained L1 Components offline, and aggregates stable Components into cross-session L2 knowledge. It is meant to be embedded behind HTTP, CLI, SDK, MCP tools, or background jobs.

## What It Does

- Stores raw conversation turns
- Groups session turns into provisional L1 Topics with a streaming buffer
- Maintains canonical L1 Topic revisions and evidenced Components through an offline job
- Builds cross-session L2 knowledge through a two-phase membership and synthesis job
- Keeps L1 scoped by `uid / source / agent / channel / session`
- Keeps L2 isolated by `uid + agent` while aggregating across source, channel, and session
- Recalls from L2 down to Components, Topic revisions, and original Turns
- Supports local SQLite persistence
- Supports CLI and HTTP ingestion
- Supports optional embedding-based search

## When To Use It

Use oh-my-memory when you want an agent or local tool to remember things like:

```text
Project A moved from MySQL to PostgreSQL
The user prefers TypeScript
This task should not include Time Memory
Project B uses SQLite
```

It is currently a local prototype, not a production multi-tenant memory platform.

## Quick Start

```bash
npm install
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_API_KEY=... \
LLM_MODEL=... \
npm run dev
```

The semantic runtime requires an OpenAI-compatible chat endpoint. Embeddings remain optional.

Default server:

```text
http://localhost:3000
```

Use a custom port or database path:

```bash
PORT=3001 MEMORY_DB_PATH=memory.sqlite npm run dev
```

## HTTP Usage

### Health Check

```bash
curl -s http://localhost:3000/health
```

### Ingest Turns

`POST /turns` appends one conversation turn to a session. The service keeps an open topic buffer and closes it when a topic boundary is detected or the configured maximum window is reached.

```bash
curl -s http://localhost:3000/turns \
  -H 'content-type: application/json' \
  -d '{
    "eventId": "chat:s1:turn:1",
    "sessionId": "s1",
    "role": "user",
    "content": "项目 A 使用 MySQL",
    "uid": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

Write an updated fact:

```bash
curl -s http://localhost:3000/turns \
  -H 'content-type: application/json' \
  -d '{
    "eventId": "chat:s1:turn:2",
    "sessionId": "s1",
    "role": "user",
    "content": "项目 A 已迁移到 PostgreSQL",
    "uid": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

### Flush a Session Topic

Use this when a chat/session ends and you want the latest open topic to become searchable immediately.

```bash
curl -s -X POST http://localhost:3000/sessions/s1/topics/flush \
  -H 'content-type: application/json' \
  -d '{
    "uid": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

### Search Memories

```bash
curl -s http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{
    "query": "项目 A 数据库",
    "uid": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

### List Memories

```bash
curl -s 'http://localhost:3000/memories?uid=u1&source=local&agent=demo&channel=default'
```

### Inspect Topic Segments

Use this to debug the current open topic buffer or review closed topics.

```bash
curl -s 'http://localhost:3000/topics?uid=u1&source=local&agent=demo&channel=default&sessionId=s1&status=partial'
```

### Inspect Project Memories

This is a legacy compatibility endpoint for project-only L2 memories. New code should use the v2 L2 aggregate APIs below.

```bash
curl -s 'http://localhost:3000/projects?uid=u1&source=local&agent=demo&channel=default&status=active&projectType=repository'
```

### Update Memory Status

```bash
curl -s -X PATCH http://localhost:3000/memories/<memory-id> \
  -H 'content-type: application/json' \
  -d '{ "status": "deleted" }'
```

### List Memory Relations

```bash
curl -s http://localhost:3000/memories/<memory-id>/relations
```

### Run Dreaming

```bash
curl -s -X POST http://localhost:3000/dreaming/run \
  -H 'content-type: application/json' \
  -d '{
    "uid": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

### Run Project Extraction

`POST /projects/run` is the legacy project-only builder. It remains available during migration to the v2 L2 pipeline.

```bash
curl -s -X POST http://localhost:3000/projects/run \
  -H 'content-type: application/json' \
  -d '{
    "uid": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

### Run Offline L1 Maintenance

```bash
curl -s -X POST http://localhost:3000/v1/jobs/l1-maintenance/run \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "s1",
    "uid": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

The job turns provisional Topics into canonical Topic revisions and evidenced Components. It never combines different sessions.

### Run Offline L2 Aggregation

```bash
curl -s -X POST http://localhost:3000/v1/jobs/l2-aggregation/run \
  -H 'content-type: application/json' \
  -d '{ "uid": "u1", "agent": "demo" }'
```

The job first plans Component membership, then synthesizes immutable L2 revisions from the validated members.

### Layered Recall

```bash
curl -s -X POST http://localhost:3000/v1/recall \
  -H 'content-type: application/json' \
  -d '{ "uid": "u1", "agent": "demo", "query": "项目 A 当前架构" }'
```

Inspect current layered state and run history through:

```text
GET /v1/l1/topics
GET /v1/l2/aggregates
GET /v1/jobs/l1-maintenance/runs
GET /v1/jobs/l2-aggregation/runs
```

## CLI Usage

### Ingest One Turn

```bash
oh-my-memory ingest \
  --db memory.sqlite \
  --event-id chat:s1:turn:1 \
  --session-id s1 \
  --role user \
  --content "项目 A 使用 MySQL" \
  --uid u1 \
  --source cli \
  --agent demo \
  --channel default
```

### Import a Batch

```bash
oh-my-memory import --db memory.sqlite conversations.json
```

Input file:

```json
[
  {
    "eventId": "cli:s1:turn:1",
    "sessionId": "s1",
    "role": "user",
    "content": "项目 A 已迁移到 PostgreSQL",
    "uid": "u1",
    "source": "cli",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }
]
```

## Model and Scheduler Configuration

The server requires an OpenAI-compatible chat model for Topic and offline semantic operations:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=...
```

To additionally enable embedding-assisted search, configure an OpenAI-compatible embedding endpoint:

```bash
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

The independent offline jobs can run on schedules:

```bash
L1_MAINTENANCE_ENABLED=true
L1_MAINTENANCE_INTERVAL_MS=60000
L2_AGGREGATION_ENABLED=true
L2_AGGREGATION_INTERVAL_MS=300000
```

L1 and L2 schedules are independent. L2 reads only successful canonical L1 checkpoints; an L1 write does not directly trigger L2.

Topic buffering can be tuned with:

```bash
TOPIC_BUFFER_MAX_TURNS=24
TOPIC_BOUNDARY_CONFIDENCE=0.7
TOPIC_BOUNDARY_EXCLUDE_LAST_TURN=true
TOPIC_BOUNDARY_EXCLUDE_THRESHOLD=10
```

## Development

```bash
npm test
npm run typecheck
```

The test suite covers the legacy compatibility surface and the v2 layered pipeline, including `uid` migration, Turn idempotency, provisional/canonical L1 revisions, Component evidence, L2 membership, immutable revisions, checkpoints, and layered recall.

## Current Scope

Implemented:

- Local SQLite-backed memory service
- HTTP API
- CLI ingestion and batch import
- `uid`-based scope and idempotent Turn ingestion
- Online append-only provisional L1 Topics
- Offline L1 maintenance contracts, canonical revisions, Components, lineage, runs, and checkpoints
- Two-phase offline L2 membership planning and revision synthesis
- Open L2 aggregate types and external identity keys maintained by the LLM
- L2 statement-to-Component evidence validation
- Independent L1/L2 schedulers and run history
- Hierarchical L2/Component/Topic/Turn recall results
- Legacy project and Dreaming compatibility APIs
- Optional embedding search
- SQLite migration from legacy `mis` columns
- Unit and integration tests

Not included yet:

- Time Memory
- Production authentication
- Multi-tenant authorization
- Frontend management UI
- Production LLM evaluation harness
- Full L3 v2 lifecycle and promotion policy
- Multi-node workers and distributed locking

## Design Docs

Current target architecture: [`docs/architecture/oh-my-memory-architecture-v2.md`](docs/architecture/oh-my-memory-architecture-v2.md).

Binding pipeline decision: [`docs/architecture/0001-three-stage-memory-pipeline.md`](docs/architecture/0001-three-stage-memory-pipeline.md).

Production backlog: [`docs/roadmaps/2026-06-29-production-readiness.md`](docs/roadmaps/2026-06-29-production-readiness.md).

Documents under `docs/superpowers/` and the 2026-05-28 roadmap are historical records rather than the current architecture contract.
