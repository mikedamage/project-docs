import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "./chunker.js";
import type { RagConfig } from "./config.js";
import {
  DOCIGNORE_FILE,
  DocignoreChainLoader,
  DocignoreMatcher,
  isIgnored,
} from "./docignore.js";
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
  /**
   * Paths excluded by a `.docignore` during directory walks. An excluded
   * directory counts once — its contents are never visited, so they are not
   * counted individually.
   */
  pathsIgnored: number;
  /** Files ingested (or kept) despite exclusion, via `force` or a stored flag. */
  filesForced: number;
  /**
   * Excluded files named as arguments and left alone because `force` was not
   * set. These are the ones worth warning about: the caller asked for them by
   * name and did not get them.
   */
  refusedPaths: string[];
}

export type IngestAction = "ingested" | "skipped";

export interface IngestOptions {
  /**
   * Ingest explicitly-named files even when a `.docignore` excludes them, and
   * mark them so they stay ingested and survive `prune`. Applies only to files
   * named as arguments — directory walks always honour exclusions, so this can
   * never force a whole tree back in by accident.
   */
  force?: boolean;
  onProgress?: (file: string, action: IngestAction) => void;
  /** An excluded file named as an argument without `force` — reported, not ingested. */
  onRefused?: (file: string) => void;
}

/** Why a pruned file was dropped from the index. */
export type PruneReason = "missing" | "ignored";

export interface PruneReport {
  project: string;
  filesChecked: number;
  filesRemoved: number;
  /** Removed because the source file no longer exists on disk. */
  filesMissing: number;
  /** Removed because the source file is now excluded by a `.docignore`. */
  filesIgnored: number;
  removedFiles: { file: string; reason: PruneReason }[];
}

