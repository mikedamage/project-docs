# Phase 1: Code Chunking & Hybrid Retrieval

Design for teaching `project-doc-reference-rag` to index source code alongside
markdown, so a single query returns both the prose that explains a thing and the
code that implements it.

Status: **design, not built.** Written 2026-08-08.

## Why this exists

Today the system answers "what do the docs say about X". The target is a system
that answers "how does this codebase do X", citing both the architecture doc and
the specific functions involved.

The obvious way to get that is to run two tools — this one for docs, a code
intelligence server for code — and let the agent synthesize. That works, and for
a single user it is the cheaper path. It is rejected here for one reason:
**adoption cost scales with the number of things a team has to wire into their
harness.** Two MCP servers is more than twice the friction of one, because it is
also two sets of tool descriptions competing for the agent's attention and two
more ways for the agent to pick the wrong tool.

So the goal is not "add code search". The goal is **one dependency, one tool
surface, answers that span docs and code**.

## The governing constraint

**Adding code intelligence must not add MCP tools.**

If this ships as `query_docs` plus `search_code` plus `trace_path` plus
`get_snippet`, the two-server problem has been rebuilt inside one server, at our
own expense. The fusion has to happen *inside* the existing tools.

Concretely, after Phase 1 the tool list is unchanged at six:
`list_projects`, `list_docs`, `query_docs`, `ingest_docs`, `prune_docs`,
`drop_project`. `query_docs` returns doc hits and code hits in one ranked list.
`ingest_docs` dispatches on file extension. Nothing else moves.

This constraint is load-bearing for the rest of the design — it is why the
retrieval fusion lives in `Retriever` rather than being exposed as a separate
call, and it is the tiebreaker for several decisions below.

## Scope

**In scope for Phase 1:**

- Syntax-aware chunking of source files at function/class boundaries, via
  tree-sitter.
- A separate code corpus per project, with richer per-chunk metadata (symbol
  name, kind, language, line range).
- Hybrid retrieval — dense vector search fused with BM25 full-text search — over
  both corpora, returned as one ranked list.
- Line-anchored citations in CLI and MCP output.

**Explicitly deferred to Phase 2:**

- The symbol graph: definition/reference edges, call edges, import resolution.
- Two-phase retrieval (seed by similarity, expand by graph traversal).
- Anything that answers "which classes are involved when I save a report" by
  *tracing* rather than by *retrieving*.

Phase 1 is independently useful. If Phase 2 never happens, semantic code chunks
plus hybrid search still substantially beat what exists today, and it is the
cheapest way to find out whether the unified query actually feels good before
committing to the graph.

## Why tree-sitter and not a type-aware indexer

SCIP indexers (`scip-typescript`, `scip-python`) and live LSP servers both give
genuinely resolved symbols — real go-to-definition, correct through interfaces
and dynamic dispatch. They are more accurate than anything tree-sitter can do.

They are still the wrong choice here, because both reintroduce the adoption
problem in a worse form. SCIP means every consumer installs and runs a per-
language indexer as a build step. LSP means a long-lived language server process
per language, warm-up latency, and a project that has to actually resolve — no
answers on a repo with a broken build.

Tree-sitter WASM is the only option that keeps the "one dependency, zero config"
property: it installs as a normal npm package, parses any checkout with no build
step and no compiler, and degrades gracefully on syntactically broken files.

For Phase 1 — which has no graph and therefore no edges to resolve — the
precision gap barely matters. It will matter in Phase 2, and the mitigation there
is import-scoped name resolution, not a type checker.

## Corpus layout: a second table, not a migrated one

Each project already maps to a physical LanceDB table `proj_<slug>`. Code gets
its own table per project, `code_<slug>`, rather than sharing the doc table with
a discriminator column.

Three reasons, in order of weight:

1. **Zero migration.** LanceDB tables have a fixed schema. Adding `symbol`,
   `language`, and `startLine` columns to `proj_*` would mean migrating every
   table an existing user already has on disk. A new table leaves them untouched
   — old installs keep working, and code shows up the first time someone ingests
   source.
2. **It keeps the code-embedding-model option open.** `nomic-embed-text` is
   trained on prose and is mediocre on code. Swapping in a code-specific model
   later means a different vector dimensionality, which *requires* a separate
   table. Sharing one table now would make that change a full reindex plus a
   scoring rework instead of a config change.
3. **Project isolation stays the same shape.** Dropping a project is still a
   table delete, just two of them.

The cost is that a unified query is two searches fused in application code rather
than one search LanceDB ranks for us. That fusion is ~30 lines (see below), and
it is the same code we would need anyway the moment the two corpora use
different embedding models.

