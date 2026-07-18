import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * End-to-end smoke test for the MCP server. Spawns the server over stdio,
 * lists its tools, and calls `list_projects` — verifying the whole wiring
 * (transport, tool registration, core) without needing a Claude client.
 *
 * Run: npm run smoke
 */
const EXPECTED_TOOLS = ["list_projects", "list_docs", "query_docs", "ingest_docs", "drop_project"];

async function main(): Promise<void> {
  const serverPath = path.resolve(import.meta.dirname, "..", "src", "mcp", "server.ts");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
  });
  const client = new Client({ name: "smoke-test", version: "0.1.0" });

  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`Tools advertised: ${names.join(", ")}`);

    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      throw new Error(`Missing expected tools: ${missing.join(", ")}`);
    }

    const result = await client.callTool({ name: "list_projects", arguments: {} });
    const text = extractText(result.content);
    console.log(`\nlist_projects ->\n${text}`);

    console.log("\n✓ Smoke test passed.");
  } finally {
    await client.close();
  }
}

/** Pull the concatenated text from a tool result's content blocks. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
