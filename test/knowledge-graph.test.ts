import { describe, expect, it } from "vitest";
import { graphFromNotes, buildNoteGraph } from "../src/vault/knowledge-graph";

describe("research vault graph", () => {
  const paths = [
    "Papers/INSES.md", "Concepts/Graph.md", "Archive/Graph.md",
    "Concepts/Similarity.md", "Questions/Open.md",
  ];

  it("resolves exact links but marks ambiguous titles and missing references", () => {
    const page = graphFromNotes([{
      path: "Papers/INSES.md",
      content: "---\ntags: [paper, kg]\n---\n[[Concepts/Similarity|similarity]]\n[[Graph]]\n[[Unknown]]\n" +
        "\`\`\`md\n[[NotARealLink]]\n\`\`\`\n![[diagram.png]]",
    }], paths, 0, 1);
    expect(page.nodes[0].tags).toEqual(["kg", "paper"]);
    expect(page.edges).toHaveLength(3);
    expect(page.edges.find(e => e.raw_target === "Concepts/Similarity")).toMatchObject({
      target: "Concepts/Similarity.md", resolution: "resolved",
    });
    expect(page.edges.find(e => e.raw_target === "Graph")).toMatchObject({
      target: null, resolution: "ambiguous",
      candidates: ["Archive/Graph.md", "Concepts/Graph.md"],
    });
    expect(page.edges.find(e => e.raw_target === "Unknown")).toMatchObject({
      target: null, resolution: "missing",
    });
    expect(page.complete).toBe(false);
    expect(page.next_start).toBe(1);
  });

  it("never invents scientific or semantic edges", () => {
    const page = graphFromNotes([
      { path: "Papers/INSES.md", content: "# INSES\nSemantic similarity to graph dismantling" },
      { path: "Questions/Open.md", content: "# Question\nAre they related?" },
    ], paths, 3, 2);
    expect(page.edges).toEqual([]);
    expect(page.complete).toBe(true);
    expect(page.next_start).toBeNull();
  });

  it("paginates R2 reads and reports unavailable files rather than claiming completeness", async () => {
    const data = new Map([["A.md", "[[B]]"], ["B.md", "hi"]]);
    const fake = {
      async listMarkdown() { return ["C.md", "B.md", "A.md"]; },
      async get(path: string) { return data.get(path) ?? null; },
    };
    const first = await buildNoteGraph(fake, { limit: 1 });
    expect(first.nodes.map(n => n.path)).toEqual(["A.md"]);
    expect(first.edges[0]).toMatchObject({ source: "A.md", target: "B.md" });
    expect(first.next_start).toBe(1);
    const last = await buildNoteGraph(fake, { start: 2, limit: 1 });
    expect(last.nodes).toEqual([]);
    expect(last.errors).toEqual([{ path: "C.md", reason: "unavailable_or_changed_during_scan" }]);
    expect(last.complete).toBe(false);
  });
});
