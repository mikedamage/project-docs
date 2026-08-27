import { readFile } from "node:fs/promises";
import path from "node:path";

/** Name of the per-directory ignore file, discovered during the ingest walk. */
export const DOCIGNORE_FILE = ".docignore";

/**
 * A compiled `.docignore` file: the patterns of one ignore file, relative to the
 * directory that contains it.
 *
 * Every pattern in the file is compiled into a *single* anchored RegExp, so
 * testing a path costs one regex execution regardless of how many patterns the
 * file holds — not one execution per pattern.
 *
 * The alternatives are emitted in **reverse** source order. Because the regex is
 * anchored on both ends, "some alternative matched" is the same as "that
 * alternative matched the whole path", and the engine commits to the first
 * alternative that can do so. Reversing therefore makes the winning alternative
 * the *last* matching pattern in the file — gitignore's last-match-wins rule,
 * for free, in one pass.
 */
export class DocignoreMatcher {
  private constructor(
    /** Absolute directory the patterns are relative to (where the file lives). */
    readonly base: string,
    private readonly regex: RegExp,
    /** `negated[i]` is the `!` flag of the pattern behind capture group `i + 1`. */
    private readonly negated: boolean[],
  ) {}

  /**
   * Compile the contents of one `.docignore`. Returns `null` when the file holds
   * no usable patterns (all blank/comments), so callers can skip it entirely.
   */
  static compile(base: string, content: string): DocignoreMatcher | null {
    const entries: { source: string; negated: boolean }[] = [];
    for (const line of content.split(/\r?\n/)) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    if (entries.length === 0) return null;

    // Reverse so the first alternative to match is the last pattern in the file.
    entries.reverse();
    const regex = new RegExp(`^(?:${entries.map((e) => `(${e.source})`).join("|")})$`);
    return new DocignoreMatcher(
      path.resolve(base),
      regex,
      entries.map((e) => e.negated),
    );
  }

  /**
   * Verdict for one path: `true` = excluded, `false` = explicitly re-included by
   * a `!` pattern, `undefined` = no pattern matched (the caller should fall
   * through to the next ignore file up the tree).
   *
   * Directories are tested with a trailing `/`, which is what lets a single
   * regex serve both: a directory-only pattern (`build/`) requires that slash,
   * while every other pattern tolerates it.
   */
  verdict(absPath: string, isDirectory: boolean): boolean | undefined {
    const rel = this.relativize(absPath);
    if (rel === undefined) return undefined;

    const match = this.regex.exec(isDirectory ? `${rel}/` : rel);
    if (!match) return undefined;

    // Exactly one group is set: the alternative the engine committed to.
    for (let i = 1; i < match.length; i++) {
      if (match[i] !== undefined) return !this.negated[i - 1];
    }
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

/** Parse one line into a regex source + negation flag, or null if it is not a pattern. */
function parseLine(rawLine: string): { source: string; negated: boolean } | null {
  let line = stripTrailingSpace(rawLine).trimStart();
  if (line === "" || line.startsWith("#")) return null; // blank or comment

  const negated = line.startsWith("!");
  if (negated) line = line.slice(1);

  const directoryOnly = line.endsWith("/");
  if (directoryOnly) line = line.slice(0, -1);
  // A pattern with an interior slash is anchored to the ignore file's directory;
  // one without matches at any depth below it.
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  if (line === "") return null;

  const prefix = anchored ? "" : "(?:[^/]+/)*";
  const suffix = directoryOnly ? "/" : "/?";
  return { source: prefix + globToRegex(line) + suffix, negated };
}

/** Translate a glob body (slash-separated) to regex source. Emits no capture groups. */
function globToRegex(glob: string): string {
  const segments = glob.split("/");
  let source = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;
    if (segment === "**") {
      // `**` spans zero or more path segments; trailing `**` means "everything
      // inside", which requires at least one.
      source += isLast ? ".+" : "(?:[^/]+/)*";
      continue;
    }
    source += segmentToRegex(segment);
    if (!isLast) source += "/";
  }
  return source;
}

/** Translate one path segment: `*` and `?` never cross a `/`. */
function segmentToRegex(segment: string): string {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === "\\") {
      const next = segment[++i];
      source += next === undefined ? "\\\\" : escapeLiteral(next);
    } else if (char === "*") {
      while (segment[i + 1] === "*") i++; // `a**b` degrades to `a*b` within a segment
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const cls = readCharClass(segment, i);
      if (cls) {
        source += cls.source;
        i = cls.end;
      } else {
        source += "\\[";
      }
    } else {
      source += escapeLiteral(char);
    }
  }
  return source;
}

/** Read a `[...]` / `[!...]` class starting at `start`; null if unterminated. */
function readCharClass(segment: string, start: number): { source: string; end: number } | null {
  let i = start + 1;
  let negate = false;
  if (segment[i] === "!" || segment[i] === "^") {
    negate = true;
    i++;
  }
  let body = "";
  if (segment[i] === "]") {
    body += "\\]"; // a `]` in first position is a literal
    i++;
  }
  for (; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === "]") {
      if (body === "") return null;
      return { source: `[${negate ? "^" : ""}${body}]`, end: i };
    }
    if (char === "/") return null; // a class may not span segments
    body += char === "\\" || char === "[" ? `\\${char}` : char;
  }
  return null;
}

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/;

function escapeLiteral(char: string): string {
  return REGEX_METACHARS.test(char) ? `\\${char}` : char;
}

/** Drop trailing spaces/tabs unless backslash-escaped (`foo\ ` keeps its space). */
function stripTrailingSpace(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    let backslashes = 0;
    for (let i = end - 2; i >= 0 && line[i] === "\\"; i--) backslashes++;
    if (backslashes % 2 === 1) break; // escaped — this whitespace is part of the pattern
    end--;
  }
  return line.slice(0, end);
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
   * ancestor. The ingest walk gets this by never descending into an excluded
   * directory; reconstructing it here is what makes a directory-only pattern
   * (`drafts/`) also exclude the files beneath it.
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
