# Guarded Sync v0.3 Phase D — owner gateway, Agent approval and manual cutover

**Default: OFF.** All new sync API, adoption and managed cutover flags default to false. GitHub main or Worker deployment alone does NOT upgrade existing Remotely Save transfers to Git-like safety. Keep a full independent test Vault backup.

## Architecture and source of truth

- **Immutable separate R2 bucket** \`SYNC_OBJECTS\` stores content-addressed blobs, trees, and commits. Original \`VAULT\` is never overwritten by HEAD updates.
- **Singleton SQLite Durable Object** \`SYNC_LEDGER\`: serialised updates to HEAD via one transaction, stale HEAD fails, multi-file update is a single logical revision.
- **Owner Mac Obsidian plugin**: Stage → Commit locally → Fetch → Review Merge/Pull → Preview Push → Push using \`POST /sync/v1\`. Token loaded from macOS Keychain; NEVER enter R2 S3 credentials.
- **MCP Agent**: same six existing reviewed tools; when cutover enabled, \`plan_note_changes\` binds a frozen HEAD and exact diff to the browser-approved digest, \`apply_note_changes\` publishes one commit (without per-file R2 PUT), and undo needs separate approval. Existing read_note, graph and search index read the same authoritative HEAD.
- **Server-side semantic groups**: parse R-* anchors from pre/post notes and changed lines; include matching relationship overview + evidence notes. A change to unmarked prose in a multiple-relationship document is blocked pending clarification. Never trust client groups alone.

## Owner-only API

**Path:** \`/sync/v1\` only; HTTPS POST, JSON, Bearer token \`SYNC_OWNER_TOKEN\`, minimum 32 characters; no CORS, no-store responses, soft per-IP failed-token throttle. Cloudflare WAF recommended for stricter protection. Mac token is a **separate Worker secret**, not \`AUTH_PASSWORD\`, \`UPLOAD_TOKEN\`, or R2 S3 key.

Supported: \`status\`, \`get\`, \`history\`, \`push\` (server forces \`actor=local\`, derives semantic scope), and one-time \`adopt_legacy_vault\` **only** with explicit adoption toggle and human acknowledgement. Public \`bootstrap\`, \`read_file\`, arbitrary R2 PUT, approval bypass and Agent role impersonation are blocked.

The version store is isolated until \`GUARDED_SYNC_CUTOVER=true\`; \`status.mode="isolated_test"\` means changes are NOT reflected by the legacy Remotely Save Vault. Do not claim a completed cloud-to-Mac sync while this flag is false.

## 1. First deploy into isolated test environment

1. Back up \`Research-MCP-Test\` **and** the remote R2 bucket separately. Keep the real research Vault untouched.
2. Add a GitHub Actions secret \`OBSIDIAN_SYNC_OWNER_TOKEN\`: unique randomly generated 32+ characters, unrelated to OAuth login credentials. Never put this value into GitHub files, .env or chat.
3. Manually run \`Deploy Obsidian Cloud\` from \`main\`: keep existing account, test bucket, public origin; set \`enable_guarded_sync_api=true\`, \`enable_sync_adoption=false\`, \`enable_guarded_sync_cutover=false\`, \`legacy_writers_revoked=false\`. The workflow idempotently provisions a **separate** \`<test-bucket>-sync\` object bucket and installs the token as Worker secret.
4. Confirm \`/health\` reports \`guarded_sync_api_enabled=true\`. A tokenless request to \`/sync/v1\` must return 401 (not note content).
5. Mac: update \`guarded-sync\` plugin from \`clients/obsidian-guarded-sync/\` after build. Set Gateway URL \`https://<worker>.workers.dev/sync/v1\`. Save token in macOS Keychain service \`obsidian-guarded-sync\`, account = SHA256 of the Vault's **resolved absolute filesystem path**, as used by the plugin. Use the secure Keychain prompt, not a literal password in shell history. Test \`Initialize local history\` (local only).
6. \`status\` shows \`mode=isolated_test\`. No note or R2 VAULT changes occur from initializing local history.

## 2. Explicit one-time legacy adoption

**Critical: migration is blocked if any source note differs from the Mac genesis.**
1. Ensure all Mac notes are synced and stop all Remotely Save or other direct R2/S3 writers for \`INSES/\`. Revoke/rotate their write credentials, preserve independent backups, and confirm another device cannot still PUT into the managed subtree.
2. Redeploy with \`enable_guarded_sync_api=true\`, \`enable_sync_adoption=true\` and \`enable_guarded_sync_cutover=false\`.
3. From Mac Guarded Sync choose **Adopt legacy baseline (one-time)** after local initialization while the working tree and staging area are clean. The plugin confirms an operator acknowledgement; the server rereads **old VAULT**, checks per-object ETags before and after, computes the genesis SHA-256 and accepts only if it equals the Mac's expected hash.
4. If \`GENESIS_MISMATCH\` or \`SOURCE_CHANGED\`, stop: fix divergence manually and restart with a fresh, reconciled *test* baseline. Do not force.
5. After adoption, redeploy with \`enable_sync_adoption=false\`. Check Fetch tracks the exact shared genesis. No legacy note object was modified.

## 3. Guarded cutover (test Vault only)

1. Verify old write credentials remain revoked; don't keep Remotely Save bidirectional sync running against the managed \`INSES/\` subtree. The Cloudflare Worker cannot revoke S3 credentials itself.
2. Run the manual workflow with \`enable_guarded_sync_api=true\`, \`enable_guarded_sync_cutover=true\`, \`legacy_writers_revoked=true\`, \`enable_sync_adoption=false\`. The workflow rejects missing acknowledgement.
3. For Agent reviewed writes, also set \`enable_reviewed_writes=true\`. Existing OAuth/approval stays intact; all approved edits now use the versioned ledger.
4. Mac should display \`mode=managed\`. Fetch remote versions, check conflict cards, then explicitly Review Pull or Merge. The local client journals partial filesystem writes and supports owner-initiated verified recovery. No automatic delete, background auto-push or forced merge.

## 4. Acceptance matrix before using a production Vault

- Two different Mac/Agent edits to the **same** note → conflict, no overwrite.
- Mac edits M00 relation R-P21-01; Agent edits P21 evidence → semantic conflict across files.
- Disjoint file changes → lossless merge after explicit review.
- A remote commit lands after preview but before Push → stale HEAD rejected.
- Agent cannot publish without independent password-and-CSRF browser approval; duplicate apply does not re-run.
- Multiple notes changed in one Agent plan appear in a **single** HEAD version.
- Stop Worker/R2 in the middle of staging; old HEAD remains readable. Lose acknowledgement after HEAD CAS; leave uncertain receipt and reconcile manually (never blind retry).
- Local Pull/Merge interrupted halfway preserves recovery journal and exact old text; local uncommitted work is never overwritten.
- User has actually **revoked or restricted** old R2 credentials; don't treat a checkbox as proof.
- \`read_note\`, search/tags/backlinks and graph reflect the same authoritative managed notes, not stale \`VAULT\` objects.
- Full text files above configured per-note/commit caps fail closed.

## Limitations and operations

The R2 snapshot format currently has limits (650 KB serialized commit, 96 KB/file and max 5 changed Markdown files/commit); it does not manage attachment binary histories, file rename, or automatic deletion. A **filesystem pull is recoverable via a journal**, not a true multi-file OS atomic transaction. The SQLite HEAD swap is atomic only for readers of the managed version store.

The legacy Remotely Save credential can still write old VAULT if operator fails to revoke it. No Cloudflare code can make that third-party S3 credential safe while it remains active. After cutover the managed read overlay ignores those stale objects, but the old bucket must still be backed up and access-controlled.

**No automatic deployment, real Vault migration, R2 credential rotation or production cutover is executed by a GitHub merge.** This workflow requires deliberate operator steps and Mac integration acceptance before production use.
