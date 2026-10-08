/**
 * Evidence-based graph of the existing Markdown vault.
 *
 * An observed wikilink is not a verified scientific claim. Unresolved and
 * ambiguous destinations are retained as such; never invent a node relation.
 *
 * The source of truth remains R2, mirrored to Obsidian via Remotely Save.
 */
import { extractTags, extractWikilinks } from "./markdown";
import type { R2Client } from "./r2-client";

export interface GraphNode {
  path: string;
  title: string;
  tags: string[];
  metadata_parse_error?: boolean;
}
export interface GraphEdge {
  source: string;
  target: string | null;
  raw_target: string;
  kind: "wikilink";
  resolution: "resolved" | "ambiguous" | "missing";
  candidates?: string[];
}
export interface NoteSource {
  path: string;
  content: string;
}
export interface GraphPage {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_notes: number;
  scanned_notes: number;
  next_start: number | null;
  complete: boolean;
  errors: Array<{ path: string; reason: string }>;
  note: string;
}

const NOTE_ENDING = /\.md$/i;
const BINARY_ENDING = /\.(?:png|jpe?g|gif|webp|svg|pdf|mp3|mp4|canvas|excalidraw|mov|heic)$/i;

function noExt(s: string): string {
  return s.trim().replace(/\\/g, "/").replace(/\.md$/i, "").replace(/^\.\/+/, "").toLowerCase();
}
function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}
function title(path: string): string {
  return basename(path).replace(NOTE_ENDING, "");
}

/** Determine targets against the full vault, never just the current page. */
function indexPaths(paths: string[]) {
  const exact = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    if (!NOTE_ENDING.test(p)) continue;
    exact.set(noExt(p), p);
    const key = noExt(basename(p));
    const c = byName.get(key) ?? [];
    c.push(p);
    byName.set(key, c);
  }
  return { exact, byName };
}

export function graphFromNotes(
  notes: NoteSource[],
  allPaths: string[],
  start = 0,
  limit = notes.length,
  errors: GraphPage["errors"] = [],
): GraphPage {
  const { exact, byName } = indexPaths(allPaths);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const { path, content } of notes) {
    let tags: string[] = [];
    let parseError = false;
    try {
      tags = extractTags(content);
    } catch {
      parseError = true;
    }
    nodes.push({
      path, title: title(path), tags: tags.sort(),
      ...(parseError ? { metadata_parse_error: true } : {}),
    });
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    // A link can be duplicated in a note; retain one edge per unique target.
    const targets = new Set(extractWikilinks(content));
    for (const raw_target of targets) {
      if (!raw_target || BINARY_ENDING.test(raw_target)) continue;
      const normalized = noExt(raw_target);
      const exactTarget = exact.get(normalized) ?? exact.get(noExt(folder + raw_target));
      const candidates = exactTarget ? [exactTarget] : (byName.get(noExt(basename(raw_target))) ?? []);
      if (candidates.length === 1) {
        edges.push({ source: path, target: candidates[0], raw_target, kind: "wikilink", resolution: "resolved" });
      } else if (candidates.length > 1) {
        edges.push({
          source: path, target: null, raw_target, kind: "wikilink",
          resolution: "ambiguous", candidates: [...candidates].sort(),
        });
      } else {
        edges.push({ source: path, target: null, raw_target, kind: "wikilink", resolution: "missing" });
      }
    }
  }
  const scanned = notes.length;
  const nextStart = start + limit < allPaths.length ? start + limit : null;
  return {
    nodes, edges, total_notes: allPaths.length, scanned_notes: scanned,
    next_start: nextStart, complete: nextStart === null && errors.length === 0,
    errors,
    note: "Only explicit observed Markdown wikilinks. A resolved link is NOT evidence that a scientific claim is true.",
  };
}

/** Read a bounded page to respect Worker request and R2 resource limits. */
export async function buildNoteGraph(
  vault: Pick<R2Client, "listMarkdown" | "get">,
  args: { start?: number; limit?: number; prefix?: string } = {},
): Promise<GraphPage> {
  const start = Math.max(0, args.start ?? 0);
  const limit = Math.min(40, Math.max(1, args.limit ?? 20));
  const fullPaths = (await vault.listMarkdown()).filter(
    (p) => !args.prefix || p.startsWith(args.prefix),
  ).sort();
  const selected = fullPaths.slice(start, start + limit);
  const notes: NoteSource[] = [];
  const errors: GraphPage["errors"] = [];
  // Cloudflare Workers cap concurrent outgoing connections; four at a time.
  for (let i = 0; i < selected.length; i += 4) {
    const chunk = selected.slice(i, i + 4);
    const results = await Promise.all(chunk.map(async (path) => {
      try {
        const content = await vault.get(path);
        return { path, content };
      } catch {
        return { path, content: null };
      }
    }));
    for (const result of results) {
      if (result.content === null) {
        errors.push({ path: result.path, reason: "unavailable_or_changed_during_scan" });
      } else {
        notes.push({ path: result.path, content: result.content });
      }
    }
  }
  return graphFromNotes(notes, fullPaths, start, selected.length, errors);
}
