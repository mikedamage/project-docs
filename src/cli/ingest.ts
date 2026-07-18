import { parseArgs } from "node:util";
import path from "node:path";
import { createRag } from "../core/index.js";

/**
 * CLI wrapper around Ingestor. Contains no ingestion logic itself — it parses
 * args, calls the core, and prints a report.
 *
 * Usage:
 *   npm run ingest -- --project <id> --dir <path/to/docs>
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: "string", short: "p" },
      dir: { type: "string", short: "d" },
    },
  });

  if (!values.project || !values.dir) {
    console.error("Usage: npm run ingest -- --project <id> --dir <path/to/docs>");
    process.exit(1);
  }

  const docsDir = path.resolve(values.dir);
  const { ingestor } = createRag();

  console.error(`Ingesting "${values.project}" from ${docsDir} ...`);
  const report = await ingestor.ingestDir(values.project, docsDir, (file, action) => {
    console.error(`  ${action === "ingested" ? "+" : "="} ${file}`);
  });

  console.error(
    `Done: ${report.filesIngested} ingested, ${report.filesSkipped} unchanged, ` +
      `${report.chunksWritten} chunks written (of ${report.filesSeen} files).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
