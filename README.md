# project-doc-reference-rag

Local RAG over the markdown docs of the projects you work on. Docs are segregated
by project so queries only return context relevant to what you're building.

- **Vector store:** [LanceDB](https://lancedb.github.io/lancedb/) — embedded, no
  server process, persists to an OS-native per-user data dir
  (e.g. `~/Library/Application Support/project-docs` on macOS).
- **Embeddings:** local [Ollama](https://ollama.com/) running `nomic-embed-text`
  (768-dim; task prefixes applied automatically).
- **Interfaces:** CLI scripts now; an MCP server (`src/mcp/server.ts`) later. Both
  are thin wrappers over the same core classes in `src/core/`.

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

## Setup

```bash
npm install
ollama pull nomic-embed-text   # if not already present
```

## Usage

All commands are subcommands of a single `project-docs` CLI (`bin/project-docs.ts`,
built with yargs). Run it directly, or via the `npm run` aliases.

```bash
# Ingest a project's docs — any mix of files and directories.
# Directories are walked recursively for markdown; named files are ingested as-is.
npx tsx bin/project-docs.ts ingest --project my-app ../my-app/docs
npm run ingest -- --project my-app ../my-app/docs ../shared/CONTRIBUTING.md

# Prune indexed docs whose source file no longer exists on disk.
# Ingest is additive, so deleting/renaming a source file leaves orphaned chunks
# until you prune. (Reconciles the index with the filesystem by absolute path.)
npm run prune -- --project my-app

# Query within a project
npm run query -- --project my-app "how is auth configured?"
npm run query -- --project my-app --json "how is auth configured?"

# List the files indexed for a project (with chunk counts)
npm run docs -- --project my-app
npm run docs -- --project my-app --json

# Manage projects
npm run projects                    # list
npm run projects -- --drop my-app   # delete

# Full help / command list
npm run cli -- --help
```

Re-running `ingest` only re-embeds files whose contents changed (tracked by a
per-file sha256).

## Config (env vars)

| Var                    | Default                  |
| ---------------------- | ------------------------ |
| `RAG_DATA_DIR`         | OS-native per-user data dir (macOS `~/Library/Application Support/project-docs`, Win `%LOCALAPPDATA%\project-docs`, else `~/.local/share/project-docs`) |
| `OLLAMA_URL`           | `http://localhost:11434` |
| `RAG_EMBEDDING_MODEL`  | `nomic-embed-text`       |
| `RAG_EMBEDDING_DIMS`   | `768`                    |
| `RAG_CHUNK_SIZE`       | `1200`                   |
| `RAG_CHUNK_OVERLAP`    | `150`                    |
