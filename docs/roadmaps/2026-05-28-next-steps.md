# oh-my-memory Next Steps Roadmap

Status: Superseded historical roadmap

Current roadmap: [Production Readiness Backlog](./2026-06-29-production-readiness.md)

Current target architecture: [oh-my-memory Architecture v2](../architecture/oh-my-memory-architecture-v2.md)

This roadmap describes the next implementation phases after the current MVP.

Current foundation:

```text
Transport -> MemoryService -> MemoryStore
```

Existing abstractions:

```text
MemoryService
MemoryStore
EmbeddingProvider
EmbeddingIndex
```

The next goal is to make extraction, resolution, compression, vector search, and ingestion paths replaceable.

## Phase 1: Extractor Abstraction

Goal: decouple memory extraction from the rule-based function.

Add:

```text
MemoryExtractor
RuleBasedMemoryExtractor
```

Target shape:

```ts
interface MemoryExtractor {
  extract(turn: ConversationTurn, window: ConversationTurn[]): Promise<MemoryDraft[]> | MemoryDraft[];
}
```

Change:

```text
MemoryService -> MemoryExtractor
```

Instead of:

```text
MemoryService -> extractMemories()
```

Why:

- prepares for `LlmMemoryExtractor`
- keeps HTTP/CLI/SDK/MCP ingestion behavior consistent
- preserves rule-based extraction for tests and fallback

Acceptance:

- `RuleBasedMemoryExtractor` produces the same output as current `extractMemories`
- `MemoryService` accepts an injected extractor
- existing HTTP API behavior does not change
- tests cover service ingestion with a custom extractor

## Phase 2: Resolver and Compressor Strategy Abstractions

Goal: decouple relationship resolution and Dreaming compression from current rule-based logic.

Add:

```text
MemoryResolver
MemoryCompressor
ProjectMemoryBuilder
```

Initial implementations:

```text
RuleBasedMemoryResolver
RuleBasedMemoryCompressor
RuleBasedProjectMemoryBuilder
```

Responsibilities:

```text
MemoryResolver
  duplicate/update/support/related relation handling
  supersede chain handling

MemoryCompressor
  L1/L2 -> L3 promotion
  duplicate reduction
  long-term profile generation

ProjectMemoryBuilder
  L1 -> L2 project aggregation
```

Why:

- makes LLM or graph-based reasoning replaceable later
- keeps current deterministic behavior testable
- avoids putting strategy logic inside `MemoryService`

Acceptance:

- current resolver behavior is preserved
- current Dreaming behavior is preserved
- current Project Memory behavior is preserved
- `MemoryService` depends on interfaces, not concrete rule functions

## Phase 3: SQLite Vector Index

Goal: persist vectors and support vector search through the existing `EmbeddingIndex` interface.

Add:

```text
SqliteVectorIndex
```

Candidate backend:

```text
sqlite-vec
```

Alternative to track:

```text
vec1
```

Responsibilities:

```text
upsert(memoryId, vector, metadata)
delete(memoryId)
search(vector, options)
```

Schema direction:

```text
memory_vectors
  memory_id
  vector
  level
  type
  mis
  source
  agent
  channel
  metadata
  updated_at
```

Why:

- moves beyond in-memory vector search
- enables hybrid retrieval
- keeps vector backend replaceable

Acceptance:

- `SqliteVectorIndex` implements `EmbeddingIndex`
- vector records survive process restart
- vector search supports scope filters
- tests can run locally without external services

## Phase 4: Real Embedding Provider

Goal: replace deterministic test embeddings with real semantic vectors.

Add one provider first:

```text
OpenAIEmbeddingProvider
```

or:

```text
LocalEmbeddingProvider
```

Keep:

```text
DeterministicEmbeddingProvider
```

Why:

- deterministic provider remains useful for tests
- real provider improves recall quality
- provider interface avoids vendor lock-in

Acceptance:

- provider implements `EmbeddingProvider`
- supports `embed`
- supports `embedMany`
- config comes from environment variables
- tests use a fake or deterministic provider, not live network calls

## Phase 5: LLM Extractor

Goal: upgrade extraction from pattern matching to structured model output.

Add:

```text
LlmMemoryExtractor
HybridMemoryExtractor
```

Output remains:

```text
MemoryDraft[]
```

Required behavior:

```text
value filtering
subject/predicate/object extraction
memory type classification
confidence scoring
scope preservation
JSON schema validation
fallback to rule-based extraction
```

Why:

- handles natural language beyond fixed patterns
- improves memory quality
- keeps all downstream storage/search logic unchanged

Acceptance:

- invalid model output is rejected safely
- rule-based fallback still works
- tests cover schema validation and fallback
- no live model calls in unit tests

## Phase 6: Additional Ingestion Transports

Goal: prove `MemoryService` can support multiple insertion methods.

Start with CLI:

```bash
oh-my-memory ingest --content "..."
oh-my-memory import conversations.json
```

Then add:

```text
SDK method call
MCP tool
background sync job
batch importer
```

Why:

- validates that HTTP is only a transport adapter
- enables bulk import of historical conversations
- prepares for agent/plugin integrations

Acceptance:

- CLI calls `MemoryService.ingestTurn`
- batch import supports multiple turns
- failures are reported per input record
- HTTP behavior remains unchanged

## Recommended Order

```text
1. MemoryExtractor abstraction
2. Resolver/Compressor strategy abstractions
3. SQLite VectorIndex
4. Real EmbeddingProvider
5. LLM Extractor
6. CLI import and additional ingestion transports
```

## Current Non-Goals

```text
Time Memory
frontend management UI
complex knowledge graph
multi-tenant auth
production deployment
```

These can be revisited after extraction, vector search, and ingestion abstractions are stable.
