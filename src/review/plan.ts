/** Safe, deterministic per-note change preparation. No storage mutations. */
import { editFrontmatter, BlockValueError, type FrontmatterScalar } from "../vault/frontmatter-edit";
import {
  ensureIdInFrontmatter, extractIdFromFrontmatter, generateNoteId,
  setIdInFrontmatter, MalformedFrontmatterError, parseNote,
} from "../vault/markdown";
import type { R2Client } from "../vault/r2-client";

/** Exclusive AI write subtree. Everything else in the user's vault is read-only. */
export const WRITE_PREFIX = "INSES/";
export const MAX_ACTIONS = 5;
export const MAX_NOTE_BYTES = 96_000;
export const MAX_PLAN_BYTES = 700_000;

export type FmValue = FrontmatterScalar | FrontmatterScalar[];
export type NoteAction =
  | { action: "create_note"; path: string; content: string }
  | { action: "replace_note"; path: string; content: string }
  | { action: "patch_note"; path: string; old_text: string; new_text: string }
  | { action: "patch_frontmatter"; path: string; set?: Record<string, FmValue>; unset?: string[] };

export type PlannedStep = {
  action: string;
  path: string;
  before: string | null;
  before_etag: string | null;
  after: string;
};
export interface ImmutableNotePlan {
  steps: PlannedStep[];
  undo_of?: string;
  note: string;
}

export class PlanError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "PlanError";
  }
}

export function validateWritablePath(path: string): void {
  if (typeof path !== "string" || path.length < 10 || path.length > 220 ||
      !path.startsWith(WRITE_PREFIX) || !path.endsWith(".md") ||
      path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")) ||
      path.includes("//") || path.includes("%2f") || path.includes("%2F")) {
    throw new PlanError("PATH_OUT_OF_SCOPE", "Writes are restricted to INSES/*.md and its safe subfolders");
  }
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function validContent(value: unknown): value is string {
  return typeof value === "string" && bytes(value) <= MAX_NOTE_BYTES;
}
function assertFields(obj: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(obj).some(k => !allowed.includes(k))) throw new PlanError("INVALID_ACTION_FIELDS");
}
function validFmSet(set: unknown): set is Record<string, FmValue> {
  if (set === undefined) return true;
  if (!set || typeof set !== "object" || Array.isArray(set)) return false;
  const o = set as Record<string, unknown>;
  if (Object.keys(o).length > 40) return false;
  const scalar = (v: unknown): v is FrontmatterScalar =>
    typeof v === "string" && v.length <= 500 && !/[\x00-\x1f\x7f]/.test(v) ||
    typeof v === "boolean" ||
    typeof v === "number" && Number.isFinite(v);
  return Object.entries(o).every(([k,v]) =>
    /^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/.test(k) && k !== "id" &&
    (Array.isArray(v) ? v.length <= 40 && v.every(scalar) : scalar(v)),
  );
}
function validFmUnset(unset: unknown): unset is string[] {
  if (unset === undefined) return true;
  return Array.isArray(unset) && unset.length <= 40 &&
    unset.every(k => typeof k === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/.test(k) && k !== "id");
}
export function validateActions(value: unknown): NoteAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTIONS) {
    throw new PlanError("INVALID_ACTION_COUNT", "Each reviewed batch supports 1-5 note changes");
  }
  const used = new Set<string>();
  for (const action of value) {
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new PlanError("INVALID_ACTION");
    const a = action as Record<string, unknown>;
    validateWritablePath(a.path as string);
    if (used.has(a.path as string)) throw new PlanError("OVERLAPPING_PATHS", "Each plan can modify a path only once");
    used.add(a.path as string);
    switch (a.action) {
      case "create_note":
      case "replace_note":
        assertFields(a, ["action","path","content"]);
        if (!validContent(a.content)) throw new PlanError("INVALID_CONTENT", "Markdown note too large");
        break;
      case "patch_note":
        assertFields(a, ["action","path","old_text","new_text"]);
        if (typeof a.old_text !== "string" || a.old_text.length < 1 ||
            a.old_text.length > 16_000 || !validContent(a.new_text)) throw new PlanError("INVALID_PATCH");
        break;
      case "patch_frontmatter":
        assertFields(a, ["action","path","set","unset"]);
        if (!validFmSet(a.set) || !validFmUnset(a.unset) ||
            (!Object.keys(a.set ?? {}).length && !(a.unset as string[] | undefined)?.length)) {
          throw new PlanError("INVALID_FRONTMATTER");
        }
        break;
      default:
        throw new PlanError("UNSUPPORTED_ACTION", "This version supports only controlled note creation/edits");
    }
  }
  return value as NoteAction[];
}

