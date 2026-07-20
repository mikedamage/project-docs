import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "./chunker.js";
import type { RagConfig } from "./config.js";
import type { Embedder } from "./embedder.js";
import type { VectorStore } from "./store.js";
import type { EmbeddedChunk } from "./types.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

export interface IngestReport {
  project: string;
  filesSeen: number;
  filesIngested: number;
  filesSkipped: number;
  chunksWritten: number;
}

export type IngestAction = "ingested" | "skipped";

/**
 * Ingests markdown/MDX into a project from a mix of files and directories.
 * Idempotent: files whose content hash matches the stored hash are skipped, so
 * re-running only re-embeds what changed.
 *
 * Chunks are keyed by the file's resolved absolute path, so the same file is
 * identified consistently regardless of how it was passed in (as a direct
 * argument or discovered under a directory).
 */
export class Ingestor {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly config: RagConfig,
  ) {}

  /**
   * Ingest from arbitrary paths. Each path must exist; directories are walked
   * recursively for markdown files, explicitly-named files are ingested as-is
   * (any extension). Overlapping inputs are de-duplicated by absolute path.
   */
  async ingestPaths(
    project: string,
    paths: string[],
    onProgress?: (file: string, action: IngestAction) => void,
  ): Promise<IngestReport> {
    const files = await this.expandPaths(paths);
    const report: IngestReport = {
      project,
      filesSeen: files.length,
      filesIngested: 0,
      filesSkipped: 0,
      chunksWritten: 0,
    };

    for (const file of files) {
      const chunksWritten = await this.ingestFile(project, file, onProgress);
      if (chunksWritten > 0) {
        report.filesIngested++;
        report.chunksWritten += chunksWritten;
      } else {
        report.filesSkipped++;
      }
    }

    return report;
  }

  /** Resolve paths to a sorted, de-duplicated list of absolute file paths. */
  private async expandPaths(paths: string[]): Promise<string[]> {
    const files = new Set<string>();
    for (const p of paths) {
      const abs = path.resolve(p);
      let stats;
      try {
        stats = await stat(abs);
      } catch {
        throw new Error(`Path does not exist: ${p}`);
      }
      if (stats.isDirectory()) {
        for (const f of await walkMarkdown(abs)) files.add(f);
      } else if (stats.isFile()) {
        files.add(abs);
      } else {
        throw new Error(`Not a file or directory: ${p}`);
      }
    }
    return [...files].sort();
  }

  /** Ingest one absolute file path. Returns the number of chunks written (0 if skipped). */
  private async ingestFile(
    project: string,
    file: string,
    onProgress?: (file: string, action: IngestAction) => void,
  ): Promise<number> {
    const content = await readFile(file, "utf8");
    const fileHash = sha256(content);

    const storedHash = await this.store.getFileHash(project, file);
    if (storedHash === fileHash) {
      onProgress?.(file, "skipped");
      return 0;
    }

    const isMdx = path.extname(file).toLowerCase() === ".mdx";
    const rawChunks = chunkMarkdown(content, this.config, { mdx: isMdx });
    if (rawChunks.length === 0) {
      onProgress?.(file, "skipped");
      return 0;
    }

    const vectors = await this.embedder.embedDocuments(rawChunks.map((c) => c.text));
    const embedded: EmbeddedChunk[] = rawChunks.map((c, i) => ({
      id: `${file}#${i}`,
      file,
      chunkIndex: i,
      heading: c.heading,
      text: c.text,
      fileHash,
      vector: vectors[i]!,
    }));

    await this.store.replaceFile(project, file, embedded);
    onProgress?.(file, "ingested");
    return embedded.length;
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...(await walkMarkdown(full)));
    } else if (MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files.sort();
}