/**
 * Ingests markdown/MDX into a project from a mix of files and directories.
 * Idempotent: files whose content hash matches the stored hash are skipped, so
 * re-running only re-embeds what changed.
 *
 * Chunks are keyed by the file's resolved absolute path, so the same file is
 * identified consistently regardless of how it was passed in (as a direct
 * argument or discovered under a directory).
 *
 * Directory walks honour `.docignore` files (see `docignore.ts`): gitignore-style
 * globs, one per line, relative to the directory holding the file and applying to
 * its subtree. Explicitly-named file arguments bypass them — naming a file is
 * explicit intent, the same reason such files skip the markdown extension filter.
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
    options: IngestOptions = {},
  ): Promise<IngestReport> {
    const { files, ignored, refused } = await this.expandPaths(project, paths, options);
    const report: IngestReport = {
      project,
      filesSeen: files.length,
      filesIngested: 0,
      filesSkipped: 0,
      chunksWritten: 0,
      pathsIgnored: ignored,
      filesForced: 0,
      refusedPaths: refused,
    };

    for (const [file, forced] of files) {
      if (forced) report.filesForced++;
      const chunksWritten = await this.ingestFile(project, file, forced, options.onProgress);
      if (chunksWritten > 0) {
        report.filesIngested++;
        report.chunksWritten += chunksWritten;
      } else {
        report.filesSkipped++;
      }
    }

    return report;
  }

  /**
   * Reconcile the index with the filesystem. Chunks are keyed by absolute path,
   * so each indexed file can be checked directly. Two things get dropped:
   *
   * - **missing** — the source file no longer exists. Only ENOENT counts; any
   *   other stat error (e.g. a permissions problem) aborts rather than risk
   *   deleting still-present docs.
   * - **ignored** — the file still exists but is now excluded by a `.docignore`,
   *   because a pattern was added after it was indexed. Ingest is additive and
   *   never revisits what it already stored, so this is the only thing that
   *   retires those chunks.
   *
   * Files ingested with `force` are exempt from the second rule: the flag is
   * persisted precisely so that "I know it is excluded, keep it anyway" survives
   * a prune. They are still removed if they disappear from disk.
   */
  async prune(
    project: string,
    onRemove?: (file: string, reason: PruneReason) => void,
  ): Promise<PruneReport> {
    const indexed = await this.store.listFiles(project);
    const ignoreFiles = new DocignoreChainLoader();
    const report: PruneReport = {
      project,
      filesChecked: indexed.length,
      filesRemoved: 0,
      filesMissing: 0,
      filesIgnored: 0,
      removedFiles: [],
    };

    for (const { file, forced } of indexed) {
      let reason: PruneReason;
      try {
        await stat(file);
        // Still on disk — keep it unless a `.docignore` now excludes it and it
        // was not deliberately forced in.
        if (forced || !(await ignoreFiles.isFileIgnored(file))) continue;
        reason = "ignored";
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`Cannot stat "${file}" while pruning: ${(err as Error).message}`);
        }
        reason = "missing";
      }
      await this.store.deleteFile(project, file);
      report.filesRemoved++;
      if (reason === "missing") report.filesMissing++;
      else report.filesIgnored++;
      report.removedFiles.push({ file, reason });
      onRemove?.(file, reason);
    }

    return report;
  }

  /**
   * Resolve inputs to a sorted, de-duplicated map of absolute file path -> whether
   * the file is being ingested under `force`.
   */
  private async expandPaths(
    project: string,
    paths: string[],
    options: IngestOptions,
  ): Promise<{ files: [string, boolean][]; ignored: number; refused: string[] }> {
    const files = new Map<string, boolean>();
    const ignoreFiles = new DocignoreChainLoader();
    const refused: string[] = [];
    let ignored = 0;

    for (const p of paths) {
      const abs = path.resolve(p);
      let stats;
      try {
        stats = await stat(abs);
      } catch {
        throw new Error(`Path does not exist: ${p}`);
      }
      if (stats.isDirectory()) {
        // Seed with the ignore files above this root; the walk loads the root's
        // own. Prune reconstructs the same chain, so the two cannot disagree
        // about a file and undo each other on alternating runs.
        const inherited = await ignoreFiles.chainFor(path.dirname(abs));
        const walked = await walkMarkdown(abs, inherited);
        // Anything the walk reached is by definition not excluded, so it is not
        // forced — which is also how a file stops being forced: drop the pattern
        // and re-ingest the directory.
        for (const f of walked.files) if (!files.has(f)) files.set(f, false);
        ignored += walked.ignored;
      } else if (stats.isFile()) {
        const decision = await this.resolveNamedFile(project, abs, ignoreFiles, options.force);
        if (decision === "refused") {
          refused.push(abs);
          options.onRefused?.(abs);
          continue;
        }
        files.set(abs, (files.get(abs) ?? false) || decision === "forced");
      } else {
        throw new Error(`Not a file or directory: ${p}`);
      }
    }

    return { files: [...files].sort((a, b) => a[0].localeCompare(b[0])), ignored, refused };
  }

  /**
   * Decide what to do with a file named directly as an argument. Naming a file
   * is explicit intent, but not a licence to ignore the exclusion rules — git
   * refuses `git add` on an ignored path for the same reason, and points at
   * `-f`. A file forced on an earlier run stays in without re-passing the flag.
   */
  private async resolveNamedFile(
    project: string,
    file: string,
    ignoreFiles: DocignoreChainLoader,
    force: boolean | undefined,
  ): Promise<"normal" | "forced" | "refused"> {
    if (!(await ignoreFiles.isFileIgnored(file))) return "normal";
    if (force) return "forced";
    const state = await this.store.getFileState(project, file);
    return state?.forced ? "forced" : "refused";
  }

  /** Ingest one absolute file path. Returns the number of chunks written (0 if skipped). */
  private async ingestFile(
    project: string,
    file: string,
    forced: boolean,
    onProgress?: (file: string, action: IngestAction) => void,
  ): Promise<number> {
    const content = await readFile(file, "utf8");
    const fileHash = sha256(content);

    const stored = await this.store.getFileState(project, file);
    if (stored?.hash === fileHash) {
      // Content unchanged. The force flag still might have changed (a pattern
      // was added, or dropped) — flip it in place rather than re-embedding the
      // whole file to rewrite one column.
      if (stored.forced !== forced) await this.store.setForced(project, file, forced);
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
      forced,
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

/**
 * Recursively collect markdown files, honouring `.docignore`.
 *
 * `stack` holds the compiled ignore files of the ancestor directories, ordered
 * shallowest → deepest; the walk pushes this directory's own `.docignore` onto
 * it before descending. An ignored directory is skipped without being read, so
 * excluding a subtree costs one regex test rather than one per file inside it.
 */
async function walkMarkdown(
  dir: string,
  stack: readonly DocignoreMatcher[],
): Promise<{ files: string[]; ignored: number }> {
  const entries = await readdir(dir, { withFileTypes: true });

  // The listing already tells us whether an ignore file is here — no extra stat.
  let active = stack;
  if (entries.some((e) => e.name === DOCIGNORE_FILE && e.isFile())) {
    const source = await readFile(path.join(dir, DOCIGNORE_FILE), "utf8");
    const matcher = DocignoreMatcher.compile(dir, source);
    if (matcher) active = [...stack, matcher];
  }

  const files: string[] = [];
  let ignored = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (isIgnored(active, full, true)) {
        ignored++;
        continue; // prune the whole subtree
      }
      const walked = await walkMarkdown(full, active);
      files.push(...walked.files);
      ignored += walked.ignored;
    } else if (MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      if (isIgnored(active, full, false)) {
        ignored++;
        continue;
      }
      files.push(full);
    }
  }
  return { files: files.sort(), ignored };
}
