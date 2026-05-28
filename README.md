# oh-my-memory

A local Memory service prototype.

oh-my-memory treats memory as an evolving fact system, not just a vector search index. On write, it extracts and evolves memories. Offline, it compresses and promotes stable knowledge. On search, it performs multi-level retrieval and filters stale facts.

## Features

- L0: stores raw conversation turns
- L1: extracts atomic memory units
- L2: aggregates project/topic memories
- L3: promotes long-term profile memories through Dreaming
- Supports `active / superseded / deleted` memory states
- Supports `supersedesId` version chains
- Supports memory relations: `duplicate / update / contradict / support / related`
- Supports scope isolation by `mis / source / agent / channel / metadata`
- Provides a `MemoryStore` database abstraction for SQLite, PostgreSQL, or other storage backends
- Provides Embedding and Vector Index abstractions for future SQLite vector search integration
- Provides a local HTTP API

## Architecture

```mermaid
flowchart TD
  Client["Client / Agent"] --> API["Memory API"]
  API --> L0["L0 Conversation"]
  API --> Extractor["Extractor"]
  Extractor --> L1["L1 Memory Unit"]
  L1 --> Resolver["Relation Resolver"]
  Resolver --> Store["Memory Store"]
  Store --> L2["L2 Project Memory"]
  Store --> L3["L3 Global Memory"]
  Store --> Search["Multi-level Search"]
  Search --> Client
  Dreaming["Dreaming Job"] --> Store
  Store --> Dreaming
```

## Quick Start

```bash
npm install
npm run dev
```

Default URL:

```text
http://localhost:3000
```

Environment variables:

```bash
PORT=3001 MEMORY_DB_PATH=memory.sqlite npm run dev
```

## API Examples

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
    "content": "Project A uses MySQL",
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

The old `MySQL` memory becomes `superseded`; the new `PostgreSQL` memory stays `active`.

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

By default, search only returns `active` memories.

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

## Current Extraction Rules

The MVP does not use a real model yet. It uses rule-based extraction:

```text
项目 X 使用 Y
项目 X 用的是 Y
项目 X 已迁移到 Y
我喜欢 X
我偏好 X
决定 X
决策 X
```

Noise examples:

```text
你好
谢谢
好的
ok
```

## Embedding and Vector Storage

The project currently abstracts two interfaces:

```text
EmbeddingProvider
  embed(text) -> vector
  embedMany(texts) -> vector[]

EmbeddingIndex
  upsert(record)
  delete(id)
  search(vector, options) -> results
```

Built-in implementations:

```text
DeterministicEmbeddingProvider
InMemoryEmbeddingIndex
```

These implementations are only for local tests and interface validation. They are not intended to provide real semantic quality.

Future SQLite vector backends can implement the same `EmbeddingIndex` interface. Candidate backends:

```text
sqlite-vec: a lightweight SQLite vector search extension, suitable for the next integration target
vec1: SQLite's official ANN vector extension, worth tracking as the official path evolves
```

## Database Storage Abstraction

Database access is isolated behind the `MemoryStore` interface:

```text
createTurn
listTurns
recentTurns
createMemory
updateMemory
getMemory
listMemories
createRelation
listRelations
```

Current implementation:

```text
SqliteMemoryStore
```

For compatibility, `MemoryRepository` is still available and points to the current SQLite-backed implementation.

To switch databases later, add a new implementation:

```text
PostgresMemoryStore
MysqlMemoryStore
SqliteVecMemoryStore
```

Each implementation only needs to satisfy the same `MemoryStore` interface. Domain logic, search, Dreaming, and API routes should not depend on a concrete database.

## Development

```bash
npm test
npm run typecheck
```

## Project Structure

```text
src/domain/
  extractor.ts       Rule-based extraction
  resolver.ts        Deduplication, updates, relation resolution
  project-memory.ts  L2 project aggregation
  dreaming.ts        L3 promotion
  search.ts          Multi-level search
  embedding.ts       Embedding and Vector Index abstractions
  text.ts            Text similarity helpers
  types.ts           Domain types

src/storage/
  database.ts        SQLite schema
  repositories.ts    Backward-compatible SQLite repository
  sqlite-store.ts    SQLite store export
  store.ts           Database storage abstraction

src/server.ts        Fastify API
src/index.ts         Service entrypoint
tests/               Behavior tests
```

## MVP Scope

Implemented:

- L0/L1/L2/L3 data model
- Rule-based extraction
- Value filtering
- Supersede evolution
- Memory relations
- `MemoryStore` database abstraction
- Embedding and Vector Index abstractions
- Project aggregation
- Dreaming promotion
- Multi-level search API
- Unit tests

Not implemented yet:

- Time Memory
- Real embedding model
- SQLite vector extension persistence
- PostgreSQL/MySQL implementations
- Real LLM extraction
- Reranker
- Frontend memory management UI
- Complex knowledge graph

## Design Docs

- [Design doc](docs/superpowers/specs/2026-05-27-oh-my-memory-design.md)
- [Implementation plan](docs/superpowers/plans/2026-05-27-oh-my-memory.md)
