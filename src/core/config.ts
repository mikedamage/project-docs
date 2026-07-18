import path from "node:path";

/**
 * Central config for the RAG core. Everything is overridable via env vars so the
 * CLI and the (future) MCP server can share one source of truth without passing
 * options through every constructor.
 */
export interface RagConfig {
  /** Directory where LanceDB persists tables (one table per project). */
  dataDir: string;
  /** Base URL of the local Ollama server. */
  ollamaUrl: string;
  /** Embedding model name as known to Ollama. */
  embeddingModel: string;
  /** Vector dimensions produced by the embedding model. */
  embeddingDimensions: number;
  /** Target chunk size in characters before splitting a section further. */
  chunkSize: number;
  /** Character overlap between adjacent chunks within a section. */
  chunkOverlap: number;
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export function loadConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  return {
    dataDir: process.env.RAG_DATA_DIR ?? path.join(repoRoot, "data"),
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    embeddingModel: process.env.RAG_EMBEDDING_MODEL ?? "nomic-embed-text",
    // nomic-embed-text produces 768-dim vectors.
    embeddingDimensions: Number(process.env.RAG_EMBEDDING_DIMS ?? 768),
    chunkSize: Number(process.env.RAG_CHUNK_SIZE ?? 1200),
    chunkOverlap: Number(process.env.RAG_CHUNK_OVERLAP ?? 150),
    ...overrides,
  };
}
