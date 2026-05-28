import type Database from "better-sqlite3";
import { tokenize } from "./text.js";

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

export interface VectorSearchOptions {
  limit?: number;
  filter?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface EmbeddingIndex {
  upsert(record: VectorRecord): Promise<void>;
  delete(id: string): Promise<void>;
  search(vector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimensions = 128) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error("dimensions must be a positive integer");
    }
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array(this.dimensions).fill(0) as number[];
    for (const token of tokenize(text)) {
      const index = hash(token) % this.dimensions;
      vector[index] += 1;
    }
    return normalize(vector);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

export class InMemoryEmbeddingIndex implements EmbeddingIndex {
  private readonly records = new Map<string, VectorRecord>();

  async upsert(record: VectorRecord): Promise<void> {
    this.records.set(record.id, {
      id: record.id,
      vector: [...record.vector],
      metadata: { ...record.metadata }
    });
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const limit = options.limit ?? 10;
    return Array.from(this.records.values())
      .filter((record) => matchesFilter(record.metadata, options.filter))
      .map((record) => ({
        id: record.id,
        score: cosineSimilarity(vector, record.vector),
        metadata: record.metadata
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

export interface OpenAICompatibleEmbeddingProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(options: OpenAICompatibleEmbeddingProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1";
    this.apiKey = options.apiKey ?? process.env.EMBEDDING_API_KEY ?? "";
    this.model = options.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    this.dimensions = Number(options.dimensions ?? process.env.EMBEDDING_DIMENSIONS ?? 1536);
    this.fetchImpl = options.fetch ?? fetch;
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new Error("EMBEDDING_DIMENSIONS must be a positive integer");
    }
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedMany([text]);
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding provider request failed: HTTP ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    const embeddings = body.data?.map((item) => item.embedding) ?? [];
    if (embeddings.length !== texts.length) {
      throw new Error(`Embedding provider returned ${embeddings.length} embeddings for ${texts.length} inputs`);
    }
    return embeddings.map((embedding) => validateEmbedding(embedding, this.dimensions));
  }
}

export class SqliteVectorIndex implements EmbeddingIndex {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      create table if not exists memory_vectors (
        id text primary key,
        vector text not null,
        metadata text not null,
        updated_at text not null
      )
    `);
  }

  async upsert(record: VectorRecord): Promise<void> {
    this.db
      .prepare(
        `insert into memory_vectors (id, vector, metadata, updated_at)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           vector = excluded.vector,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`
      )
      .run(record.id, JSON.stringify(record.vector), JSON.stringify(record.metadata), new Date().toISOString());
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("delete from memory_vectors where id = ?").run(id);
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const limit = options.limit ?? 10;
    return this.db
      .prepare("select id, vector, metadata from memory_vectors")
      .all()
      .map((row) => mapVectorRow(row as { id: string; vector: string; metadata: string }))
      .filter((record) => matchesFilter(record.metadata, options.filter))
      .map((record) => ({
        id: record.id,
        score: cosineSimilarity(vector, record.vector),
        metadata: record.metadata
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error("vectors must have the same dimensions");
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

function matchesFilter(metadata: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter) {
    return true;
  }
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}

function validateEmbedding(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || !value.every((item) => typeof item === "number")) {
    throw new Error(`Embedding dimension mismatch: expected ${dimensions}`);
  }
  return value;
}

function mapVectorRow(row: { id: string; vector: string; metadata: string }): VectorRecord {
  return {
    id: row.id,
    vector: JSON.parse(row.vector) as number[],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>
  };
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}
