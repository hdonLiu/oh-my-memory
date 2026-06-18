# oh-my-memory

A local memory service for agents and personal tools.

oh-my-memory records conversation turns, groups them into topics, turns project topics into project memories, and keeps long-term memories searchable. It is meant to be embedded behind HTTP, CLI, SDK, MCP tools, or background import jobs.

## What It Does

- Stores raw conversation turns
- Groups session turns into topics with a streaming buffer
- Builds project memories from topics through an offline project run
- Keeps memories scoped by `mis / source / agent / channel`
- Searches active topic, project, and global memories
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
npm run dev
```

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
    "sessionId": "s1",
    "role": "user",
    "content": "项目 A 使用 MySQL",
    "mis": "u1",
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
    "sessionId": "s1",
    "role": "user",
    "content": "项目 A 已迁移到 PostgreSQL",
    "mis": "u1",
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
    "mis": "u1",
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
    "mis": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

### List Memories

```bash
curl -s 'http://localhost:3000/memories?mis=u1&source=local&agent=demo&channel=default'
```

### Inspect Topic Segments

Use this to debug the current open topic buffer or review closed topics.

```bash
curl -s 'http://localhost:3000/topics?mis=u1&source=local&agent=demo&channel=default&sessionId=s1&status=partial'
```

### Inspect Project Memories

Use this to review L2 project memories produced by manual or scheduled project extraction.

```bash
curl -s 'http://localhost:3000/projects?mis=u1&source=local&agent=demo&channel=default&status=active&projectType=repository'
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
    "mis": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

### Run Project Extraction

`POST /projects/run` runs the offline project-memory builder. It reads active topic memories and extracts stable project memories.

```bash
curl -s -X POST http://localhost:3000/projects/run \
  -H 'content-type: application/json' \
  -d '{
    "mis": "u1",
    "source": "local",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }'
```

## CLI Usage

### Ingest One Turn

```bash
oh-my-memory ingest \
  --db memory.sqlite \
  --session-id s1 \
  --role user \
  --content "项目 A 使用 MySQL" \
  --mis u1 \
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
    "sessionId": "s1",
    "role": "user",
    "content": "项目 A 已迁移到 PostgreSQL",
    "mis": "u1",
    "source": "cli",
    "agent": "demo",
    "channel": "default",
    "metadata": {}
  }
]
```

## Optional Embeddings

Lexical search works without model configuration.

To enable embedding-assisted search, configure an OpenAI-compatible embedding endpoint:

```bash
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

To enable offline project extraction, configure an OpenAI-compatible chat endpoint:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=...
```

Project extraction can also run as a background scheduled job:

```bash
PROJECT_BUILD_ENABLED=true
PROJECT_BUILD_INTERVAL_MS=300000
```

The job scans active topic memories, groups their scopes, and runs the L2 project builder for each scope.
Each scheduled run is recorded and can be inspected through `GET /projects/runs`.

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

L2 project evaluation fixtures live in `src/domain/project-eval-fixtures.ts`. They cover merging related topics, keeping distinct projects separate, preserving workflow projects, and excluding preference-only topics. Use `runProjectEvaluationFixtures` from `src/domain/project-eval-runner.ts` to score a project extractor against those fixtures.

## Current Scope

Implemented:

- Local SQLite-backed memory service
- HTTP API
- CLI ingestion and batch import
- Memory search
- Memory status updates
- LLM-assisted memory resolution with rule-based fallback
- Offline topic-to-project memory extraction
- Scheduled project build runs with run history
- L2 project debug and evaluation fixtures
- L3 dreaming with optional LLM compressor and rule-based fallback
- Optional embedding search
- Unit tests

Not included yet:

- Time Memory
- Production authentication
- Multi-tenant authorization
- Frontend management UI
- Production LLM evaluation harness

## Design Docs

Detailed architecture and implementation notes live under `docs/`.
