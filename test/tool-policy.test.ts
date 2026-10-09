import { describe, it, expect } from "vitest";
import { canExposeTool, READ_ONLY_TOOLS, REVIEWED_WRITE_TOOLS } from "../src/mcp/tool-policy";

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

describe("reviewed writes are independent of upstream direct writes", () => {
  it("exposes exactly 6 plan tools with an explicit host opt-in", () => {
    expect(REVIEWED_WRITE_TOOLS.size).toBe(6);
    for(const name of REVIEWED_WRITE_TOOLS) {
      expect(canExposeTool(name)).toBe(false);
      expect(canExposeTool(name,true)).toBe(true);
    }
  });
  it("never exposes unreviewed upstream direct mutations", () => {
    for(const name of [
      "create_note","replace_note","replace_body","patch_note",
      "patch_frontmatter","move_note","delete_note","delete_attachment",
      "upload_attachment_url","create_upload_link","backfill_ids",
    ]) expect(canExposeTool(name,true),name).toBe(false);
  });
});
