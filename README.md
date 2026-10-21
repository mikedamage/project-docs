# project-docs

Local RAG over the markdown docs of the projects you work on. Docs are segregated
by project so queries only return context relevant to what you're building.

- **Vector store:** [LanceDB](https://lancedb.github.io/lancedb/) — embedded, no
  server process, persists to an OS-native per-user data dir
  (e.g. `~/Library/Application Support/project-docs` on macOS).
- **Embeddings:** local [Ollama](https://ollama.com/) running `nomic-embed-text`
  (768-dim; task prefixes applied automatically).
- **Interfaces:** a `project-docs` CLI and a stdio MCP server
  (`src/mcp/server.ts`) for Claude Code / Codex. Both are thin wrappers over the
  same core classes in `src/core/`.

## Architecture

All logic lives in `src/core/`. Consumers (`src/cli/`, `src/mcp/`) only parse
input and format output — they construct the same classes via `createRag()`.

```
src/core/
  config.ts     env-overridable config (data dir, model, chunk sizes)
  embedder.ts   Embedder interface + OllamaEmbedder
  store.ts      VectorStore interface + LanceStore (one table per project)
  chunker.ts    header-aware markdown chunking
  ingestor.ts   walk docs -> chunk -> embed -> upsert (idempotent via file hash)
  retriever.ts  embed query -> search within a project
  index.ts      createRag() wiring point
```

Projects are isolated as separate LanceDB tables, so dropping a project is a
single table delete and cross-project leakage is impossible.

## Requirements

- **Node.js** — developed and published against 24 (`.nvmrc`); the package
  declares no `engines` floor.
- **[Ollama](https://ollama.com/)** running locally, with the embedding model pulled.
  Every command — CLI or MCP — embeds through it, so nothing works without it:

  ```bash
  ollama pull nomic-embed-text
  ```

## Install

Published to npm as **`project-docs`**, exposing a single executable,
`project-docs`.

```bash
# No install — run the published CLI on demand
npx -y project-docs --help

# Or install it globally so `project-docs` is on your PATH
npm install -g project-docs
project-docs --help
```

## MCP server

`project-docs mcp` runs the stdio MCP server, exposing the same core as the CLI:
`list_projects`, `list_docs`, `query_docs`, `ingest_docs`, `prune_docs`, and
`drop_project`.

Register it **globally** — in a user-level config, not a per-repo one — so every
project you open can query its own docs. The server is project-scoped at the
*tool* level (every call takes a `project` id), not by which directory launched it.

### Claude Code

```bash
claude mcp add project-docs -s user -- npx -y project-docs mcp
```

`-s user` is what makes it global; the default (`local`) would scope it to the
current directory. Verify with `claude mcp list`, then `/mcp` inside a session.

To pass config (see [Config](#config-env-vars) below), add `-e`:

```bash
claude mcp add project-docs -s user \
  -e OLLAMA_URL=http://localhost:11434 \
  -- npx -y project-docs mcp
```

### Codex

```bash
codex mcp add project-docs -- npx -y project-docs mcp
```

Codex's MCP registry is global already — it writes to `~/.codex/config.toml`:

```toml
[mcp_servers.project-docs]
command = "npx"
args = ["-y", "project-docs", "mcp"]
```

Verify with `codex mcp list` (or `codex mcp get project-docs`). Env vars go
in an `[mcp_servers.project-docs.env]` table, or via `--env KEY=VALUE` on
`codex mcp add`.

### npx vs. a global install

`npx -y` needs no install step, but it re-resolves the package against the
registry on a cold cache — that shows up as MCP-client startup latency and fails
outright offline. Two ways to make startup deterministic:

- **Pin the version:** `npx -y project-docs@0.2.3 mcp` — cached after
  the first run, and an upstream release can't change what your client launches.
- **Install globally and drop npx** — `npm install -g project-docs`,
  then use `command = "project-docs"` with `args = ["mcp"]` (Claude Code:
  `claude mcp add project-docs -s user -- project-docs mcp`). Fastest start;
  you upgrade on your own schedule with `npm update -g`.

The server logs to **stderr** and speaks MCP on stdout, so a client that reports
"server ready (data: …)" as an error is just showing you the startup line.

## CLI usage

Everything is a subcommand of the single `project-docs` binary. The examples below
assume a global install; with `npx` prefix each one with
`npx -y project-docs`, and from a source checkout use the `npm run`
aliases (`npm run ingest -- --project my-app ...`).

```bash
# Ingest a project's docs — any mix of files and directories.
# Directories are walked recursively for markdown; named files are ingested as-is.
project-docs ingest --project my-app ../my-app/docs
project-docs ingest --project my-app ../my-app/docs ../shared/CONTRIBUTING.md

# Prune indexed docs whose source file no longer exists on disk.
# Ingest is additive, so deleting/renaming a source file leaves orphaned chunks
# until you prune. (Reconciles the index with the filesystem by absolute path.)
project-docs prune --project my-app

# Query within a project
project-docs query --project my-app "how is auth configured?"
project-docs query --project my-app --json "how is auth configured?"

# List the files indexed for a project (with chunk counts)
project-docs docs --project my-app
project-docs docs --project my-app --json

# Manage projects
project-docs projects                  # list
project-docs projects --drop my-app    # delete

# Which store will be used (see "Store location")
project-docs where
project-docs --data-dir ./.project-docs where

# Full help / command list
project-docs --help
```

Re-running `ingest` only re-embeds files whose contents changed (tracked by a
per-file sha256).

The CLI and the MCP server share one store, so it is normal to seed a project from
the command line and then query it from Claude Code or Codex.

## Store location

The LanceDB store lives in one directory, resolved in this order:

1. `--data-dir <path>` (a global flag, accepted by every subcommand including `mcp`)
2. `RAG_DATA_DIR`
3. `$XDG_DATA_HOME/project-docs`, if `XDG_DATA_HOME` is set and absolute
4. The OS-native per-user data dir (macOS `~/Library/Application Support/project-docs`)

Relative paths resolve against the current directory. Run `project-docs where` to
see which store an invocation will use and which setting chose it. `ingest`,
`prune`, `docs` and `projects` print the store path on stderr, and so do the
`ingest_docs`, `prune_docs` and `list_projects` MCP tools. The CLI and the MCP
server resolve the store independently, and pointing them at different stores
does not raise an error: queries just come back empty or stale. The printed path
is how you catch that.

The directory is created if it is missing. A path that cannot be created or
written fails with a clear error before any data is written.

### Per-project stores (sandboxed agents)

Some agent sandboxes only allow writes inside the project directory, so ingesting
into the per-user default fails with `Operation not permitted`. In that case,
keep the store inside the repo:

```bash
cd ~/dev/my-app
export RAG_DATA_DIR="$PWD/.project-docs"
project-docs ingest -p my-app docs
project-docs query  -p my-app "how is auth configured?"
```

A store directory that `project-docs` creates contains a `.gitignore` of `*`, so
it never shows up in `git status` and the repo's own `.gitignore` needs no entry.
For Claude Code, set the variable once per repo in `.claude/settings.local.json`
(`{"env": {"RAG_DATA_DIR": "/abs/path/to/my-app/.project-docs"}}`) rather than
exporting it in every shell. If you also run the MCP server for that repo, give
its `env` the same absolute path.

## Config (env vars)

These apply to the CLI and the MCP server alike.

| Var                    | Default                  |
| ---------------------- | ------------------------ |
| `RAG_DATA_DIR`         | OS-native per-user data dir; see [Store location](#store-location) (macOS `~/Library/Application Support/project-docs`, Win `%LOCALAPPDATA%\project-docs`, else `~/.local/share/project-docs`) |
| `OLLAMA_URL`           | `http://localhost:11434` |
| `RAG_EMBEDDING_MODEL`  | `nomic-embed-text`       |
| `RAG_EMBEDDING_DIMS`   | `768`                    |
| `RAG_CHUNK_SIZE`       | `1200`                   |
| `RAG_CHUNK_OVERLAP`    | `150`                    |

## Development

```bash
npm install
npm run cli -- --help      # run from source via tsx
npm run typecheck
npm run smoke
npm run build              # compile to dist/ (also runs on prepublishOnly)
```

To point an MCP client at your working tree instead of the published package,
register `npx` with `tsx`:

```bash
claude mcp add project-docs-dev -s user \
  -- npx tsx /absolute/path/to/project-doc-reference-rag/bin/project-docs.ts mcp
```
