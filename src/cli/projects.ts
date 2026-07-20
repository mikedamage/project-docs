import type { CommandModule } from "yargs";
import { createRag } from "../core/index.js";

interface ProjectsArgs {
  drop: string | undefined;
}

/** `projects` command. Lists projects, or deletes one with `--drop`. */
export const projectsCommand: CommandModule<object, ProjectsArgs> = {
  command: "projects",
  describe: "List indexed projects, or delete one with --drop",
  builder: (yargs) =>
    yargs.option("drop", {
      type: "string",
      describe: "Delete the named project and all its indexed docs",
    }),
  handler: async (argv) => {
    const { store } = createRag();

    if (argv.drop) {
      await store.dropProject(argv.drop);
      console.error(`Dropped project "${argv.drop}".`);
      return;
    }

    const projects = await store.listProjects();
    if (projects.length === 0) {
      console.error("No projects indexed yet.");
      return;
    }
    for (const p of projects) console.log(p);
  },
};
