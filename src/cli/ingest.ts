import type { CommandModule } from "yargs";
import { createRag } from "../core/index.js";

interface IngestArgs {
  project: string;
  paths: string[];
}

/**
 * `ingest` command. Thin wrapper over Ingestor — parses args, calls the core,
 * prints a report to stderr. Accepts any mix of files and directories.
 */
export const ingestCommand: CommandModule<object, IngestArgs> = {
  command: "ingest <paths..>",
  describe: "Index markdown/MDX docs into a project from files and/or directories",
  builder: (yargs) =>
    yargs
      .option("project", {
        alias: "p",
        type: "string",
        demandOption: true,
        describe: "Project id to ingest into",
      })
      .positional("paths", {
        type: "string",
        array: true,
        demandOption: true,
        describe: "Files or directories to ingest (directories are walked recursively for markdown)",
      }),
  handler: async (argv) => {
    const { ingestor } = createRag();

    console.error(`Ingesting into "${argv.project}" ...`);
    const report = await ingestor.ingestPaths(argv.project, argv.paths, (file, action) => {
      console.error(`  ${action === "ingested" ? "+" : "="} ${file}`);
    });

    console.error(
      `Done: ${report.filesIngested} ingested, ${report.filesSkipped} unchanged, ` +
        `${report.chunksWritten} chunks written (of ${report.filesSeen} files).`,
    );
  },
};
