import type { CommandModule } from "yargs";
import { createRag } from "../core/index.js";

interface DocsArgs {
  project: string;
  json: boolean;
}

/** `docs` command. Lists the source files indexed for a project, with chunk counts. */
export const docsCommand: CommandModule<object, DocsArgs> = {
  command: "docs",
  describe: "List the source files indexed for a project, with chunk counts",
  builder: (yargs) =>
    yargs
      .option("project", {
        alias: "p",
        type: "string",
        demandOption: true,
        describe: "Project id to inspect",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Emit raw results as JSON",
      }),
  handler: async (argv) => {
    const { store } = createRag();
    const files = await store.listFiles(argv.project);

    if (argv.json) {
      console.log(JSON.stringify(files, null, 2));
      return;
    }

    if (files.length === 0) {
      console.error(`No docs indexed for project "${argv.project}".`);
      return;
    }

    // `(forced)` marks a file kept despite a .docignore match — it is sticky and
    // prune leaves it alone, so it should be visible here.
    for (const f of files) {
      console.log(`${String(f.chunkCount).padStart(4)}  ${f.file}${f.forced ? "  (forced)" : ""}`);
    }
    const totalChunks = files.reduce((n, f) => n + f.chunkCount, 0);
    console.error(`\n${files.length} files, ${totalChunks} chunks.`);
  },
};
