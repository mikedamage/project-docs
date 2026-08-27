import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRag } from "../core/index.js";
import type { SearchResult } from "../core/index.js";

/**
 * MCP server exposing the doc-RAG core over stdio.
 *
 * Design contract: this server contains NO retrieval logic. It wires up the
 * same `createRag()` core the CLI uses and maps each tool to a core method, so
 * Claude Code / Claude Desktop get behavior identical to the command line.
 *
 * stdio note: only MCP protocol frames may go to stdout. All human-readable
 * output must go to stderr (the core's progress callbacks already do).
 */
const rag = createRag();

const server = new McpServer({
  name: "doc-reference-rag",
  version: "0.1.0",
});

/**
 * Connect the server to stdio and block until the transport closes. Exported so
 * both the `project-docs mcp` CLI command and direct execution of this file can
 * start the identical server.
 */
export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`doc-reference-rag MCP server ready (data: ${rag.config.dataDir}).`);
}

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "List the ids of all projects that have docs indexed.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const projects = await rag.store.listProjects();
    const text = projects.length ? projects.join("\n") : "No projects indexed yet.";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "list_docs",
  {
    title: "List indexed docs",
    description:
      "List the source files indexed for a project, with per-file chunk counts. " +
      "A file marked (forced) was ingested despite matching a .docignore and is " +
      "exempt from prune_docs.",
    inputSchema: {
      project: z.string().describe("Project id to inspect (see list_projects)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ project }) => {
    const files = await rag.store.listFiles(project);
    if (files.length === 0) {
      return { content: [{ type: "text", text: `No docs indexed for project "${project}".` }] };
    }
    const text = files
      .map((f) => `${f.chunkCount}\t${f.file}${f.forced ? "\t(forced)" : ""}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "query_docs",
  {
    title: "Query project docs",
    description:
      "Retrieve the most relevant documentation chunks for a query within a single project. " +
      "Returns ranked excerpts with their source file and heading for you to synthesize an answer.",
    inputSchema: {
      project: z.string().describe("Project id to search within (see list_projects)."),
      query: z.string().describe("Natural-language question or topic."),
      limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe("Max chunks to return (default 5)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project, query, limit }) => {
    const results = await rag.retriever.search(project, query, { limit });
    if (results.length === 0) {
      return { content: [{ type: "text", text: `No results for "${query}" in project "${project}".` }] };
    }
    return { content: [{ type: "text", text: formatResults(results) }] };
  },
);

server.registerTool(
  "ingest_docs",
  {
    title: "Ingest project docs",
    description:
      "Index (or re-index) markdown/MDX docs into a project from a mix of files " +
      "and directories. Directories are walked recursively for markdown, skipping " +
      "anything matched by a .docignore file (gitignore-style globs, one per line, " +
      "scoped to the directory holding it). A named file that is excluded is " +
      "refused and reported unless force is set. Idempotent: unchanged files are " +
      "skipped. Use absolute paths (the server's working directory is not " +
      "guaranteed).",
    inputSchema: {
      project: z.string().describe("Project id to ingest into."),
      paths: z
        .array(z.string())
        .min(1)
        .describe("Absolute paths to files and/or directories to ingest."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Ingest named files even when a .docignore excludes them, and keep them " +
            "(they survive prune_docs). Ignored for directory arguments — a walk " +
            "always honours exclusions.",
        ),
    },
    annotations: { idempotentHint: true },
  },
  async ({ project, paths, force }) => {
    const report = await rag.ingestor.ingestPaths(project, paths, { force });
    const notes: string[] = [];
    if (report.pathsIgnored) notes.push(`  ${report.pathsIgnored} path(s) excluded by .docignore.`);
    if (report.filesForced) notes.push(`  ${report.filesForced} file(s) forced in despite exclusion.`);
    if (report.refusedPaths.length) {
      notes.push(
        `  ${report.refusedPaths.length} named file(s) refused as excluded by .docignore ` +
          "— re-run with force: true to ingest them anyway:",
        ...report.refusedPaths.map((f) => `    - ${f}`),
      );
    }
    const text =
      `Ingested into "${project}":\n` +
      `  ${report.filesIngested} ingested, ${report.filesSkipped} unchanged, ` +
      `${report.chunksWritten} chunks written (of ${report.filesSeen} files).` +
      (notes.length ? `\n${notes.join("\n")}` : "");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "prune_docs",
  {
    title: "Prune deleted docs",
    description:
      "Reconcile a project's index with the filesystem. Ingest is additive, so " +
      "this is what retires stale docs: those whose source file was deleted or " +
      "renamed, and those still on disk but now excluded by a .docignore (a " +
      "pattern added after they were indexed). Files ingested with force are " +
      "kept even though they match. Only genuinely-missing files count as " +
      "deleted; nothing else is touched.",
    inputSchema: {
      project: z.string().describe("Project id to prune."),
    },
    annotations: { idempotentHint: true, destructiveHint: true },
  },
  async ({ project }) => {
    const report = await rag.ingestor.prune(project);
    const removed = report.removedFiles.length
      ? `\n${report.removedFiles.map((r) => `  - ${r.file} (${r.reason})`).join("\n")}`
      : "";
    const text =
      `Pruned "${project}": removed ${report.filesRemoved} of ` +
      `${report.filesChecked} indexed files ` +
      `(${report.filesMissing} missing, ${report.filesIgnored} ignored).${removed}`;
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "drop_project",
  {
    title: "Drop a project",
    description: "Permanently delete a project and all of its indexed docs. This cannot be undone.",
    inputSchema: {
      project: z.string().describe("Project id to delete."),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ project }) => {
    await rag.store.dropProject(project);
    return { content: [{ type: "text", text: `Dropped project "${project}".` }] };
  },
);

function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const loc = r.heading ? `${r.file} — ${r.heading}` : r.file;
      return `[${i + 1}] (${r.score.toFixed(3)}) ${loc}\n${r.text}`;
    })
    .join("\n\n");
}

// Self-execute when this file is run directly (e.g. `npm run mcp` or a client
// wired to `... server.ts`), but not when imported by the CLI command module.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  startMcpServer().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
