import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import AuthHandler from "../src/auth/handler";
import { VERSION } from "../src/version";

describe("GET /health", () => {
  it("returns ok + service + the package version, unauthenticated", async () => {
    const res = await AuthHandler.fetch(new Request("https://obsv.scriptek.com/health"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ok: boolean; service: string; version: string; reviewed_writes_enabled: boolean };
    expect(body).toEqual({ ok: true, service: "obsidian-mcp", version: VERSION, reviewed_writes_enabled: false });
    const writeRes = await AuthHandler.fetch(new Request("https://obsv.scriptek.com/health"),
      { ...env, ENABLE_REVIEWED_WRITES: "true" } as unknown as Env);
    expect((await writeRes.json() as { reviewed_writes_enabled: boolean }).reviewed_writes_enabled).toBe(true);
  });
});
