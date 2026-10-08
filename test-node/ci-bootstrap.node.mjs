import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrivateEnv } from "../scripts/ci-bootstrap.mjs";
import { parseNamespaceList, stripCustomDomainRoute } from "../scripts/setup.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("Cloudflare CI bootstrap is test-vault only, excludes credentials", () => {
  const config = renderPrivateEnv({
    accountId: "a".repeat(32),
    bucketName: "wilson-obsidian-mcp-test",
  });
  assert.match(config, /R2_BUCKET_NAME=wilson-obsidian-mcp-test/);
  assert.match(config, /CLOUDFLARE_ACCOUNT_ID=a{32}/);
  assert.doesNotMatch(config, /API_TOKEN|AUTH_PASSWORD|SECRET/);
  assert.match(config, /MCP_HOSTNAME=\n/);
  assert.match(config, /ENABLE_REVIEWED_WRITES=false/);
});
test("reviewed writes require an explicit opt-in and a trusted public origin", () => {
  const config=renderPrivateEnv({
    accountId:"a".repeat(32),bucketName:"wilson-obsidian-mcp-test",
    enableReviewedWrites:"true",
    publicOrigin:"https://obsidian-knowledge-mcp.wilsonkwu.workers.dev",
  });
  assert.match(config,/ENABLE_REVIEWED_WRITES=true/);
  assert.match(config,/SERVICE_BASE_URL=https:\/\/obsidian-knowledge-mcp\.wilsonkwu\.workers\.dev/);
  assert.throws(()=>renderPrivateEnv({
    accountId:"a".repeat(32),bucketName:"wilson-obsidian-mcp-test",
    publicOrigin:"https://attacker.example",
  }),/Worker public origin/);
});
test("Cloudflare CI refuses invalid account or production bucket", () => {
  assert.throws(() => renderPrivateEnv({ accountId: "bad", bucketName: "vault-test" }), /Account ID/i);
  assert.throws(() => renderPrivateEnv({ accountId: "a".repeat(32), bucketName: "research-real" }), /test bucket/i);
  assert.throws(() => renderPrivateEnv({ accountId: "a".repeat(32), bucketName: "../vault-test" }), /bucket name/i);
});
test("KV list parser accepts Wrangler JSON plus prefix and rejects malformed entries", () => {
  const id = "b".repeat(32);
  assert.deepEqual(parseNamespaceList('[{"title":"obsidian-knowledge-mcp-oauth","id":"' + id + '"}]'),
    [{ title: "obsidian-knowledge-mcp-oauth", id }]);
  assert.deepEqual(parseNamespaceList('Info\n[]\n'), []);
  assert.throws(() => parseNamespaceList("garbled"), /list returned/i);
  assert.throws(() => parseNamespaceList('[{"title":"other","id":"bad"}]'), /format/i);
});

test("workers.dev strips the whole custom domain block in the REAL Wrangler template", () => {
  const template = readFileSync(
    fileURLToPath(new URL("../wrangler.example.jsonc", import.meta.url)),
    "utf8",
  );
  const output = stripCustomDomainRoute(template);
  assert.doesNotMatch(output, /"routes"\s*:/);
  assert.doesNotMatch(output, /"custom_domain"\s*:/);
  assert.doesNotMatch(output, /\$\{MCP_HOSTNAME\}/);
  assert.match(output, /"r2_buckets"/);
  assert.match(output, /"durable_objects"/);
  assert.match(output, /"kv_namespaces"/);
  assert.doesNotThrow(() => {
    const text = output.replace(/^\s*\/\/.*$/gm, "");
    JSON.parse(text);
  });
});

test("workers.dev deployment aborts when custom route template is unexpected", () => {
  assert.throws(() => stripCustomDomainRoute("{}"), /Could not safely remove/);
  assert.throws(
    () => stripCustomDomainRoute('{"routes": [{"pattern": "bad.example.org", "custom_domain": true}]}'),
    /Could not safely remove/,
  );
});
