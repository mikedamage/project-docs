import { mkdir } from "node:fs/promises";
import * as lancedb from "@lancedb/lancedb";
import type { RagConfig } from "./config.js";
import type { EmbeddedChunk, IndexedFile, IndexedFileState, SearchResult } from "./types.js";

/**
 * Provider-agnostic vector store. Projects are isolated as separate physical
 * tables, so cross-project leakage is impossible and dropping a project is a
 * single table delete.
 */
export interface VectorStore {
  /** Replace all chunks for a file within a project (delete-then-insert). */
  replaceFile(project: string, file: string, chunks: EmbeddedChunk[]): Promise<void>;
  /** Delete all chunks for a file within a project. No-op if absent. */
  deleteFile(project: string, file: string): Promise<void>;
  /** Stored hash + force flag for a source file, or null if it isn't indexed. */
  getFileState(project: string, file: string): Promise<IndexedFileState | null>;
  /** Flip the stored force flag for a file, without touching its chunks. */
  setForced(project: string, file: string, forced: boolean): Promise<void>;
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
  forced: boolean;
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
  /** Tables already known to carry the `forced` column (see `migrate`). */
  private readonly migrated = new Set<string>();

  constructor(config: RagConfig) {
    this.dataDir = config.dataDir;
  }

  private async connect(): Promise<lancedb.Connection> {
    if (!this.db) {
      // Ensure the data dir exists (default is ~/.local/share/project-docs,
      // which won't exist on a fresh machine). mkdir -p is a no-op if present.
      await mkdir(this.dataDir, { recursive: true });
      this.db = await lancedb.connect(this.dataDir);
    }
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
    const table = await db.openTable(name);
    await this.migrate(name, table);
    return table;
  }

  /**
   * Backfill the `forced` column on tables written before `.docignore` support.
   * LanceDB infers the schema from the first insert and then rejects any row
   * carrying an unknown field ("Found field not in schema"), so without this
   * every write to a pre-existing project would fail. Checked once per table
   * per process; `addColumns` defaults existing rows to false.
   */
  private async migrate(name: string, table: lancedb.Table): Promise<void> {
    if (this.migrated.has(name)) return;
    const schema = await table.schema();
    if (!schema.fields.some((f) => f.name === "forced")) {
      await table.addColumns([{ name: "forced", valueSql: "false" }]);
    }
    this.migrated.add(name);
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
      forced: c.forced,
      vector: c.vector,
    }));

    const existing = await this.openTable(project);
    if (existing) {
      await existing.delete(`file = ${sqlString(file)}`);
      await existing.add(rows);
    } else {
      await db.createTable(name, rows);
      this.migrated.add(name); // created from `rows`, so the column is present
    }
  }

  async deleteFile(project: string, file: string): Promise<void> {
    const table = await this.openTable(project);
    if (!table) return;
    await table.delete(`file = ${sqlString(file)}`);
  }

  async getFileState(project: string, file: string): Promise<IndexedFileState | null> {
    const table = await this.openTable(project);
    if (!table) return null;
    const rows = await table
      .query()
      .where(`file = ${sqlString(file)}`)
      .select(["fileHash", "forced"]) // never pull the vector/text just to read a hash
      .limit(1)
      .toArray();
    const first = rows[0] as Pick<Row, "fileHash" | "forced"> | undefined;
    if (!first) return null;
    return { hash: first.fileHash, forced: Boolean(first.forced) };
  }

  async setForced(project: string, file: string, forced: boolean): Promise<void> {
    const table = await this.openTable(project);
    if (!table) return;
    await table.update({ where: `file = ${sqlString(file)}`, values: { forced } });
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
    // Plain query with no limit scans every row; select keeps it off the vectors.
    const rows = await table.query().select(["file", "forced"]).toArray();
    const files = new Map<string, IndexedFile>();
    for (const r of rows) {
      const { file, forced } = r as { file?: unknown; forced?: unknown };
      if (typeof file !== "string") continue;
      const entry = files.get(file);
      if (entry) entry.chunkCount++;
      else files.set(file, { file, chunkCount: 1, forced: Boolean(forced) });
    }
    return [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
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
