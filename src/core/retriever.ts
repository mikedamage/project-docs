import type { Embedder } from "./embedder.js";
import type { VectorStore } from "./store.js";
import type { SearchResult } from "./types.js";

export interface RetrieveOptions {
  /** Max results to return. */
  limit?: number;
  /** Drop results below this similarity score (0-1). */
  minScore?: number;
}

/**
 * Embeds a query and returns the nearest chunks from a single project. Kept
 * deliberately thin — synthesis (handing results to Claude or a local model) is
 * the consumer's job, so CLI and MCP can format the same results differently.
 */
export class Retriever {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  async search(project: string, query: string, opts: RetrieveOptions = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 5;
    const vector = await this.embedder.embedQuery(query);
    const results = await this.store.search(project, vector, limit);
    if (opts.minScore != null) return results.filter((r) => r.score >= opts.minScore!);
    return results;
  }
}
