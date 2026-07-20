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
    description: "List the source files indexed for a project, with per-file chunk counts.",
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
    const text = files.map((f) => `${f.chunkCount}\t${f.file}`).join("\n");
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
      "and directories. Directories are walked recursively for markdown; " +
      "explicitly-named files are ingested as-is. Idempotent: unchanged files " +
      "are skipped. Use absolute paths (the server's working directory is not " +
      "guaranteed).",
    inputSchema: {
      project: z.string().describe("Project id to ingest into."),
      paths: z
        .array(z.string())
        .min(1)
        .describe("Absolute paths to files and/or directories to ingest."),
    },
    annotations: { idempotentHint: true },
  },
  async ({ project, paths }) => {
    const report = await rag.ingestor.ingestPaths(project, paths);
    const text =
      `Ingested into "${project}":\n` +
      `  ${report.filesIngested} ingested, ${report.filesSkipped} unchanged, ` +
      `${report.chunksWritten} chunks written (of ${report.filesSeen} files).`;
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`doc-reference-rag MCP server ready (data: ${rag.config.dataDir}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
