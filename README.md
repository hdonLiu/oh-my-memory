# oh-my-memory

A local memory service for agents and personal tools.

oh-my-memory records conversation turns, groups them into topics, turns project topics into project memories, and keeps long-term memories searchable. It is meant to be embedded behind HTTP, CLI, SDK, MCP tools, or background import jobs.

## What It Does

- Stores raw conversation turns
- Groups related turns into topics
- Builds project memories from topics through an offline project run
- Keeps memories scoped by `mis / source / agent / channel`
- Searches active project and global memories
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

### Write a Turn

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

## Development

```bash
npm test
npm run typecheck
```

## Current Scope

Implemented:

- Local SQLite-backed memory service
- HTTP API
- CLI ingestion and batch import
- Memory search
- Memory status updates
- Offline topic-to-project memory extraction
- Optional embedding search
- Unit tests

Not included yet:

- Time Memory
- Production authentication
- Multi-tenant authorization
- Frontend management UI
- Production LLM evaluation

## Design Docs

Detailed architecture and implementation notes live under `docs/`.