### Store interface

Rather than threading a `corpus` parameter through every `VectorStore` method,
`LanceStore` exposes two instances of the existing interface. The `VectorStore`
contract is unchanged except for the new hybrid search method.

```ts
/** A project's two corpora, plus project-level operations spanning both. */
export interface RagStore {
  readonly docs: VectorStore;
  readonly code: VectorStore;
  /** Union of project ids across both corpora. */
  listProjects(): Promise<string[]>;
  /** Drop both tables for a project. No-op for whichever doesn't exist. */
  dropProject(project: string): Promise<void>;
}
```

`LanceStore` becomes a thin parent holding two `LanceCorpus` objects, each bound
to a table-name prefix (`proj_` / `code_`). Every existing call site changes from
`store.x(...)` to `store.docs.x(...)` — mechanical, and the type checker finds
all of them.

## Chunk metadata

`Chunk` gains optional fields. Doc chunks leave them undefined, so nothing about
the existing markdown path changes.

```ts
export interface Chunk {
  id: string;
  file: string;
  chunkIndex: number;
  /**
   * For docs, the heading trail ("Setup > Database"). For code, the symbol
   * trail ("LanceStore > search"). Deliberately the same field: both are a
   * human-readable "where in the file am I", so existing formatting code works
   * unchanged for both corpora.
   */
  heading: string;
  text: string;
  fileHash: string;

  // --- code only ---
  /** Dotted qualified name, e.g. "LanceStore.search". */
  symbol?: string;
  /** Node kind: "function" | "class" | "method" | "interface" | "type" | ... */
  symbolKind?: string;
  /** tree-sitter language id, e.g. "typescript". */
  language?: string;
  /** 1-based inclusive source line range, for citations. */
  startLine?: number;
  endLine?: number;
}
```

Reusing `heading` for the symbol trail is the single highest-leverage decision in
this section — it means `formatResults()` in the MCP server, the CLI printer, and
the `SearchResult` shape all keep working without a branch.

### Embed text differs from stored text

What gets embedded should not be what gets returned. A bare function body embeds
poorly: the most retrievable signal (the file path, the enclosing class, the doc
comment) is often *outside* the body.

So the chunker emits both:

```ts
export interface RawChunk {
  heading: string;
  /** Exact source slice — what we store and return to the caller. */
  text: string;
  /**
   * Synthesized retrieval document — path, symbol trail, signature, doc
   * comment, then body. Embedded instead of `text` when present.
   */
  embedText?: string;
  // ...code metadata as above
}
```

The ingestor embeds `embedText ?? text`. For docs, `embedText` is always
undefined and behavior is byte-identical to today.

A code chunk's `embedText` looks roughly like:

```
src/core/store.ts
LanceStore.search (method, typescript)
Nearest chunks to `vector` within a project.

async search(project: string, vector: number[], limit: number): Promise<SearchResult[]> {
  ...
}
```

## The code chunker

New file `src/core/codeChunker.ts`, sibling to `chunker.ts`, same output type.

```ts
export interface CodeChunkOptions {
  /** tree-sitter language id, resolved from the file extension by the caller. */
  language: string;
}

/**
 * Syntax-aware chunker. Splits source at definition boundaries (functions,
 * classes, methods) using tree-sitter, so a chunk is a complete semantic unit
 * with its signature and doc comment attached rather than an arbitrary
 * character window.
 */
export async function chunkCode(
  content: string,
  config: RagConfig,
  opts: CodeChunkOptions,
): Promise<RawChunk[]>;
```

Note this is `async` where `chunkMarkdown` is sync — grammar loading is async and
the parser is initialized lazily. The ingestor already awaits per file, so this
costs nothing structurally.

### Mechanics

1. Lazily `Parser.init()` once per process; lazily load and cache each grammar.
2. Parse to a concrete syntax tree.
3. Run a per-language capture query to find definition nodes.
4. For each definition, slice the source by byte offset — same technique as
   `sliceNodes` in the markdown chunker, so formatting is preserved exactly.
5. Walk up the node's ancestors to build the symbol trail.
6. Attach the immediately-preceding comment node, if any, as the doc comment.

### Reuse the grammars' own `tags.scm`

Most tree-sitter grammars ship a `queries/tags.scm` written for exactly this
purpose — code navigation and symbol extraction. Starting from upstream
`tags.scm` rather than hand-writing capture queries removes most of the
per-language authoring work and inherits upstream's edge-case fixes.

Hand-written `.scm` files are the real long-term maintenance tail of this design,
so minimizing how many we own matters more than it looks.

