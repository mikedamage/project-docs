import type { RagConfig } from "./config.js";

/**
 * Provider-agnostic embedding interface. Ingestion and retrieval depend only on
 * this, so swapping Ollama for Voyage/OpenAI later is a one-file change.
 *
 * Documents and queries are embedded through separate methods because some
 * models (notably nomic-embed-text) are trained with asymmetric task prefixes.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

/**
 * Embedder backed by a local Ollama server. Applies nomic-embed-text's
 * `search_document:` / `search_query:` prefixes, which meaningfully improve
 * retrieval quality for that model. For other models these prefixes are
 * harmless-but-unhelpful, so make `usePrefixes` configurable if you swap models.
 */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly usePrefixes: boolean;

  constructor(config: RagConfig, opts: { usePrefixes?: boolean } = {}) {
    this.model = config.embeddingModel;
    this.dimensions = config.embeddingDimensions;
    this.baseUrl = config.ollamaUrl.replace(/\/$/, "");
    this.usePrefixes = opts.usePrefixes ?? config.embeddingModel.startsWith("nomic-embed");
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const input = this.usePrefixes ? texts.map((t) => `search_document: ${t}`) : texts;
    return this.embed(input);
  }

  async embedQuery(text: string): Promise<number[]> {
    const input = this.usePrefixes ? `search_query: ${text}` : text;
    const [vector] = await this.embed([input]);
    if (!vector) throw new Error("Ollama returned no embedding for query");
    return vector;
  }

  private async embed(input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ollama embed request failed (${res.status} ${res.statusText}) for model "${this.model}". ${body}`.trim(),
      );
    }

    const data = (await res.json()) as OllamaEmbedResponse;
    if (!data.embeddings || data.embeddings.length !== input.length) {
      throw new Error(
        `Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${input.length} inputs`,
      );
    }
    return data.embeddings;
  }
}
