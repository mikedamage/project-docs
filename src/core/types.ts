/** A single chunk of a source markdown document, before embedding. */
export interface Chunk {
  /** Stable id: `${file}#${chunkIndex}`. */
  id: string;
  /** Repo-relative (or absolute) path of the source file. */
  file: string;
  /** 0-based position of this chunk within its source file. */
  chunkIndex: number;
  /** Nearest heading trail for context, e.g. "Setup > Database". */
  heading: string;
  /** The chunk text (without the embedding task prefix). */
  text: string;
  /** sha256 of the whole source file — used to skip unchanged files on re-ingest. */
  fileHash: string;
  /**
   * Ingested despite matching a `.docignore`, because it was named explicitly
   * with `--force`. Sticky: it keeps the file ingestable without re-passing the
   * flag, and keeps `prune` from retiring it as excluded.
   */
  forced: boolean;
}

/** A chunk with its embedding vector attached, ready to persist. */
export interface EmbeddedChunk extends Chunk {
  vector: number[];
}

/** A source file indexed in a project, with its chunk count. */
export interface IndexedFile {
  file: string;
  chunkCount: number;
  /** Force-ingested despite matching a `.docignore` (see `Chunk.forced`). */
  forced: boolean;
}

/** What the store knows about an already-indexed file. */
export interface IndexedFileState {
  /** sha256 of the file contents as last ingested. */
  hash: string;
  forced: boolean;
}

/** A retrieval hit returned to a consumer (CLI, MCP, etc.). */
export interface SearchResult {
  text: string;
  file: string;
  heading: string;
  /** Similarity in [0, 1]; higher is closer. */
  score: number;
}
