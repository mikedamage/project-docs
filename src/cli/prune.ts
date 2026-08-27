import type { CommandModule } from "yargs";
import { createRag } from "../core/index.js";

interface PruneArgs {
  project: string;
}

/**
 * `prune` command. Reconciles the index with the filesystem: removes indexed
 * docs whose source file is gone (deletions/renames leave orphaned chunks, since
 * ingest is additive) or is now excluded by a `.docignore`. Thin wrapper over
 * Ingestor.prune.
 */
export const pruneCommand: CommandModule<object, PruneArgs> = {
  command: "prune",
  describe:
    "Remove indexed docs whose source file is gone or is now excluded by a .docignore",
  builder: (yargs) =>
    yargs.option("project", {
      alias: "p",
      type: "string",
      demandOption: true,
      describe: "Project id to prune",
    }),
  handler: async (argv) => {
    const { ingestor } = createRag();

    console.error(`Pruning "${argv.project}" ...`);
    const report = await ingestor.prune(argv.project, (file, reason) => {
      console.error(`  - ${file} (${reason})`);
    });

    console.error(
      `Done: removed ${report.filesRemoved} of ${report.filesChecked} indexed files ` +
        `(${report.filesMissing} missing, ${report.filesIgnored} ignored).`,
    );
  },
};
