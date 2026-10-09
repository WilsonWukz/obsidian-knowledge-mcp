import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NotePathInput, isSafeMarkdownPath } from "../src/mcp/note-path";
import { R2Client } from "../src/vault/r2-client";
import { makeCfg } from "./_helpers";
import { readNote } from "../src/mcp/tools/notes";
import { parseFrontmatter, generatePermalink } from "../src/mcp/tools/metadata";

describe("Slack-compatible MCP Markdown tool path contract", () => {
  it("emits an unconstrained JSON Schema string WITHOUT pattern", () => {
    const published = z.toJSONSchema(NotePathInput);
    expect(published.type).toBe("string");
    expect(JSON.stringify(published)).not.toContain('"pattern"');
    expect(NotePathInput.parse("INSES/M00-关系总览.md")).toBe("INSES/M00-关系总览.md");
  });

  it("accepts legitimate root, nested, Unicode and uppercase Markdown paths", () => {
    for (const path of ["Graph.md", "INSES-test.md", "INSES/M00-关系总览.md",
      "INSES/论文 资料/参考-α.MD"]) {
      expect(isSafeMarkdownPath(path), path).toBe(true);
    }
  });

  it("rejects non-Markdown, traversal, absolute paths, hidden config and controls", () => {
    for (const path of ["INSES/data.txt", "INSES/paper.pdf", "../Secrets.md",
      "INSES/../Secrets.md", "/INSES/M00.md", "INSES\\a.md",
      "INSES//M00.md", ".obsidian/private.md", "INSES/.hidden.md",
      "INSES/%2e%2e/x.md", "INSES/%2f/x.md", "INSES/line\nfeed.md",
      "INSES/foo.md/anything", "", "M00.md?x=1"]) {
      expect(isSafeMarkdownPath(path), path).toBe(false);
    }
  });

  it("rejects unsafe filenames BEFORE accessing storage in all three read tools", async () => {
    const cfg={...makeCfg(),permalinkBaseUrl:"https://example.test"};
    const vault = new R2Client(env.VAULT, cfg);
    for (const path of ["INSES/../Secrets.md","INSES/private.pdf","INSES/.secrets.md"]) {
      for (const call of [
        ()=>readNote(vault,cfg,{path}),
        ()=>parseFrontmatter(vault,cfg,{path}),
        ()=>generatePermalink(vault,cfg,{path}),
      ]) {
        expect(await call(),path).toEqual({ok:false,reason:"invalid_path",path});
      }
    }
  });

  it("reads an actual Chinese-named Markdown note via the same paths Slack rejected", async () => {
    const cfg=makeCfg();
    const vault=new R2Client(env.VAULT,cfg);
    const path="INSES/schema-兼容-"+crypto.randomUUID()+".md";
    const content="---\ntitle: Schema compatibility\n---\n# 正文";
    await vault.put(path,content);
    const read=await readNote(vault,cfg,{path});
    expect(read.ok).toBe(true);
    if(read.ok) expect(read.value.content).toBe(content);
    const frontmatter=await parseFrontmatter(vault,cfg,{path});
    expect(frontmatter.ok).toBe(true);
    if(frontmatter.ok) expect(frontmatter.value.frontmatter.title).toBe("Schema compatibility");
  });
});
