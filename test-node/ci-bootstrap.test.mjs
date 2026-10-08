import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrivateEnv } from "../scripts/ci-bootstrap.mjs";
import { parseNamespaceList } from "../scripts/setup.mjs";

test("Cloudflare CI bootstrap is test-vault only, excludes credentials", () => {
  const config = renderPrivateEnv({
    accountId: "a".repeat(32),
    bucketName: "wilson-obsidian-mcp-test",
  });
  assert.match(config, /R2_BUCKET_NAME=wilson-obsidian-mcp-test/);
  assert.match(config, /CLOUDFLARE_ACCOUNT_ID=a{32}/);
  assert.doesNotMatch(config, /API_TOKEN|AUTH_PASSWORD|SECRET/);
  assert.match(config, /MCP_HOSTNAME=\n/);
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
