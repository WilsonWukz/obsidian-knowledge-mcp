import { describe, it, expect } from "vitest";
import { canExposeTool, READ_ONLY_TOOLS } from "../src/mcp/tool-policy";

describe("v0.1 remote MCP default-deny tool policy", () => {
  it("allows exactly the audited read-only API", () => {
    expect(READ_ONLY_TOOLS.size).toBe(11);
    for (const name of READ_ONLY_TOOLS) expect(canExposeTool(name)).toBe(true);
  });

  it("rejects upstream direct writes, admin actions, and unexpected future tools", () => {
    const blocked = [
      "create_note", "replace_note", "replace_body", "patch_note",
      "move_note", "delete_note", "patch_frontmatter",
      "periodic_note_get_or_create", "periodic_note_append", "backfill_ids",
      "upload_attachment_url", "create_upload_link", "move_attachment",
      "delete_attachment", "plan_changes", "apply_changes", "unknown",
    ];
    for (const name of blocked) expect(canExposeTool(name), name).toBe(false);
  });
});
