# Guarded Sync Phase B — isolated persistent revision backend

Status: **DEVELOPMENT / NO LIVE VAULT WRITES**. This implements a private Durable Object ledger plus an independent R2 object bucket, not the full safe-sync product.

## Persistent objects

- New R2 binding: **`SYNC_OBJECTS`**, pointing to a **separate bucket** inaccessible to Remotely Save, Mac S3 clients, and unrelated Workers. It must never use the existing `VAULT` bucket.
- Content-addressed paths: `v1/blobs/<prefix>/<sha256>.txt`, `v1/trees/<tree_hash>.json`, `v1/commits/<commit_id>.json`.
- Every object is staged with a conditional create. If already present, its exact contents must match; after creation, its contents are read back. A corrupt or missing object fails closed.
- Dedicated `GuardedSyncLedger` SQL Durable Object with tables `sync_commits` and `sync_refs`. A single SQLite transaction inserts the revision metadata and conditionally updates HEAD only when `expectedHead` equals the current HEAD.
- The immutable R2 objects are staged **before** the transactional HEAD swap. A failed upload leaves old HEAD untouched; a failed/head-raced CAS may leave unreachable staged objects, which cannot be mistaken for published revisions. No background cleanup or automatic retry in this phase.
- `GET revision` and `read_file` only follow committed SQLite metadata. Staged-but-orphaned objects are not readable as published revisions.

## Safety invariants and limitations

**Current phase B code never modifies `env.VAULT`, registers no external route/tool for the sync DO, and does not deploy to production.** It is tested with `SYNC_OBJECTS` and `SYNC_LEDGER` only in `wrangler.test.jsonc`. The `ENABLE_GUARDED_SYNC` flag is true only in the synthetic test configuration. Existing reviewed MCP writes and Remotely Save continue as before and are **not covered** by this new mechanism.

**All files inside a snapshot are explicitly copied to every new revision** (max 650 KB serialized commit, 96 KB per Markdown note, 5 changed notes per commit); this makes v0.3 Phase B deliberately conservative. For large research vaults, introduce a true sparse commit/tree schema and bounded pagination before adoption. Keep exact backup copies in external storage; do not GC or delete staged objects yet.

**Semantic group metadata is currently supplied by the caller**. It is not itself proof that all associated relation files were included. Before accepting real Mac or Agent edits, generate/verify relationship coverage server-side (from relation IDs, evidence references, and dependency metadata) or fail closed; **do not enable automatic merging of relationship edits with unknown dependencies**.

**Owner trust & gateway remain unimplemented.** The DO fetch interface is privileged and must remain unreachable from public HTTP/MCP. An eventual gateway must verify OAuth identity, bind actor to authenticated client, require independent owner review for Agent writes, validate state, enforce quotas and rate limiting, and reject a public attempt to `bootstrap` or `push` without specific authorization. Do not expose a direct public DO URL.

**External R2 writers are still a blocking cutover issue.** Mac Remotely Save and direct S3 credentials can continue to bypass protected head CAS for the main VAULT. A real safe-sync rollout must exclusively route writes for protected INSES notes through the new gateway and remove old write permissions. Before this, no Git-like safety guarantee can be made.

## Reproduction

```bash
# Fast protocol tests, SQLite transaction + simulated R2 crashes
node --experimental-strip-types --test test-node/*.node.mjs

# Full Cloudflare Workers integration & existing security tests
npm ci
npm test
npx wrangler types --config wrangler.test.jsonc
npx tsc --noEmit
```

The new `test/persistent-sync.test.ts` exercises Durable Object re-instantiation, live SQLite/R2 conditions, revision history, cross-note semantic conflicts and concurrent writes using only synthetic test records.

## Next work

1. Independent authentication/approval-bound push API; preserve one shared write gate for Agent and Mac.
2. Mac companion: status, stage, local commit, pull preflight, conflict UI, manual merge, push. Local commit metadata lives outside the synced Vault.
3. Explicit separate test bucket adoption with complete SHA-256 snapshot verification and backup, then permissions cutover. Validate that Remotely Save cannot still write managed notes.
4. Formal performance limits, snapshot pagination, retention/GC with recoverable backups.