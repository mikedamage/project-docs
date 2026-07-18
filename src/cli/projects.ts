import { parseArgs } from "node:util";
import { createRag } from "../core/index.js";

/**
 * CLI wrapper for project management.
 *
 * Usage:
 *   npm run projects                      # list projects
 *   npm run projects -- --drop <id>       # delete a project
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      drop: { type: "string" },
    },
  });

  const { store } = createRag();

  if (values.drop) {
    await store.dropProject(values.drop);
    console.error(`Dropped project "${values.drop}".`);
    return;
  }

  const projects = await store.listProjects();
  if (projects.length === 0) {
    console.error("No projects indexed yet.");
    return;
  }
  for (const p of projects) console.log(p);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
