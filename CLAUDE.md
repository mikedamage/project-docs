# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A local RAG system over the markdown docs of the projects the user works on.
Docs are **segregated by project** so queries only return context relevant to the
project being worked on. It exposes the same core capabilities two ways: as CLI
scripts and as an MCP server (for Claude Code / Claude Desktop on this machine).

## Stack

- **Language:** TypeScript, ESM (`"type": "module"`). Dev runs straight off the
  sources via `tsx`; the shipped artifact is compiled JS emitted to `dist/` by
  `tsc` (`npm run build`). See "Build & dist" below.
- **Vector store:** [LanceDB](https://lancedb.github.io/lancedb/) (`@lancedb/lancedb`) —
  embedded, no server process, persists to an OS-native per-user data dir
  (e.g. `~/Library/Application Support/project-docs` on macOS).
- **Embeddings:** local [Ollama](https://ollama.com/) running `nomic-embed-text`
  (768-dim). Task prefixes (`search_document:` / `search_query:`) are applied
  automatically — do not add them at call sites.
- **Markdown parsing:** `unified` + `remark-parse` (+ `remark-mdx` for `.mdx`).
- **MCP:** `@modelcontextprotocol/sdk` (stable v1 API), stdio transport.
- **CLI:** `yargs` command modules behind a single `project-docs` entrypoint.
- **Validation:** `zod` (v4).
- **Ignore files:** `ignore` — gitignore semantics for `.docignore`. Zero
  dependencies; chosen over minimatch/picomatch/globby because it is the only one
  of them that implements *gitignore* rules rather than bash globbing.

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
  store.ts      VectorStore interface + LanceStore (one table per project,
                self-migrating schema)
  chunker.ts    header-aware markdown/MDX chunking (mdast-based)
  docignore.ts  .docignore discovery + path scoping (semantics via `ignore`)
                + DocignoreChainLoader (per-directory chain lookup, for prune)
  ingestor.ts   walk docs -> chunk -> embed -> upsert (idempotent via file hash)
  retriever.ts  embed query -> cosine search within a project
  index.ts      createRag() wiring point + public re-exports
src/cli/           each file exports a yargs CommandModule (no self-execution)
  ingest.ts     ingestCommand
  query.ts      queryCommand
  docs.ts       docsCommand
  projects.ts   projectsCommand
  prune.ts      pruneCommand
  mcp.ts        mcpCommand — runs the MCP server via startMcpServer()
bin/
  project-docs.ts  CLI entrypoint — registers the command modules (npm run cli)
src/mcp/
  server.ts     stdio MCP server; exports startMcpServer(), self-execs when run directly
scripts/
  smoke-test.ts npm run smoke — full MCP lifecycle test (needs Ollama running)
dist/           build output (gitignored) — mirrors the tree above: dist/bin/,
                dist/src/, dist/scripts/. Generated; never edit by hand.
(data dir)      LanceDB storage — OS-native per-user data dir, not in-repo
```

The CLI is one `project-docs` command with subcommands. Each `src/cli/*.ts`
exports a `CommandModule` and does NOT self-execute; `bin/project-docs.ts` wires
them into yargs. To add a command: export a new `CommandModule` and register it
in the bin script.

## Commands

```bash
npm install
npm run typecheck                                   # tsc --noEmit (must stay clean)
npm run build                                       # tsc -> dist/ (+ chmod +x the bin)
npm link                                            # one-time: put project-docs on PATH
npm run cli    -- --help                            # list all subcommands
npm run ingest -- --project <id> [--force] <path>...  # index files and/or dirs
npm run prune  -- --project <id>                    # drop indexed docs that are gone or now .docignore'd
npm run query  -- --project <id> [--limit N] [--json] "question"
npm run docs   -- --project <id> [--json]           # list indexed files + chunk counts
npm run projects                                    # list projects
npm run projects -- --drop <id>                      # delete a project
npm run mcp                                          # run the MCP server (stdio); == project-docs mcp
npm run smoke                                        # end-to-end MCP smoke test
```

The `npm run <cmd>` aliases proxy to `tsx bin/project-docs.ts <cmd>`. You can
also run `npx tsx bin/project-docs.ts <cmd>` directly.

MCP tools (mirror the CLI): `list_projects`, `list_docs`, `query_docs`,
`ingest_docs`, `prune_docs`, `drop_project`.

## Build & dist

There are two ways to run this repo, and they are not interchangeable:

- **Dev / iterating in-repo:** the `npm run <cmd>` scripts run the **TypeScript
  sources** through `tsx`. No build required — edit and re-run.
- **Installed / published:** `package.json` `bin` points at
  `./dist/bin/project-docs.js`, and `"files": ["dist"]` means the tarball
  contains **only** `dist/`. Consumers never see the `.ts` sources.

Consequences worth remembering:

- **`dist/` is stale until you rebuild.** Editing a `.ts` file changes what
  `npm run cli` does immediately, but does nothing for anything resolving through
  `bin` — the linked `project-docs` executable, a global install, an MCP client
  launched via either — until `npm run build` runs. When a change must reach the
  MCP server or an installed consumer, build.
- **`npm run build` is `tsc` + a `postbuild` hook** that `chmod`s
  `dist/bin/project-docs.js` to `0755`. `tsc` does not preserve file modes and has
  no option to, so without the hook the emitted entrypoint is `644` and cannot be
  executed via its shebang. If you add another executable entrypoint, extend that
  hook too.
- **Publishing self-builds; packing does not.** `prepublishOnly` runs
  `npm run build`, so `npm publish` always ships a fresh `dist/`. It does **not**
  run for `npm pack`, `npm install <folder>`, or `npm link` — for those, `files:
  ["dist"]` ships whatever is on disk, and a clean checkout with no `dist/`
  yields a package whose `bin` target does not exist. Build first.
- **`tsc` emits, it does not clean.** Renaming or deleting a source file leaves
  its old `.js`/`.js.map` behind in `dist/`. Delete `dist/` when the file layout
  changes.
- **`tsconfig.json` has `rootDir: "."`,** so the `src/` + `bin/` + `scripts/`
  layout is mirrored under `dist/` rather than flattened — hence
  `dist/bin/project-docs.js` and `dist/src/mcp/server.js`.
- **Relative imports must keep their `.js` extensions** (`../core/index.js`, even
  though the file is `index.ts`). The emitted ESM is run directly by Node, which
  does no extension resolution. `moduleResolution` is `Bundler`, which tolerates
  extensionless imports at typecheck time — so an omission compiles clean and then
  fails at runtime.

## Conventions & things to know

- **Run `npm run typecheck` after changes** — it covers `src/`, `bin/` and
  `scripts/`. Keep it clean. It shares `tsconfig.json` with the build but passes
  `--noEmit`, so it never writes to `dist/`.
- **Projects = physical LanceDB tables** (`proj_<slug>`), giving hard isolation:
  dropping a project is a single table delete and cross-project leakage is
  impossible. Project ids are slugified (`[a-z0-9_-]`) and the slug is lossy —
  keep project ids slug-like. `listProjects()` returns the slug, not the raw id.
- **Idempotent ingest:** each file's sha256 is stored on its chunks; re-ingesting
  skips files whose content is unchanged. Changed files are delete-then-insert.
- **Ingest is additive; nothing is retired except by `prune`.** Ingest only ever
  visits the paths it's handed and never revisits what it already stored, so a
  source file deleted or renamed on disk — or newly excluded by a `.docignore`
  pattern added after it was indexed — leaves orphaned chunks behind. Reconcile
  with `prune` (CLI) / `prune_docs` (MCP), which checks every indexed file (keyed
  by absolute path) and drops it as **missing** (gone from disk) or **ignored**
  (still there, now excluded); the report and both wrappers count the two
  separately. Force-ingested files are exempt from the second rule. Only ENOENT
  counts as missing — other stat errors abort rather than risk deleting
  still-present docs.
- **Chunks are keyed by resolved absolute path.** `ingest` takes any mix of files
  and directories (variadic positional); directories are walked recursively for
  markdown, named files are ingested as-is (any extension, subject to `.docignore`
  — see below). Overlapping inputs are de-duplicated by absolute path.
- **`.docignore` excludes files from directory walks.** Gitignore syntax and
  semantics: one glob per line, `!` to re-include, trailing `/` for
  directory-only, a leading or interior `/` anchors to the ignore file's own
  directory (otherwise the pattern matches at any depth), `**` spans segments,
  last matching pattern wins. Nested like gitignore — a `.docignore` applies to
  its own directory's subtree and overrides its parents, and the chain is searched
  all the way up to the filesystem root, so a `.docignore` above the directory you
  hand to `ingest` still applies. Excluded paths are counted in
  `IngestReport.pathsIgnored` and reported by both wrappers; an excluded directory
  counts once.
- **Whitespace and `#` follow git exactly, which is fussier than it looks.**
  Leading whitespace is *part of the pattern*, so a comment's `#` must be in
  column 0 — `  # foo` is a pattern matching a file named `  # foo`, not a
  comment. There are no inline comments either: a `#` anywhere but column 0 is a
  literal character, so `x.md # note` matches a file with that exact name.
  Trailing whitespace *is* stripped, unless backslash-escaped (`foo\ ` matches
  `foo ` with the space). `ignore` gets all of this right; the only place we
  restate it is `DocignoreMatcher.compile`, which scans for "does this file hold
  any pattern at all" to decide whether to skip the file entirely. Keep that scan
  in step with the rule above — in particular, do not `trimStart()` there.
- **Ingest and prune must agree about exclusion, or they undo each other.** Both
  resolve the same chain — the walk builds its stack as it descends and seeds it
  from the ancestors above the root, while `prune` reconstructs it per path via
  `DocignoreChainLoader` (memoised per directory, so cost is one `.docignore` read
  attempt per distinct directory, not per file). Prune must also test each ancestor
  *directory* of an indexed file, which is what makes a directory-only pattern
  (`drafts/`) retire the files beneath it — the walk gets that for free by never
  descending. Ancestor search exists on the ingest side purely to keep the two in
  step: without it, a `.docignore` above the ingest root would have prune deleting
  on every run what the next ingest re-adds. The `forced` flag is the other half
  of that contract — it is the only thing that lets an excluded file stay indexed,
  and both sides honour it.
- **Excluded files must be forced in explicitly, and it sticks.** Naming an
  excluded file as an argument is *not* enough — ingest refuses it and reports
  it (`IngestReport.refusedPaths`, warned by both wrappers), the same way git
  refuses to `git add` an ignored path and points at `-f`. `--force` (CLI) /
  `force: true` (MCP) admits it and persists `forced: true` on its chunks, which
  is what makes the decision durable: a forced file keeps re-ingesting without
  the flag, and `prune` will not retire it as excluded (it is still pruned if the
  file actually disappears). Force applies **only to explicitly-named files** —
  a directory walk always honours exclusions, so `--force` can never rake a whole
  ignored subtree back in. To un-force, drop the pattern and re-ingest the
  directory: anything the walk reaches is by definition not excluded, so the flag
  clears. `docs` / `list_docs` mark forced files so a sticky flag stays visible.
- **The store schema migrates itself.** LanceDB infers a table's schema from the
  first insert and then rejects any row carrying an unknown field (`Found field
  not in schema`), so adding the `forced` column would break every write to a
  project indexed before it existed. `LanceStore.migrate()` backfills it via
  `addColumns` on first touch of each table, once per process. Adding another
  persisted field means extending that migration — a new column is not a
  backwards-compatible change on its own.
- **Pattern semantics come from `ignore`; do not hand-roll them again.** Glob
  translation, `!` ordering, character classes, escaping and `**` spanning are all
  delegated to the `ignore` package — the same gitignore implementation ESLint and
  globby use. An earlier version translated globs to a single combined regex by
  hand. It was measurably correct (3,136 differential cases against `ignore`, zero
  divergence) and still not worth keeping: `ignore` is ~6x faster in situ, and the
  ~190 lines it replaced were exactly the code that produces ReDoS CVEs in glob
  libraries. Note that *no* implementation escapes that risk — hand-rolled,
  `ignore`, picomatch and minimatch are all exponential on patterns like
  `*a*a*a*a*.md`; the difference is whose problem it is to fix.
  What is genuinely ours, and is the part worth protecting: locating ignore files,
  resolving each path relative to the file that owns it, and chaining nested
  files. An ignored directory is pruned from the walk without being read, so
  excluding a subtree costs one test rather than one per file inside it.
- **Matching is case-insensitive on macOS only.** `IGNORE_CASE` is
  `os.type() === "Darwin"`, mirroring git, which sets `core.ignorecase` on
  case-insensitive filesystems. So `changelog.md` in a `.docignore` excludes
  `CHANGELOG.md` on a Mac and not on Linux. Windows is not a target and falls
  through to the case-sensitive branch.
- **MDX only for `.mdx`:** the chunker applies `remark-mdx` only to `.mdx` files —
  it treats `{...}`/`<tag>` as JSX, which would throw on plain `.md` prose.
- **Chunker uses an AST, not regexes:** `#` inside a fenced code block is a real
  `code` node, never mistaken for a heading. Chunk text is sliced from the
  original source via node offsets, so formatting is preserved.
- **stdio hygiene (MCP):** only protocol frames may go to **stdout**. All logging
  goes to **stderr**. Never `console.log` from the server or the core.
- **Data location is user-scoped, not in the module:** `dataDir` defaults to the
  OS-native per-user data dir — `~/Library/Application Support/project-docs` on
  macOS, `%LOCALAPPDATA%\project-docs` on Windows, `~/.local/share/project-docs`
  (or `$XDG_DATA_HOME/project-docs`) elsewhere — NOT a dir inside the repo. An
  absolute `XDG_DATA_HOME` overrides the platform default on any OS. This is
  deliberate: as an npm-installed MCP server, a data dir under the module would
  be wiped on every reinstall/upgrade. The path is absolute and cwd-independent,
  so all tools read/write the same store regardless of where they're launched;
  `connect()` creates it (`mkdir -p`) on first use. Override with `RAG_DATA_DIR`.
  Only `ingest`'s relative paths resolve against cwd (pass absolute paths from
  the MCP client).

## Config (env vars)

| Var                   | Default                  |
| --------------------- | ------------------------ |
| `RAG_DATA_DIR`        | OS-native per-user data dir (macOS `~/Library/Application Support/project-docs`, Win `%LOCALAPPDATA%\project-docs`, else `~/.local/share/project-docs`) |
| `OLLAMA_URL`          | `http://localhost:11434` |
| `RAG_EMBEDDING_MODEL` | `nomic-embed-text`       |
| `RAG_EMBEDDING_DIMS`  | `768`                    |
| `RAG_CHUNK_SIZE`      | `1200`                   |
| `RAG_CHUNK_OVERLAP`   | `150`                    |

## Wiring the MCP server into a client

Build once and link the package, which puts `project-docs` on `PATH`:

```bash
npm run build
npm link          # from the repo root; one-time
```

Then the client config needs no paths at all:

```bash
claude mcp add project-docs -- project-docs mcp
```

`npm link` symlinks the global bin to `dist/bin/project-docs.js` **inside this
repo**, so:

- **Rebuilds are picked up automatically** — `npm run build` is enough, never
  re-link. The symlink resolves at exec time.
- **The link dangles while `dist/` is missing.** `rm -rf dist` makes
  `project-docs` fail with `command not found` (not a friendlier error) until the
  next build. If the command disappears, that is the usual cause.
- **Moving or deleting the repo breaks the command**, since the target is a path
  into the working tree.

Undo with `npm unlink -g project-docs`.

For iterating on the server itself, point the client at the sources instead —
picks up edits with no rebuild, at the cost of `tsx` startup on every client
launch:

```bash
claude mcp add project-docs -- npx -y tsx /Users/mike/dev/project-doc-reference-rag/src/mcp/server.ts
```

## Status / not yet built

- No automated test suite beyond the smoke test.
- `zod` is currently used only by the MCP tool schemas; the CLI uses yargs.
- Retrieval is single-project vector search only (no reranking, no hybrid/keyword
  search, no cross-project query).
