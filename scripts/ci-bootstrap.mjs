#!/usr/bin/env node
/** GitHub Actions bootstrap. Secrets remain in Actions env, not on disk. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function renderPrivateEnv({ accountId, bucketName, publicOrigin = "", enableReviewedWrites = false,
  enableGuardedSyncApi = false, enableSyncAdoption = false, guardedSyncCutover = false,
  legacyWritersRevoked = false,
}) {
  if (!/^[a-f0-9]{32}$/.test(accountId || "")) {
    throw new Error("Invalid Cloudflare account ID: expected 32 hex characters");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(bucketName || "")) {
    throw new Error("R2 bucket name must be 3-63 lowercase letters, numbers or hyphens");
  }
  if (!bucketName.includes("test")) {
    throw new Error("v0.1 bootstrap only deploys to a dedicated test bucket");
  }
  // Public origin (not a secret) is used for exact-diff browser-review links.
  // Only a dedicated HTTPS Worker origin is accepted; never let CI user input
  // redirect approval links to a different service.
  if (publicOrigin) {
    let u;
    try { u = new URL(publicOrigin); } catch { throw new Error("Invalid Worker public origin"); }
    if (u.protocol !== "https:" || !u.hostname.endsWith(".workers.dev") ||
        u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
      throw new Error("Worker public origin must be a standalone HTTPS workers.dev host");
    }
  }
  const reviewed = enableReviewedWrites === true || enableReviewedWrites === "true";
  if (![true, false, "true", "false"].includes(enableReviewedWrites)) {
    throw new Error("enableReviewedWrites must be a boolean");
  }
  if(reviewed && !publicOrigin){
    throw new Error("Reviewed writes require a verified public Worker origin for the owner review page");
  }
  const bool = (x,label) => {
    if(![true,false,"true","false"].includes(x))throw new Error(label+" must be boolean");
    return x===true || x==="true";
  };
  const syncApi=bool(enableGuardedSyncApi,"enableGuardedSyncApi");
  const adoption=bool(enableSyncAdoption,"enableSyncAdoption");
  const cutover=bool(guardedSyncCutover,"guardedSyncCutover");
  const revoked=bool(legacyWritersRevoked,"legacyWritersRevoked");
  if((adoption||cutover)&&!syncApi)throw new Error("Guarded sync mode requires owner API");
  if(adoption&&cutover)throw new Error("Cannot adopt and cut over in one deployment");
  if(cutover&&!revoked)throw new Error("Cutover denied: legacy R2/S3 writers not revoked");
  // No OAuth password or Cloudflare API token is written to this file.
  return [
    "CLOUDFLARE_ACCOUNT_ID=" + accountId,
    "R2_BUCKET_NAME=" + bucketName,
    "MCP_HOSTNAME=",
    "SERVICE_BASE_URL=" + publicOrigin,
    "ENABLE_REVIEWED_WRITES=" + (reviewed ? "true" : "false"),
    "ENABLE_GUARDED_SYNC=" + (syncApi ? "true" : "false"),
    "ENABLE_GUARDED_SYNC_API=" + (syncApi ? "true" : "false"),
    "ENABLE_SYNC_ADOPTION=" + (adoption ? "true" : "false"),
    "GUARDED_SYNC_CUTOVER=" + (cutover ? "true" : "false"),
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
    publicOrigin: process.env.WORKER_PUBLIC_ORIGIN ?? "",
    enableReviewedWrites: process.env.ENABLE_REVIEWED_WRITES ?? "false",
    enableGuardedSyncApi: process.env.ENABLE_GUARDED_SYNC_API ?? "false",
    enableSyncAdoption: process.env.ENABLE_SYNC_ADOPTION ?? "false",
    guardedSyncCutover: process.env.GUARDED_SYNC_CUTOVER ?? "false",
    legacyWritersRevoked: process.env.LEGACY_WRITERS_REVOKED ?? "false",
  });
  if(process.env.ENABLE_GUARDED_SYNC_API==="true" &&
     (!process.env.OBSIDIAN_SYNC_OWNER_TOKEN || process.env.OBSIDIAN_SYNC_OWNER_TOKEN.length<32))
    throw new Error("Missing OBSIDIAN_SYNC_OWNER_TOKEN GitHub secret (32+ characters)");
  writeFileSync(".env", privateEnv, { mode: 0o600, flag: "w" });
  console.log("Validated Cloudflare inputs and created private account configuration");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
