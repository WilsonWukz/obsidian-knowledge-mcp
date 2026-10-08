#!/usr/bin/env node
// Read .env, ensure the R2 bucket and KV namespace exist, then substitute
// ${PLACEHOLDER} tokens in wrangler.example.jsonc into wrangler.jsonc.
//
// Idempotent — safe to re-run. No npm dependencies; uses only Node built-ins.
// All shell-outs go through execFileSync (no shell interpolation) so values
// pulled from .env can't be turned into command injection.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const ENV_PATH = join(ROOT, ".env");
const TEMPLATE_PATH = join(ROOT, "wrangler.example.jsonc");
const OUT_PATH = join(ROOT, "wrangler.jsonc");

const REQUIRED = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET_NAME"];
const OAUTH_KV_TITLE = "obsidian-knowledge-mcp-oauth";

function parseEnv(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// KV namespace ids aren't credentials, but echoing the full value into setup
// output (terminal scrollback / CI logs) is needless. For the freshly-created
// id we show enough head+tail to identify the namespace without printing it
// whole. For the already-configured case we don't echo it at all — it's already
// in .env, and routing the OAUTH_KV_ID value (any substring of it) into a log
// trips CodeQL's clear-text-logging taint, so we keep that value out of logs.
function maskId(id) {
  if (!id || id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function runWrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ensureR2Bucket(name) {
  process.stdout.write(`R2 bucket "${name}"... `);
  try {
    runWrangler(["r2", "bucket", "create", name]);
    console.log("created");
  } catch (e) {
    const msg = String(e.stderr || e.message || "").toLowerCase();
    if (msg.includes("already exists") || msg.includes("bucketalreadyowned")) {
      console.log("already exists");
      return;
    }
    console.log("FAILED");
    console.error(e.stderr || e.message);
    process.exit(1);
  }
}

/** Reuse a stable, named OAuth KV namespace across fresh CI runners. */
export function parseNamespaceList(output) {
  const first = output.indexOf("[");
  const last = output.lastIndexOf("]");
  if (first < 0 || last < first) throw new Error("No JSON namespace list returned by Wrangler");
  const namespaces = JSON.parse(output.slice(first, last + 1));
  if (!Array.isArray(namespaces) ||
      namespaces.some(n => !n || typeof n.title !== "string" ||
        typeof n.id !== "string" || !/^[a-f0-9]{32}$/.test(n.id))) {
    throw new Error("Unexpected KV namespace list format");
  }
  return namespaces;
}

function recordKvId(env, id) {
  env.OAUTH_KV_ID = id;
  appendFileSync(ENV_PATH, "\n# reused or newly created OAuth namespace\nOAUTH_KV_ID=" + id + "\n");
}

function ensureKvNamespace(env) {
  if (env.OAUTH_KV_ID) {
    if (!/^[a-f0-9]{32}$/.test(env.OAUTH_KV_ID)) {
      throw new Error("OAUTH_KV_ID is not a valid namespace ID");
    }
    console.log("OAuth KV: reusing explicit namespace ID");
    return;
  }
  const namespaces = parseNamespaceList(runWrangler(["kv", "namespace", "list"]));
  const matching = namespaces.filter(item => item.title === OAUTH_KV_TITLE);
  if (matching.length > 1) {
    throw new Error("Multiple OAuth namespaces have the same name; manual review required");
  }
  if (matching.length === 1) {
    recordKvId(env, matching[0].id);
    console.log("OAuth KV: reused the existing named namespace");
    return;
  }
  const output = runWrangler(["kv", "namespace", "create", OAUTH_KV_TITLE]);
  const match = output.match(/(?:id\s*[=:]\s*"?|"id"\s*:\s*")([0-9a-f]{32})"?/);
  if (!match) {
    throw new Error("KV creation succeeded but namespace ID was not recognized; inspect account before retry");
  }
  recordKvId(env, match[1]);
  console.log("OAuth KV: created a dedicated named namespace");
}

function applyDefaults(env) {
  if (!env.MCP_HOSTNAME) env.MCP_HOSTNAME = "";
  if (!env.SERVICE_BASE_URL) env.SERVICE_BASE_URL = env.MCP_HOSTNAME ? "https://" + env.MCP_HOSTNAME : "";
  if (env.VAULT_PREFIX === undefined) env.VAULT_PREFIX = "";
  if (env.DAILY_NOTE_PATH_TEMPLATE === undefined) env.DAILY_NOTE_PATH_TEMPLATE = "Daily Notes/{{YYYY-MM-DD}}.md";
  // Other periodic cadences default to empty (disabled) — opt in per cadence.
  for (const v of [
    "WEEKLY_NOTE_PATH_TEMPLATE",
    "MONTHLY_NOTE_PATH_TEMPLATE",
    "QUARTERLY_NOTE_PATH_TEMPLATE",
    "YEARLY_NOTE_PATH_TEMPLATE",
  ]) {
    if (env[v] === undefined) env[v] = "";
  }
  if (env.PERMALINK_BASE_URL === undefined) env.PERMALINK_BASE_URL = "";
  // Default-closed: empty means upload_attachment_url can fetch from no host.
  if (env.ATTACHMENT_FETCH_HOST_ALLOWLIST === undefined) env.ATTACHMENT_FETCH_HOST_ALLOWLIST = "";
}

function verifyAccount(accountId) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("Account ID must be exactly 32 hexadecimal characters");
  // CI uses an account-scoped token; whoami requires extra membership scopes.
  // Actual resource calls will still independently verify Cloudflare access.
  if (process.env.CLOUDFLARE_API_TOKEN &&
      process.env.CLOUDFLARE_ACCOUNT_ID === accountId) {
    console.log("Cloudflare API token supplied for noninteractive deployment");
    return;
  }
  process.stdout.write(`wrangler auth... `);
  let whoami;
  try {
    whoami = runWrangler(["whoami"]);
  } catch (e) {
    console.log("FAILED");
    console.error("`npx wrangler whoami` failed — run `npx wrangler login` first.");
    process.exit(1);
  }
  if (!whoami.includes(accountId)) {
    console.log("WRONG ACCOUNT");
    console.error(`Expected account id ${accountId} but wrangler is logged into a different one.`);
    console.error(`Run \`npx wrangler logout && npx wrangler login\` and pick the correct account.`);
    process.exit(1);
  }
  console.log(`account ${accountId}`);
}

/**
 * Free workers.dev mode: strip the entire custom domain block before
 * substituting environment variables. The previous regex used [^}]*,
 * stopped at the end of a placeholder token and left an invalid hostname.
 * Refuse deployment if the template changes.
 */
export function stripCustomDomainRoute(config) {
  const route = /\s*"routes":\s*\[\s*\{\s*"pattern":\s*"\$\{MCP_HOSTNAME\}"\s*,\s*"custom_domain":\s*true\s*\}\s*\]\s*,/;
  const result = config.replace(route, "");
  if (result === config ||
      /"routes"\s*:/.test(result) ||
      /"custom_domain"\s*:/.test(result)) {
    throw new Error("Could not safely remove Cloudflare custom domain routes");
  }
  return result;
}

function main() {
  if (!existsSync(ENV_PATH)) {
    console.error("error: .env not found.");
    console.error("       cp .env.example .env, then edit .env to fill in your values.");
    process.exit(1);
  }
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`error: ${TEMPLATE_PATH} not found.`);
    process.exit(1);
  }

  const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
  applyDefaults(env);

  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`error: .env is missing required values: ${missing.join(", ")}`);
    process.exit(1);
  }

  verifyAccount(env.CLOUDFLARE_ACCOUNT_ID);
  ensureR2Bucket(env.R2_BUCKET_NAME);
  ensureKvNamespace(env);

  let out = readFileSync(TEMPLATE_PATH, "utf8");
  // Fail closed if the template changes; never submit an empty custom hostname.
  if (!env.MCP_HOSTNAME) {
    out = stripCustomDomainRoute(out);
  }
  out = out.replace(
    /^(\/\/[^\n]*\n)+/,
    "// Generated by scripts/setup.mjs from wrangler.example.jsonc + .env.\n" +
    "// Edit .env and rerun `npm run setup` rather than editing this file.\n",
  );
  out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key) => {
    if (!(key in env)) {
      console.error(`error: template references \${${key}} but .env has no such key.`);
      process.exit(1);
    }
    return env[key];
  });

  writeFileSync(OUT_PATH, out);
  console.log(`wrote ${OUT_PATH}`);
  console.log("");
  console.log("next steps:");
  console.log("  1. npx wrangler secret put AUTH_PASSWORD   # set OAuth password (first time only)");
  console.log("  2. npm test                                 # verify");
  console.log("  3. npx wrangler deploy                      # deploy");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