### Language scope

Ship with the languages actually in use, not the forty tree-sitter supports:
TypeScript, TSX, JavaScript, Python. Each additional language is a grammar
asset plus a query file plus a test fixture, so the list should grow on demand.

Configurable via `RAG_CODE_LANGUAGES`.

### Fallbacks — nothing is silently dropped

Three cases must not lose content:

- **Unsupported language / no grammar:** fall back to the existing
  `splitLongText` over raw content, with `heading` set to the file's basename.
  A `.sql` file is still findable, just less precisely.
- **Parse produces no definitions** (a config file, a script of top-level
  statements): same fallback.
- **A definition larger than `codeChunkSize`:** split on blank lines, and repeat
  the signature line at the top of each piece so every fragment carries its
  identity into the embedding.

Silent content loss is the worst failure mode for a retrieval system, because it
is invisible — the answer is just quietly absent. Every path ends in a chunk.

## Ingestion changes

`Ingestor` learns to route by extension. The public API is unchanged:
`ingestPaths(project, paths)` still takes any mix of files and directories.

```ts
const kind = classify(file);      // "doc" | "code" | "skip"
const corpus = kind === "code" ? this.store.code : this.store.docs;
```

Per-file idempotency is untouched: sha256 of content, compared against the
stored hash, delete-then-insert on change. It works for the code table exactly as
it does for docs because the mechanism is corpus-agnostic.

`prune` also works unchanged, run once per corpus — it stats each indexed
absolute path and drops ENOENT. Both corpora key chunks by resolved absolute
path, so the existing logic applies verbatim.

### Directory walking needs to get pickier

`walkMarkdown` becomes `walkSource`, matching markdown extensions *plus* the
extensions of registered code languages. Walking source trees surfaces problems
markdown walking never had:

- **Deny-list beyond `node_modules` and dotdirs:** `dist`, `build`, `out`,
  `target`, `vendor`, `coverage`, `__pycache__`, `.venv`.
- **Generated and minified files:** skip `*.min.js`, `*.bundle.js`, `*.d.ts`,
  lockfiles, anything under a `generated/` directory.
- **A file size cap** (`RAG_MAX_FILE_BYTES`, default 1 MB). A single vendored
  bundle can otherwise dominate an entire index.

Explicitly-named files stay exempt from filtering, matching current behavior:
if a user names a file directly, ingest it.

Honest limitation: this is a heuristic deny-list, not `.gitignore` parsing. Real
`.gitignore` support is a nice Phase 1.5 addition and would subsume most of the
list above.

## Hybrid retrieval

The single most impactful change for code, and the reason it belongs in Phase 1
rather than later.

**Dense vector search is bad at exact identifiers.** Ask for `PdfRenderer` and
cosine similarity will happily return `DocumentWriter` — semantically adjacent,
literally wrong. Code queries are full of exact tokens: symbol names, config
keys, error strings. Those need lexical matching.

LanceDB 0.30.0 (already pinned) supports this natively — verified against the
installed package:

- `Index.fts()` builds a BM25 full-text index on a column.
- `query().nearestTo(vector).fullTextSearch(text)` runs both legs.
- `rerankers.RRFReranker` fuses them by reciprocal rank.

So the lexical leg costs **no new dependency**.

### Within a corpus

```ts
/** Dense + BM25 search fused by reciprocal rank, within one corpus. */
search(project: string, query: HybridQuery, limit: number): Promise<SearchResult[]>;
```

Requires an FTS index on `text`, created alongside the table. Index creation is
idempotent-ish but not free — create on table creation and after bulk inserts,
not per query.

### Across corpora

Two hybrid searches, one per corpus, fused with reciprocal rank fusion in
`Retriever`:

```
score(d) = Σ over result lists  weight_list / (k + rank_of_d_in_list)
```

with `k = 60` (the conventional default; damps the top-rank advantage). RRF is
rank-based rather than score-based, which is exactly what we want when fusing
lists whose scores are not comparable — cosine similarity and BM25 are on
unrelated scales, and the two corpora have different sizes.

**The known rough edge:** plain RRF returns roughly balanced doc/code results
regardless of what the query actually wants. "What is our deployment policy" is a
pure docs question and should not surface four functions. Two mitigations, both
cheap:

- `docWeight` / `codeWeight` config knobs on the fusion (default 1.0 each).
- A `kind` filter on the query path, so a caller who knows can restrict.

This is flagged as **the tuning knob most likely to need real work after first
contact.** It is deliberately not over-engineered now, because the right weights
are an empirical question and guessing at them before there is an index to test
against is wasted effort.

