import { parseArgs } from "node:util";
import { createRag } from "../core/index.js";

/**
 * CLI wrapper listing the source files indexed for a project, with chunk counts.
 *
 * Usage:
 *   npm run docs -- --project <id> [--json]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: "string", short: "p" },
      json: { type: "boolean" },
    },
  });

  if (!values.project) {
    console.error("Usage: npm run docs -- --project <id> [--json]");
    process.exit(1);
  }

  const { store } = createRag();
  const files = await store.listFiles(values.project);

  if (values.json) {
    console.log(JSON.stringify(files, null, 2));
    return;
  }

  if (files.length === 0) {
    console.error(`No docs indexed for project "${values.project}".`);
    return;
  }

  for (const f of files) console.log(`${String(f.chunkCount).padStart(4)}  ${f.file}`);
  const totalChunks = files.reduce((n, f) => n + f.chunkCount, 0);
  console.error(`\n${files.length} files, ${totalChunks} chunks.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
