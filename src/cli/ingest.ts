import type { CommandModule } from "yargs";
import { createRag, DOCIGNORE_FILE } from "../core/index.js";

interface IngestArgs {
  project: string;
  paths: string[];
  force: boolean;
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
      .option("force", {
        alias: "f",
        type: "boolean",
        default: false,
        describe:
          `Ingest named files even when a ${DOCIGNORE_FILE} excludes them, and keep ` +
          "them (they survive prune). Does not apply to directory walks.",
      })
      .positional("paths", {
        type: "string",
        array: true,
        demandOption: true,
        describe:
          "Files or directories to ingest (directories are walked recursively for " +
          `markdown, honouring ${DOCIGNORE_FILE} files)`,
      }),
  handler: async (argv) => {
    const { ingestor } = createRag();

    console.error(`Ingesting into "${argv.project}" ...`);
    const report = await ingestor.ingestPaths(argv.project, argv.paths, {
      force: argv.force,
      onProgress: (file, action) => {
        console.error(`  ${action === "ingested" ? "+" : "="} ${file}`);
      },
      onRefused: (file) => {
        console.error(`  ! ${file}`);
        console.error(`      excluded by ${DOCIGNORE_FILE}; pass --force to ingest it anyway`);
      },
    });

    const notes = [
      report.pathsIgnored ? `${report.pathsIgnored} path(s) excluded by ${DOCIGNORE_FILE}` : "",
      report.refusedPaths.length ? `${report.refusedPaths.length} refused (use --force)` : "",
      report.filesForced ? `${report.filesForced} forced in` : "",
    ].filter(Boolean);
    const excluded = notes.length ? ` ${notes.join(", ")}.` : "";
    console.error(
      `Done: ${report.filesIngested} ingested, ${report.filesSkipped} unchanged, ` +
        `${report.chunksWritten} chunks written (of ${report.filesSeen} files).${excluded}`,
    );
  },
};