export function proposeAfter(action: NoteAction, before: string | null): string {
  if (action.action === "create_note") {
    if (before !== null) throw new PlanError("ALREADY_EXISTS");
    try { return ensureIdInFrontmatter(action.content, generateNoteId).content; }
    catch { throw new PlanError("MALFORMED_FRONTMATTER"); }
  }
  if (before === null) throw new PlanError("NOTE_NOT_FOUND");
  try {
    switch (action.action) {
      case "replace_note": {
        const id = extractIdFromFrontmatter(before);
        return id ? setIdInFrontmatter(action.content, id)
          : ensureIdInFrontmatter(action.content, generateNoteId).content;
      }
      case "patch_note": {
        const first = before.indexOf(action.old_text);
        if (first === -1) throw new PlanError("PATCH_ANCHOR_MISSING");
        if (before.indexOf(action.old_text, first + action.old_text.length) !== -1) {
          throw new PlanError("PATCH_ANCHOR_AMBIGUOUS");
        }
        return before.slice(0, first) + action.new_text + before.slice(first + action.old_text.length);
      }
      case "patch_frontmatter": {
        const edited = editFrontmatter(before, { set: action.set, unset: action.unset });
        return ensureIdInFrontmatter(edited.content, generateNoteId).content;
      }
    }
  } catch(e) {
    if (e instanceof PlanError) throw e;
    if (e instanceof MalformedFrontmatterError || e instanceof BlockValueError) {
      throw new PlanError("UNSAFE_FRONTMATTER", "Unsupported or malformed YAML block; edit locally first");
    }
    throw new PlanError("INVALID_NOTE_CONTENT");
  }
}
function validateNoteYAML(content: string) {
  try {
    parseNote(content);
  } catch {
    throw new PlanError("INVALID_YAML", "Obsidian YAML frontmatter is invalid");
  }
  if (!validContent(content)) throw new PlanError("NOTE_TOO_LARGE");
}
export async function prepareNoteChanges(
  vault: Pick<R2Client,"getWithEtag">,
  submitted: unknown,
): Promise<ImmutableNotePlan> {
  const actions = validateActions(submitted);
  const steps: PlannedStep[] = [];
  for(const action of actions) {
    const original = await vault.getWithEtag(action.path);
    const before = original?.body ?? null;
    const after = proposeAfter(action,before);
    // Never change or remove an existing note's stable Obsidian ID.
    if (before !== null) {
      const oldId=extractIdFromFrontmatter(before);
      if (oldId && extractIdFromFrontmatter(after)!==oldId) {
        throw new PlanError("STABLE_NOTE_ID_REQUIRED","Existing note id must not change");
      }
    }
    validateNoteYAML(after);
    if (before === after) throw new PlanError("NO_OP");
    steps.push({
      action: action.action, path:action.path, before,
      before_etag: original?.etag ?? null, after,
    });
  }
  const plan:ImmutableNotePlan = {
    steps,
    note: "Exact browser-reviewed Markdown changes. Cloud R2 ETags are checked at execution. An offline Mac may still have unsynced edits; confirm devices are synced before approving.",
  };
  if (bytes(JSON.stringify(plan)) > MAX_PLAN_BYTES) throw new PlanError("PLAN_TOO_LARGE");
  return plan;
}
export function previewPlan(plan: ImmutableNotePlan) {
  return plan.steps.map(s => ({
    action:s.action, path:s.path, before_etag:s.before_etag,
    before:s.before, after:s.after,
  }));
}
export async function digestPlan(plan: ImmutableNotePlan): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(plan));
  const d = await crypto.subtle.digest("SHA-256",raw);
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
