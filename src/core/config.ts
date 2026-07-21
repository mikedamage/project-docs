import os from "node:os";
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

/**
 * Default persistence location, resolved per platform to the OS-native
 * per-user data directory:
 *   - macOS:   ~/Library/Application Support/project-docs
 *   - Windows: %LOCALAPPDATA%\project-docs (else ~/AppData/Local/project-docs)
 *   - Linux/other: $XDG_DATA_HOME/project-docs (else ~/.local/share/project-docs)
 *
 * An explicitly-set, absolute `XDG_DATA_HOME` wins on every platform, so users
 * who opt into XDG on macOS/Windows get it.
 *
 * Deliberately NOT inside the module directory — this runs as an MCP server and
 * may be installed as an npm package, where a data dir under the module would be
 * wiped on every reinstall/upgrade. User data belongs in the user's data home.
 */
function defaultDataDir(): string {
  const appName = "project-docs";
  const home = os.homedir();

  // Explicit XDG opt-in wins on any platform (spec: only when absolute).
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome && path.isAbsolute(xdgDataHome)) {
    return path.join(xdgDataHome, appName);
  }

  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", appName);
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA;
      const base =
        localAppData && path.isAbsolute(localAppData)
          ? localAppData
          : path.join(home, "AppData", "Local");
      return path.join(base, appName);
    }
    default:
      return path.join(home, ".local", "share", appName);
  }
}

export function loadConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  return {
    dataDir: process.env.RAG_DATA_DIR ?? defaultDataDir(),
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    embeddingModel: process.env.RAG_EMBEDDING_MODEL ?? "nomic-embed-text",
    // nomic-embed-text produces 768-dim vectors.
    embeddingDimensions: Number(process.env.RAG_EMBEDDING_DIMS ?? 768),
    chunkSize: Number(process.env.RAG_CHUNK_SIZE ?? 1200),
    chunkOverlap: Number(process.env.RAG_CHUNK_OVERLAP ?? 150),
    ...overrides,
  };
}
