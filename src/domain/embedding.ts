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

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}
