import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

/** Name of the per-directory ignore file, discovered during the ingest walk. */
export const DOCIGNORE_FILE = ".docignore";

/**
 * Match case-insensitively on macOS, matching git's own default there
 * (`core.ignorecase` is set true on case-insensitive filesystems). Node reports
 * the OS rather than us hardcoding a list; Windows is not a target, so it falls
 * through to the case-sensitive branch.
 */
const IGNORE_CASE = os.type() === "Darwin";

/**
 * A compiled `.docignore` file: the patterns of one ignore file, relative to the
 * directory that contains it.
 *
 * Pattern semantics are delegated wholesale to `ignore`, the same gitignore
 * implementation ESLint and globby use. That is deliberate: translating globs to
 * regexes by hand is the part of this feature with real bug surface (character
 * classes, escaping, `**` spanning, last-match-wins ordering), and it is exactly
 * the code that has historically produced ReDoS CVEs in glob libraries. What
 * stays here is the part `ignore` has no concept of: locating ignore files,
 * resolving paths relative to the one that owns them, and chaining nested files.
 */
export class DocignoreMatcher {
  private constructor(
    /** Absolute directory the patterns are relative to (where the file lives). */
    readonly base: string,
    private readonly rules: Ignore,
  ) {}

  /**
   * Compile the contents of one `.docignore`. Returns `null` when the file holds
   * no usable patterns (all blank/comments), so callers can skip it entirely.
   */
  static compile(base: string, content: string): DocignoreMatcher | null {
    // Mirrors what `ignore` itself skips: a line is a pattern unless it is empty
    // or starts with `#`. Leading whitespace is significant (git treats it as
    // part of the pattern), so only the trailing end is trimmed here.
    const hasPattern = content
      .split(/\r?\n/)
      .some((line) => {
        const trimmed = line.trimEnd();
        return trimmed !== "" && !trimmed.startsWith("#");
      });
    if (!hasPattern) return null;

    return new DocignoreMatcher(path.resolve(base), ignore({ ignorecase: IGNORE_CASE }).add(content));
  }

  /**
   * Verdict for one path: `true` = excluded, `false` = explicitly re-included by
   * a `!` pattern, `undefined` = no pattern matched (the caller should fall
   * through to the next ignore file up the tree). That third state is why this
   * uses `test()` rather than `ignores()`, which collapses "re-included" and
   * "never mentioned" into one `false`.
   *
   * Directories are tested with a trailing `/`, which is what makes a
   * directory-only pattern (`build/`) apply to them and not to a file of the
   * same name.
   */
  verdict(absPath: string, isDirectory: boolean): boolean | undefined {
    const rel = this.relativize(absPath);
    if (rel === undefined) return undefined;

    const { ignored, unignored } = this.rules.test(isDirectory ? `${rel}/` : rel);
    if (ignored) return true;
    if (unignored) return false;
    return undefined;
  }

  /** Path relative to `base`, in POSIX form; `undefined` if it is not under base. */
  private relativize(absPath: string): string | undefined {
    if (!absPath.startsWith(this.base)) return undefined;
    // `base` normally has no trailing separator; a filesystem root ("/", "C:\\") does.
    const cut = this.base.endsWith(path.sep) ? this.base.length : this.base.length + 1;
    const sep = absPath[this.base.length];
    if (cut > this.base.length && sep !== path.sep && sep !== "/") return undefined; // /a/bc vs /a/b
    const rel = absPath.slice(cut);
    if (rel === "") return undefined;
    return path.sep === "/" ? rel : rel.split(path.sep).join("/");
  }
}

/**
 * Verdict across a stack of ignore files ordered shallowest → deepest. The
 * deepest file that has an opinion wins, so a nested `.docignore` can override
 * its parent (including re-including with `!`).
 */
export function isIgnored(
  stack: readonly DocignoreMatcher[],
  absPath: string,
  isDirectory: boolean,
): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const verdict = stack[i]!.verdict(absPath, isDirectory);
    if (verdict !== undefined) return verdict;
  }
  return false;
}

/**
 * Loads and caches the `.docignore` files that apply to a directory: the chain
 * from the filesystem root down to it, shallowest → deepest.
 *
 * The walk in `ingestor.ts` builds this stack incrementally as it descends, but
 * `prune` starts from a bare list of absolute paths with no walk to inherit
 * from, so it has to reconstruct the chain per path. Every answer is memoised by
 * directory, which collapses that to one lookup per *distinct directory* rather
 * than per file — and a chain is built from its parent's cached chain, so a tree
 * of any depth costs one `.docignore` read attempt per directory, once.
 *
 * A loader is created per operation, not per process, so a long-lived MCP server
 * picks up edits to an ignore file between calls.
 */
export class DocignoreChainLoader {
  private readonly chains = new Map<string, readonly DocignoreMatcher[]>();
  private readonly ignoredDirs = new Map<string, boolean>();

  /** Ignore files applying to entries *inside* `dir`, shallowest → deepest. */
  async chainFor(dir: string): Promise<readonly DocignoreMatcher[]> {
    const cached = this.chains.get(dir);
    if (cached) return cached;

    const parent = path.dirname(dir);
    const inherited = parent === dir ? [] : await this.chainFor(parent);
    const own = await compileIfPresent(dir);
    const chain = own ? [...inherited, own] : inherited;

    this.chains.set(dir, chain);
    return chain;
  }

  /**
   * Whether a directory is excluded — itself, or by inheritance from an excluded
   * ancestor. The ingest walk gets this for free by never descending into an
   * excluded directory.
   *
   * `ignore` already applies containment *within* one file (`drafts/` covers
   * `drafts/a/b.md`), so this is not what makes directory-only patterns work any
   * more. It is still required across the chain: without it, a `.docignore`
   * nested inside an excluded directory could re-include a file with `!`, which
   * git forbids and the walk makes impossible by never reading that file at all.
   */
  async isDirectoryIgnored(dir: string): Promise<boolean> {
    const cached = this.ignoredDirs.get(dir);
    if (cached !== undefined) return cached;

    const parent = path.dirname(dir);
    // A `.docignore` inside a directory cannot exclude that directory itself,
    // so a directory is judged by the chain applying to its parent's entries.
    const ignored =
      parent !== dir &&
      ((await this.isDirectoryIgnored(parent)) ||
        isIgnored(await this.chainFor(parent), dir, true));

    this.ignoredDirs.set(dir, ignored);
    return ignored;
  }

  /** Whether a file is excluded, by its own path or by an excluded ancestor directory. */
  async isFileIgnored(file: string): Promise<boolean> {
    const dir = path.dirname(file);
    if (await this.isDirectoryIgnored(dir)) return true;
    return isIgnored(await this.chainFor(dir), file, false);
  }
}

/** Compile the `.docignore` in `dir`, or null if there is none (or it is empty). */
async function compileIfPresent(dir: string): Promise<DocignoreMatcher | null> {
  let content: string;
  try {
    content = await readFile(path.join(dir, DOCIGNORE_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw err;
  }
  return DocignoreMatcher.compile(dir, content);
}
