export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

export interface OpenAICompatibleEmbeddingProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Production embedding provider. Tests inject scripted vectors through the interface. */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleEmbeddingProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1";
    this.apiKey = options.apiKey ?? process.env.EMBEDDING_API_KEY ?? "";
    this.model = options.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    this.dimensions = Number(options.dimensions ?? process.env.EMBEDDING_DIMENSIONS ?? 1536);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new Error("embedding dimensions must be a positive integer");
    }
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedMany([text]);
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
      const values = body.data ?? [];
      if (values.length !== texts.length) {
        throw new Error(`Embedding response count mismatch: expected ${texts.length}, got ${values.length}`);
      }
      return values.map(({ embedding }) => validateEmbedding(embedding, this.dimensions));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) throw new Error("vectors must have the same dimensions");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function validateEmbedding(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || value.some((item) => typeof item !== "number")) {
    throw new Error(`Invalid embedding; expected ${dimensions} numeric dimensions`);
  }
  return value as number[];
}
