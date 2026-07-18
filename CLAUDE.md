# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A local RAG system over the markdown docs of the projects the user works on.
Docs are **segregated by project** so queries only return context relevant to the
project being worked on. It exposes the same core capabilities two ways: as CLI
scripts and as an MCP server (for Claude Code / Claude Desktop on this machine).

## Stack

- **Language:** TypeScript, ESM (`"type": "module"`), run via `tsx` (no build step).
- **Vector store:** [LanceDB](https://lancedb.github.io/lancedb/) (`@lancedb/lancedb`) —
  embedded, no server process, persists to `./data`.
- **Embeddings:** local [Ollama](https://ollama.com/) running `nomic-embed-text`
  (768-dim). Task prefixes (`search_document:` / `search_query:`) are applied
  automatically — do not add them at call sites.
- **Markdown parsing:** `unified` + `remark-parse` (+ `remark-mdx` for `.mdx`).
- **MCP:** `@modelcontextprotocol/sdk` (stable v1 API), stdio transport.
- **Validation:** `zod` (v4).

## Core design contract

**All logic lives in `src/core/`. Consumers (`src/cli/`, `src/mcp/`) are thin
wrappers that only parse input and format output.** Both construct the same
classes via `createRag()` and call the same methods, so CLI and MCP behavior are
identical by construction. When adding a capability, add it to the core first,
then expose it from both wrappers.

Everything is provider-agnostic behind interfaces (`Embedder`, `VectorStore`) so
swapping Ollama→Voyage or LanceDB→another store is a one-file change.

## Layout

```
src/core/
  config.ts     env-overridable config (data dir, model, chunk sizes)
  types.ts      Chunk, EmbeddedChunk, IndexedFile, SearchResult
  embedder.ts   Embedder interface + OllamaEmbedder (nomic prefixes baked in)
  store.ts      VectorStore interface + LanceStore (one table per project)
  chunker.ts    header-aware markdown/MDX chunking (mdast-based)
  ingestor.ts   walk docs -> chunk -> embed -> upsert (idempotent via file hash)
  retriever.ts  embed query -> cosine search within a project
  index.ts      createRag() wiring point + public re-exports
src/cli/
  ingest.ts     npm run ingest
  query.ts      npm run query
  docs.ts       npm run docs
  projects.ts   npm run projects
src/mcp/
  server.ts     npm run mcp — stdio MCP server exposing the core tools
scripts/
  smoke-test.ts npm run smoke — spawns the server, lists tools, calls list_projects
data/           LanceDB storage (gitignored)
```

## Commands

```bash
npm install
npm run typecheck                                   # tsc --noEmit (must stay clean)
npm run ingest -- --project <id> --dir <docs/dir>   # index a docs folder
npm run query  -- --project <id> [--limit N] [--json] "question"
npm run docs   -- --project <id> [--json]           # list indexed files + chunk counts
npm run projects                                    # list projects
npm run projects -- --drop <id>                      # delete a project
npm run mcp                                          # run the MCP server (stdio)
npm run smoke                                        # end-to-end MCP smoke test
```

MCP tools (mirror the CLI): `list_projects`, `list_docs`, `query_docs`,
`ingest_docs`, `drop_project`.

## Conventions & things to know

- **Run `npm run typecheck` after changes** — it covers `src/` and `scripts/`.
  Keep it clean.
- **Projects = physical LanceDB tables** (`proj_<slug>`), giving hard isolation:
  dropping a project is a single table delete and cross-project leakage is
  impossible. Project ids are slugified (`[a-z0-9_-]`) and the slug is lossy —
  keep project ids slug-like. `listProjects()` returns the slug, not the raw id.
- **Idempotent ingest:** each file's sha256 is stored on its chunks; re-ingesting
  skips files whose content is unchanged. Changed files are delete-then-insert.
- **MDX only for `.mdx`:** the chunker applies `remark-mdx` only to `.mdx` files —
  it treats `{...}`/`<tag>` as JSX, which would throw on plain `.md` prose.
- **Chunker uses an AST, not regexes:** `#` inside a fenced code block is a real
  `code` node, never mistaken for a heading. Chunk text is sliced from the
  original source via node offsets, so formatting is preserved.
- **stdio hygiene (MCP):** only protocol frames may go to **stdout**. All logging
  goes to **stderr**. Never `console.log` from the server or the core.
- **Data location is cwd-independent:** `dataDir` is anchored to the repo via
  `import.meta.dirname`, so all tools read/write the same `./data` regardless of
  where they're launched. Only `ingest_docs`'s relative `dir` resolves against cwd
  (pass an absolute path from the MCP client).

## Config (env vars)

| Var                   | Default                  |
| --------------------- | ------------------------ |
| `RAG_DATA_DIR`        | `./data`                 |
| `OLLAMA_URL`          | `http://localhost:11434` |
| `RAG_EMBEDDING_MODEL` | `nomic-embed-text`       |
| `RAG_EMBEDDING_DIMS`  | `768`                    |
| `RAG_CHUNK_SIZE`      | `1200`                   |
| `RAG_CHUNK_OVERLAP`   | `150`                    |

## Wiring the MCP server into a client

```bash
claude mcp add doc-reference-rag -- npx -y tsx /Users/mikegreen/dev/project-doc-reference-rag/src/mcp/server.ts
```

## Status / not yet built

- No automated test suite beyond the smoke test.
- `zod` is a dependency but currently only used by the MCP tool schemas; the CLIs
  use `node:util` `parseArgs`.
- Retrieval is single-project vector search only (no reranking, no hybrid/keyword
  search, no cross-project query).
