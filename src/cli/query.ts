import type { CommandModule } from "yargs";
import { createRag } from "../core/index.js";

interface QueryArgs {
  query: string;
  project: string;
  limit: number | undefined;
  json: boolean;
}

/**
 * `query` command. Prints ranked chunks; synthesis is left to the caller (a
 * human, or a model reading this output).
 */
export const queryCommand: CommandModule<object, QueryArgs> = {
  command: "query <query>",
  describe: "Retrieve the most relevant doc chunks for a query within a project",
  builder: (yargs) =>
    yargs
      .positional("query", {
        type: "string",
        demandOption: true,
        describe: "Natural-language question or topic",
      })
      .option("project", {
        alias: "p",
        type: "string",
        demandOption: true,
        describe: "Project id to search within",
      })
      .option("limit", {
        alias: "n",
        type: "number",
        describe: "Max chunks to return (default 5)",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Emit raw results as JSON",
      }),
  handler: async (argv) => {
    const { retriever } = createRag();
    const results = await retriever.search(argv.project, argv.query, { limit: argv.limit });

    if (argv.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.error(`No results for "${argv.query}" in project "${argv.project}".`);
      return;
    }

    for (const [i, r] of results.entries()) {
      const loc = r.heading ? `${r.file} — ${r.heading}` : r.file;
      console.log(`\n[${i + 1}] (${r.score.toFixed(3)}) ${loc}`);
      console.log(r.text);
    }
  },
};
