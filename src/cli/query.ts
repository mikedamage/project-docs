import { parseArgs } from "node:util";
import { createRag } from "../core/index.js";

/**
 * CLI wrapper around Retriever. Prints ranked chunks; synthesis is left to the
 * caller (a human, or a model reading this output).
 *
 * Usage:
 *   npm run query -- --project <id> --limit 5 "how does auth work?"
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      limit: { type: "string", short: "n" },
      json: { type: "boolean" },
    },
  });

  const query = positionals.join(" ").trim();
  if (!values.project || !query) {
    console.error('Usage: npm run query -- --project <id> [--limit N] [--json] "your question"');
    process.exit(1);
  }

  const { retriever } = createRag();
  const results = await retriever.search(values.project, query, {
    limit: values.limit ? Number(values.limit) : undefined,
  });

  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.error(`No results for "${query}" in project "${values.project}".`);
    return;
  }

  for (const [i, r] of results.entries()) {
    const loc = r.heading ? `${r.file} — ${r.heading}` : r.file;
    console.log(`\n[${i + 1}] (${r.score.toFixed(3)}) ${loc}`);
    console.log(r.text);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
