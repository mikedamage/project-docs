import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * End-to-end smoke test for the MCP server. Spawns the server over stdio, then:
 *   1. verifies all expected tools are advertised,
 *   2. ingests a temp markdown file into a throwaway project,
 *   3. lists its docs,
 *   4. queries it and checks the file comes back,
 *   5. drops the project and confirms it's gone.
 *
 * Exercises the full ingest -> embed -> store -> retrieve path, so it needs a
 * running Ollama with the embedding model pulled.
 *
 * Run: npm run smoke
 */
const EXPECTED_TOOLS = ["list_projects", "list_docs", "query_docs", "ingest_docs", "drop_project"];

const SAMPLE_DOC = `# Widget Service

The widget service authenticates callers with short-lived signed tokens.

## Configuration

\`\`\`bash
# set the secret before starting the service
export WIDGET_SECRET=changeme
\`\`\`

Tokens expire after 24 hours and must then be refreshed.
`;

async function main(): Promise<void> {
  const serverPath = path.resolve(import.meta.dirname, "..", "src", "mcp", "server.ts");
  const project = `smoke-test-${Date.now()}`;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "docrag-smoke-"));
  const docPath = path.join(tmpDir, "guide.md");

  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverPath] });
  const client = new Client({ name: "smoke-test", version: "0.1.0" });

  await client.connect(transport);
  try {
    // 1. Tools advertised
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`Tools advertised: ${names.join(", ")}`);
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length > 0) throw new Error(`Missing expected tools: ${missing.join(", ")}`);

    // 2. Ingest a temp doc
    await writeFile(docPath, SAMPLE_DOC);
    const ingestOut = await callTool(client, "ingest_docs", { project, paths: [docPath] });
    console.log(`\ningest_docs ->\n${ingestOut}`);
    assert(ingestOut.includes("1 ingested"), `expected "1 ingested", got:\n${ingestOut}`);

    // 3. List docs
    const docsOut = await callTool(client, "list_docs", { project });
    console.log(`\nlist_docs ->\n${docsOut}`);
    assert(docsOut.includes(docPath), `expected list_docs to include ${docPath}`);

    // 4. Query it back
    const queryOut = await callTool(client, "query_docs", {
      project,
      query: "how does the widget service authenticate callers?",
      limit: 3,
    });
    console.log(`\nquery_docs ->\n${queryOut}`);
    assert(queryOut.includes(docPath), `expected a hit from ${docPath}, got:\n${queryOut}`);

    // 5. Drop and confirm gone
    await callTool(client, "drop_project", { project });
    const projectsOut = await callTool(client, "list_projects", {});
    assert(!projectsOut.includes(project), `project "${project}" still listed after drop`);

    console.log("\n✓ Smoke test passed.");
  } finally {
    // Best-effort cleanup in case an assertion failed mid-run.
    await client.callTool({ name: "drop_project", arguments: { project } }).catch(() => {});
    await client.close();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Call a tool and return its concatenated text, throwing on an error result. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = extractText(result.content);
  if (result.isError) {
    const hint =
      name === "ingest_docs" || name === "query_docs"
        ? " (is Ollama running with the embedding model pulled?)"
        : "";
    throw new Error(`Tool "${name}" errored: ${text}${hint}`);
  }
  return text;
}

/** Pull the concatenated text from a tool result's content blocks. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
