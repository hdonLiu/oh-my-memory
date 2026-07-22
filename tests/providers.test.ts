import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleEmbeddingProvider } from "../src/domain/embedding.js";
import {
  LlmAmbiguousTopicModel,
  OpenAICompatibleCompletionClient
} from "../src/domain/models.js";

describe("real model provider contracts", () => {
  it("sends an OpenAI-compatible completion request and parses structured topic decisions", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[0]?.content).toContain("current topic");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "split" }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = new OpenAICompatibleCompletionClient({
      baseUrl: "https://model.example/v1",
      apiKey: "secret",
      model: "small-model",
      fetch: fetchMock
    });

    await expect(new LlmAmbiguousTopicModel(client).decide({ topicText: "预算", turnText: "周末爬山" })).resolves.toBe(
      "split"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://model.example/v1/chat/completions");
  });

  it("sends an OpenAI-compatible embedding request and validates dimensions", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://embedding.example/v1",
      apiKey: "secret",
      model: "embed-model",
      dimensions: 2,
      fetch: fetchMock
    });

    await expect(provider.embed("text")).resolves.toEqual([0.25, 0.75]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://embedding.example/v1/embeddings");
  });
});
