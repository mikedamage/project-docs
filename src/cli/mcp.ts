import type { CommandModule } from "yargs";
import { startMcpServer } from "../mcp/server.js";

interface McpArgs {
  /** Global `--data-dir` option, declared in bin/project-docs.ts. */
  dataDir?: string;
}

/**
 * `mcp` command. Runs the stdio MCP server, exposing the same core tools as the
 * other subcommands. Thin wrapper: all wiring lives in src/mcp/server.ts.
 *
 * This is a long-lived process — it blocks on the stdio transport until the
 * client disconnects. Only MCP protocol frames go to stdout; logs go to stderr.
 */
export const mcpCommand: CommandModule<object, McpArgs> = {
  command: "mcp",
  describe: "Run the MCP server over stdio (for Claude Code / Claude Desktop)",
  builder: {},
  handler: async (argv) => {
    await startMcpServer({ dataDir: argv.dataDir });
  },
};
