import { loadConfig, type RagConfig } from "./config.js";
import { OllamaEmbedder, type Embedder } from "./embedder.js";
import { Ingestor } from "./ingestor.js";
import { Retriever } from "./retriever.js";
import { LanceStore, type VectorStore } from "./store.js";

export * from "./types.js";
export { loadConfig, type RagConfig } from "./config.js";
export { type Embedder, OllamaEmbedder } from "./embedder.js";
export { type VectorStore, LanceStore } from "./store.js";
export { Ingestor, type IngestReport } from "./ingestor.js";
export { Retriever, type RetrieveOptions } from "./retriever.js";

export interface Rag {
  config: RagConfig;
  store: VectorStore;
  embedder: Embedder;
  ingestor: Ingestor;
  retriever: Retriever;
}

/**
 * Single wiring point for the core. CLI scripts and the MCP server both call
 * this so they operate on identical, provider-agnostic classes.
 */
export function createRag(overrides: Partial<RagConfig> = {}): Rag {
  const config = loadConfig(overrides);
  const store = new LanceStore(config);
  const embedder = new OllamaEmbedder(config);
  return {
    config,
    store,
    embedder,
    ingestor: new Ingestor(store, embedder, config),
    retriever: new Retriever(store, embedder),
  };
}
