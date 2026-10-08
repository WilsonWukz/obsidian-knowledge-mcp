#!/usr/bin/env node
/** GitHub Actions bootstrap. Secrets remain in Actions env, not on disk. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function renderPrivateEnv({ accountId, bucketName }) {
  if (!/^[a-f0-9]{32}$/.test(accountId || "")) {
    throw new Error("Invalid Cloudflare account ID: expected 32 hex characters");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(bucketName || "")) {
    throw new Error("R2 bucket name must be 3-63 lowercase letters, numbers or hyphens");
  }
  if (!bucketName.includes("test")) {
    throw new Error("v0.1 bootstrap only deploys to a dedicated test bucket");
  }
  // No OAuth password or Cloudflare API token is written to this file.
  return [
    "CLOUDFLARE_ACCOUNT_ID=" + accountId,
    "R2_BUCKET_NAME=" + bucketName,
    "MCP_HOSTNAME=",
    "SERVICE_BASE_URL=",
    "OAUTH_KV_ID=",
    "VAULT_PREFIX=",
    "ATTACHMENT_FETCH_HOST_ALLOWLIST=",
    "",
  ].join("\n");
}

function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN.length < 20) {
    throw new Error("Missing CLOUDFLARE_API_TOKEN Actions secret");
  }
  if (!process.env.OBSIDIAN_MCP_AUTH_PASSWORD ||
      process.env.OBSIDIAN_MCP_AUTH_PASSWORD.length < 32) {
    throw new Error("Missing OBSIDIAN_MCP_AUTH_PASSWORD (minimum 32 characters)");
  }
  const privateEnv = renderPrivateEnv({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    bucketName: process.env.R2_BUCKET_NAME,
  });
  writeFileSync(".env", privateEnv, { mode: 0o600, flag: "w" });
  console.log("Validated Cloudflare inputs and created private account configuration");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
