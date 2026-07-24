#!/usr/bin/env -S npx tsx
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { docsCommand } from "../src/cli/docs.js";
import { ingestCommand } from "../src/cli/ingest.js";
import { mcpCommand } from "../src/cli/mcp.js";
import { projectsCommand } from "../src/cli/projects.js";
import { pruneCommand } from "../src/cli/prune.js";
import { queryCommand } from "../src/cli/query.js";

/**
 * `project-docs` CLI entrypoint. Registers each command module from src/cli/.
 * All logic lives in the core (via `createRag()`); the command modules just
 * parse args and format output.
 */
async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName("project-docs")
    .command(ingestCommand)
    .command(pruneCommand)
    .command(queryCommand)
    .command(docsCommand)
    .command(projectsCommand)
    .command(mcpCommand)
    .demandCommand(1, "Specify a command, e.g. `project-docs query ...`")
    .strict()
    .help()
    .alias("h", "help")
    .fail((msg, err) => {
      // Validation errors surface `msg`; handler errors surface `err`. Rethrow
      // the latter so the top-level catch reports it without a usage dump.
      if (err) throw err;
      console.error(`${msg}\n`);
      process.exit(1);
    })
    .parseAsync();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
