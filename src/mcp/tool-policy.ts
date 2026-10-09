/**
 * Obsidian Knowledge MCP v0.1: fail-closed tool admission.
 *
 * This allowlist is enforced where tools are actually registered, not merely
 * in the README. Write operations from the vendored upstream code are kept
 * for a future review/plan/apply implementation but are never advertised.
 */
export const READ_ONLY_TOOLS = new Set([
  "list_notes",
  "read_note",
  "search_notes",
  "get_note_graph",
  "parse_frontmatter",
  "generate_permalink",
  "list_tags",
  "list_backlinks",
  "read_attachment",
  "head_attachment",
  "list_attachments",
] as const);

export const REVIEWED_WRITE_TOOLS = new Set([
  "plan_note_changes","get_note_plan","apply_note_changes",
  "cancel_note_plan","plan_note_undo","list_note_history",
] as const);

export function canExposeTool(name: string, reviewedWrites = false): boolean {
  return READ_ONLY_TOOLS.has(name as never) ||
    reviewedWrites && REVIEWED_WRITE_TOOLS.has(name as never);
}
