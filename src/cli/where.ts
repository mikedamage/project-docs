import type { CommandModule } from "yargs";
import { resolveDataDir } from "../core/index.js";

interface WhereArgs {
  /** Global `--data-dir` option, declared in bin/project-docs.ts. */
  dataDir?: string;
}

/**
 * `where` command. Prints the resolved data dir (stdout) and which setting
 * chose it (stderr), so a CLI/MCP store mismatch is easy to spot.
 */
export const whereCommand: CommandModule<object, WhereArgs> = {
  command: "where",
  describe: "Print the data dir (LanceDB store) this invocation resolves to",
  builder: {},
  handler: (argv) => {
    const { dataDir, source } = resolveDataDir(argv.dataDir);
    const from = { flag: "--data-dir", env: "RAG_DATA_DIR", default: "platform default" }[source];
    console.log(dataDir);
    console.error(`(from ${from})`);
  },
};
