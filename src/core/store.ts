import * as lancedb from "@lancedb/lancedb";
import type { RagConfig } from "./config.js";
import type { EmbeddedChunk, IndexedFile, SearchResult } from "./types.js";

/**
 * Provider-agnostic vector store. Projects are isolated as separate physical
 * tables, so cross-project leakage is impossible and dropping a project is a
 * single table delete.
 */
export interface VectorStore {
  /** Replace all chunks for a file within a project (delete-then-insert). */
  replaceFile(project: string, file: string, chunks: EmbeddedChunk[]): Promise<void>;
  /** Stored file hash for a source file, or null if the file isn't indexed. */
  getFileHash(project: string, file: string): Promise<string | null>;
  /** Nearest chunks to `vector` within a project. */
  search(project: string, vector: number[], limit: number): Promise<SearchResult[]>;
  /** Source files indexed in a project, with per-file chunk counts. */
  listFiles(project: string): Promise<IndexedFile[]>;
  /** All known project ids (as stored). */
  listProjects(): Promise<string[]>;
  /** Delete an entire project. No-op if it doesn't exist. */
  dropProject(project: string): Promise<void>;
}

/**
 * Row shape persisted to LanceDB. The index signature makes it assignable to
 * LanceDB's `Record<string, unknown>[]` data type; declared fields keep their
 * types.
 */
interface Row {
  id: string;
  file: string;
  chunkIndex: number;
  heading: string;
  text: string;
  fileHash: string;
  vector: number[];
  [key: string]: unknown;
}

/**
 * LanceDB-backed store. Embedded (no server process); persists to `dataDir`.
 * One table per project, named `proj_<sanitized>`.
 */
export class LanceStore implements VectorStore {
  private readonly dataDir: string;
  private db: lancedb.Connection | null = null;

  constructor(config: RagConfig) {
    this.dataDir = config.dataDir;
  }

  private async connect(): Promise<lancedb.Connection> {
    if (!this.db) this.db = await lancedb.connect(this.dataDir);
    return this.db;
  }

  /**
   * Map a project id to a table name. LanceDB table names are restrictive, so
   * we slugify. NOTE: this is lossy — keep project ids slug-like (letters,
   * digits, dash, underscore) to avoid collisions.
   */
  private tableName(project: string): string {
    const slug = project.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error(`Project id "${project}" has no usable characters`);
    return `proj_${slug}`;
  }

  private async openTable(project: string): Promise<lancedb.Table | null> {
    const db = await this.connect();
    const name = this.tableName(project);
    const names = await db.tableNames();
    if (!names.includes(name)) return null;
    return db.openTable(name);
  }

  async replaceFile(project: string, file: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const db = await this.connect();
    const name = this.tableName(project);
    const rows: Row[] = chunks.map((c) => ({
      id: c.id,
      file: c.file,
      chunkIndex: c.chunkIndex,
      heading: c.heading,
      text: c.text,
      fileHash: c.fileHash,
      vector: c.vector,
    }));

    const existing = await this.openTable(project);
    if (existing) {
      await existing.delete(`file = ${sqlString(file)}`);
      await existing.add(rows);
    } else {
      await db.createTable(name, rows);
    }
  }

  async getFileHash(project: string, file: string): Promise<string | null> {
    const table = await this.openTable(project);
    if (!table) return null;
    const rows = await table
      .query()
      .where(`file = ${sqlString(file)}`)
      .limit(1)
      .toArray();
    const first = rows[0] as Row | undefined;
    return first?.fileHash ?? null;
  }

  async search(project: string, vector: number[], limit: number): Promise<SearchResult[]> {
    const table = await this.openTable(project);
    if (!table) return [];
    const rows = await (table.search(vector) as lancedb.VectorQuery)
      .distanceType("cosine")
      .limit(limit)
      .toArray();

    return rows.map((r: Record<string, unknown>) => {
      const row = r as Row & { _distance: number };
      return {
        text: row.text,
        file: row.file,
        heading: row.heading,
        // cosine distance in [0, 2] -> similarity in [-1, 1]; clamp to [0, 1].
        score: Math.max(0, 1 - row._distance),
      };
    });
  }

  async listFiles(project: string): Promise<IndexedFile[]> {
    const table = await this.openTable(project);
    if (!table) return [];
    // Plain query with no limit scans every row; select narrows to one column.
    const rows = await table.query().select(["file"]).toArray();
    const counts = new Map<string, number>();
    for (const r of rows) {
      const file = (r as { file?: unknown }).file;
      if (typeof file === "string") counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([file, chunkCount]) => ({ file, chunkCount }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  async listProjects(): Promise<string[]> {
    const db = await this.connect();
    const names = await db.tableNames();
    return names.filter((n) => n.startsWith("proj_")).map((n) => n.slice("proj_".length));
  }

  async dropProject(project: string): Promise<void> {
    const db = await this.connect();
    const name = this.tableName(project);
    const names = await db.tableNames();
    if (names.includes(name)) await db.dropTable(name);
  }
}

/** Quote a string for a LanceDB SQL filter, escaping embedded single quotes. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
