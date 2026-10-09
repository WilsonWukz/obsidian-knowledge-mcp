# Git-like Guarded Sync v0.3 — architecture and cutover gate

Status: DEVELOPMENT ONLY. Existing Cloudflare R2, reviewed MCP writes, and Remotely Save are not modified or considered protected by this branch.

## Expected behavior
Local: edit → stage → commit → fetch remote → inspect/merge → conditional push.
Agent: propose a versioned commit → independent owner review → publish via the same authoritative head pointer.
Commit means local revision, NOT upload. A push may be blocked even after the local commit succeeds.

## Non-negotiable invariants
1. Only ONE authoritative writer may update protected INSES/ notes. Existing Remotely Save and direct R2/S3 clients must not independently write this subtree after cutover.
2. Immutable revisions include parent, actor, changed exact text, semantic groups, time, provenance and content digest. Never erase unpushed local history.
3. Compare expected remote HEAD inside one atomic SQLite Durable Object transaction while updating its HEAD; reject stale pushes. No read-then-unconditional R2 put.
4. Perform a base/local/remote three-way comparison. Different edits to the same file are always conflicts. Different files in the same semantic group also conflict.
5. Related changes, such as the M00 edge explanation and its P21 evidence block, must become visible as ONE logical commit. Sequential R2 PUTs are not an atomic multi-file commit.
6. Conflict review displays base, local, remote and affected semantic group. Never silently select newest timestamp, force push or auto-delete a note.
7. Preserve durable commit ancestry and backups. Crashes or uncertain outcomes are reconciled, never blindly retried.
8. Keep the feature OFF until old local+remote writers have switched and the genesis snapshot is verified.

## Current code gap
src/review/plan.ts prepares 1–5 per-file R2 ETag guarded previews; src/review/operations.ts applies each R2 object separately and may result in partial writes. R2 ETags do not reveal Mac offline edits. The current Remotely Save sync is not Git-like commit/push and cannot supply a single-writer guarantee.

## Milestones
Phase A: Pure offline protocol: snapshot hashes, revisions, conflict classification, semantic groups, stale-head test; reference ledger.
Phase B: Durable Cloudflare SQLite commit/blob/tree store, single atomic HEAD pointer, approval-bound Agent proposals, authenticated client endpoints.
Phase C: Mac Obsidian companion: local status/stage/commit/fetch/push/pull, state stored outside synced Vault; OAuth, backup, side-by-side conflict cards.
Phase D: Explicit test-vault cutover, protect subtree from Remotely Save/direct S3 writes, migrate Agent into the same gateway, verify Mac/Slack/ChatGPT.

## Must-pass scenarios
- Mac and Agent modify same note differently: block, keep both versions.
- Mac modifies relation in M00, Agent modifies corresponding P21 evidence: block by semantic group even when paths differ.
- Independent changes: propose a lossless merge.
- Remote advances after local preflight: reject stale expected HEAD; no overwrite.
- Multiple remote commits since base: inspect full ancestry/groups.
- Pull with uncommitted local edits: never replace working copy.
- Crash before HEAD swap: old revision remains authoritative.
- Crash after HEAD swap: no duplicate publish on retry.
- External unmanaged R2 writer: deny/detect, do not certify managed sync.

NO PRODUCTION SWITCHOVER in Phase A. Current online service is intentionally untouched.