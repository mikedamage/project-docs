import type { Root, RootContent } from "mdast";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { toString as mdastToString } from "mdast-util-to-string";
import { unified } from "unified";
import type { RagConfig } from "./config.js";

export interface RawChunk {
  heading: string;
  text: string;
}

const markdownParser = unified().use(remarkParse);
const mdxParser = unified().use(remarkParse).use(remarkMdx);

export interface ChunkOptions {
  /**
   * Parse as MDX. Only enable for `.mdx` — the MDX extension treats `{...}` and
   * `<tag>` as JSX/expressions, which would throw on plain `.md` files that
   * contain literal `{` or `<` in prose.
   */
  mdx?: boolean;
}

/**
 * Header-aware markdown/MDX chunker built on an mdast syntax tree.
 *
 * Using the AST (rather than line regexes) means headings are real `heading`
 * nodes and code is a `code` node, so a `#`-comment inside a fenced code block
 * is never mistaken for a heading. Section text is sliced from the original
 * source via node offsets, preserving exact formatting (code fences, lists,
 * tables) in the stored chunk.
 *
 * Sections longer than `chunkSize` are split on blank-line boundaries with
 * `chunkOverlap` characters of overlap between adjacent pieces.
 */
export function chunkMarkdown(content: string, config: RagConfig, opts: ChunkOptions = {}): RawChunk[] {
  const parser = opts.mdx ? mdxParser : markdownParser;
  const tree = parser.parse(content) as Root;
  const chunks: RawChunk[] = [];

  const trail: string[] = []; // heading text indexed by (depth - 1)
  let sectionNodes: RootContent[] = [];

  const flush = () => {
    const text = sliceNodes(content, sectionNodes).trim();
    sectionNodes = [];
    if (!text) return;
    const heading = trail.filter(Boolean).join(" > ");
    for (const piece of splitLongText(text, config.chunkSize, config.chunkOverlap)) {
      chunks.push({ heading, text: piece });
    }
  };

  for (const node of tree.children) {
    if (node.type === "heading") {
      flush();
      trail.length = node.depth - 1; // drop deeper/sibling headings
      trail[node.depth - 1] = mdastToString(node).trim();
    } else {
      sectionNodes.push(node);
    }
  }
  flush();
  return chunks;
}

/** Reconstruct source text spanning a group of sibling nodes, via offsets. */
function sliceNodes(content: string, nodes: RootContent[]): string {
  if (nodes.length === 0) return "";
  const start = nodes[0]!.position?.start.offset;
  const end = nodes[nodes.length - 1]!.position?.end.offset;
  if (start == null || end == null) {
    // Fallback for nodes without position info (shouldn't happen after parse).
    return nodes.map((n) => mdastToString(n)).join("\n\n");
  }
  return content.slice(start, end);
}

/** Split text into <=maxSize pieces on blank-line boundaries, with overlap. */
function splitLongText(text: string, maxSize: number, overlap: number): string[] {
  if (text.length <= maxSize) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const pieces: string[] = [];
  let current = "";

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) pieces.push(trimmed);
  };

  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxSize) {
      push();
      current = overlap > 0 ? current.slice(-overlap) + "\n\n" + para : para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
    // A single paragraph larger than maxSize gets hard-split.
    while (current.length > maxSize) {
      pieces.push(current.slice(0, maxSize).trim());
      current = current.slice(maxSize - overlap);
    }
  }
  push();
  return pieces;
}
