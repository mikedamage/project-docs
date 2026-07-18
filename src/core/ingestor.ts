import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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

/**
 * Walks a docs directory, chunks + embeds changed markdown files, and upserts
 * them into the project's table. Idempotent: files whose content hash matches
 * the stored hash are skipped, so re-running only re-embeds what changed.
 */
export class Ingestor {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly config: RagConfig,
  ) {}

  async ingestDir(
    project: string,
    docsDir: string,
    onProgress?: (file: string, action: "ingested" | "skipped") => void,
  ): Promise<IngestReport> {
    const files = await walkMarkdown(docsDir);
    const report: IngestReport = {
      project,
      filesSeen: files.length,
      filesIngested: 0,
      filesSkipped: 0,
      chunksWritten: 0,
    };

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const fileHash = sha256(content);
      const relFile = path.relative(docsDir, file);

      const storedHash = await this.store.getFileHash(project, relFile);
      if (storedHash === fileHash) {
        report.filesSkipped++;
        onProgress?.(relFile, "skipped");
        continue;
      }

      const isMdx = path.extname(file).toLowerCase() === ".mdx";
      const rawChunks = chunkMarkdown(content, this.config, { mdx: isMdx });
      if (rawChunks.length === 0) {
        // File emptied of content: clear any stale chunks by writing nothing.
        await this.store.replaceFile(project, relFile, []);
        report.filesSkipped++;
        onProgress?.(relFile, "skipped");
        continue;
      }

      const vectors = await this.embedder.embedDocuments(rawChunks.map((c) => c.text));
      const embedded: EmbeddedChunk[] = rawChunks.map((c, i) => ({
        id: `${relFile}#${i}`,
        file: relFile,
        chunkIndex: i,
        heading: c.heading,
        text: c.text,
        fileHash,
        vector: vectors[i]!,
      }));

      await this.store.replaceFile(project, relFile, embedded);
      report.filesIngested++;
      report.chunksWritten += embedded.length;
      onProgress?.(relFile, "ingested");
    }

    return report;
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