## Result shape and citations

```ts
export interface SearchResult {
  text: string;
  file: string;
  heading: string;
  score: number;
  /** Which corpus this came from. */
  kind: "doc" | "code";
  symbol?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
}
```

Formatting gains one branch. Code hits render with a line-anchored location,
which most terminals make clickable and which an agent can hand straight to a
file-reading tool:

```
[1] (0.812) [code] src/core/store.ts:126-144 — LanceStore.search
    async search(project: string, vector: number[], limit: number) { ... }

[2] (0.774) [doc]  docs/architecture.md — Retrieval > Ranking
    Retrieval is single-project vector search only...
```

The `[code]` / `[doc]` tag is not decoration. It tells the consuming model
whether it is reading an assertion about the system or the system itself — which
matters most exactly when they disagree.

## Config additions

| Var                    | Default                                   |
| ---------------------- | ----------------------------------------- |
| `RAG_CODE_LANGUAGES`   | `typescript,tsx,javascript,python`        |
| `RAG_CODE_CHUNK_SIZE`  | `2000` (code units run larger than prose) |
| `RAG_MAX_FILE_BYTES`   | `1000000`                                 |
| `RAG_HYBRID_K`         | `60` (RRF damping constant)               |
| `RAG_DOC_WEIGHT`       | `1.0`                                     |
| `RAG_CODE_WEIGHT`      | `1.0`                                     |

## The one unresolved dependency question

**Where do the `.wasm` grammar files come from?** This needs a spike before
committing to the design, and it is the only genuine unknown in Phase 1.

`web-tree-sitter` (0.26.x) is the runtime and is not in question — WASM over
native bindings is clearly right for an npm-distributed package, since native
means `node-gyp` and per-platform, per-ABI prebuilds for every consumer.

The grammars are less settled. The `tree-sitter-<lang>` npm packages ship grammar
sources and native bindings; whether each ships a prebuilt `.wasm` varies by
package and version. Three options, to be decided by the spike:

1. **Depend on packages that ship prebuilt `.wasm`.** Simplest if the needed
   languages all qualify. Verify per package.
2. **`@vscode/tree-sitter-wasm`** — ships prebuilt `.wasm` for a set of common
   languages as a single dependency. Fewer deps, less control over which
   languages and versions.
3. **Build `.wasm` at publish time** with `tree-sitter-cli` and commit the
   artifacts. Full control, but adds a toolchain step to `prepublishOnly` and
   grammar binaries to the repo.

Whichever wins, the grammars must end up **inside the published tarball** —
`files: ["dist"]` means anything not under `dist/` does not ship. If grammars
live outside `dist/`, either add them to `files` or copy them in during build.
This is exactly the class of bug that passes every local test and fails on first
install.

## Testing

The repo currently has only an end-to-end smoke test that requires Ollama. The
chunker is the component most likely to regress silently and the easiest to test
in isolation, so Phase 1 should add real unit tests using **`node:test`** — built
into Node, so no new dependency.

Worth covering:

- A TypeScript fixture producing the expected symbols, kinds, and line ranges.
- Nested classes and methods producing correct symbol trails.
- An oversized function splitting with the signature repeated.
- An unsupported extension hitting the fallback path rather than vanishing.
- A syntactically broken file still producing chunks.

Line ranges are worth asserting specifically. They are the part users notice
immediately when wrong, and off-by-one errors between tree-sitter's 0-based rows
and 1-based editor lines are close to inevitable.

## Build order

1. Grammar sourcing spike. Resolves the open question above. Do this first —
   it can invalidate parts of the design.
2. `codeChunker.ts` plus unit tests, with no store involvement. Pure function,
   fastest feedback.
3. Split `LanceStore` into `RagStore` with two corpora. Mechanical; typecheck
   drives it.
4. Ingest routing and the stricter walker.
5. FTS indexes and within-corpus hybrid search.
6. Cross-corpus RRF fusion in `Retriever`.
7. Output formatting and tool description updates in both wrappers.

Steps 2 and 3 are independent and could go in either order.

## What success looks like

Phase 1 is working when, in a project with both docs and source ingested:

- "how does ingestion avoid re-embedding unchanged files" returns the
  `CLAUDE.md` passage on idempotent ingest *and* `Ingestor.ingestFile`, and the
  two agree.
- Searching an exact symbol name returns that symbol first — the test that dense-
  only retrieval reliably fails.
- The MCP tool list still has six entries.

The last one is the real acceptance criterion. Everything else is retrieval
quality, which can be tuned. Tool surface creep cannot be undone once clients
depend on it.
