# Guarded Sync v0.3 Phase C — Mac local-first companion

Status (2026-10-09): **code implemented + synthetic Node tests; no live R2/Vault cutover.**

## Components and precise responsibilities

- `clients/obsidian-guarded-sync/src/core.js` — portable deterministic local revision model, explicit stage/commit, conservative three-way merge, conflict preflight, head lease, crash-recovery journal.
- `clients/obsidian-guarded-sync/src/plugin.js` — Mac Obsidian `ItemView`, owner prompts, note read/write adapter, local JSON store outside Vault, future HTTPS gateway adapter. Desktop-only.
- `clients/obsidian-guarded-sync/main.js` — self-contained compiled Obsidian CommonJS install entrypoint. `manifest.json`, `styles.css` required.
- `clients/obsidian-guarded-sync/tests/` — mock-Vault and mock-ledger safety regressions, plus canonical SHA compatibility with `src/sync/protocol.ts`.

## User-visible flow

1. **Initialize local** snapshots `INSES/` to `~/.obsidian-guarded-sync/vaults/<vault-hash>/state.json`; it doesn't modify Vault/R2.
2. **Status** compares working tree to committed state; **Stage** captures exact selected content and **Commit** advances local HEAD, never remote.
3. **Fetch** (future authenticated gateway) obtains remote HEAD and verified ancestry, retaining all local revisions without touching notes.
4. **Review Pull** requires no local commits ahead, no staged/unstaged edits, no remote HEAD movement, and refuses automatic remote deletions. A durable journal precedes file edits and exact readback determines completion.
5. **Review Merge** rejects overlapping file/semantic changes, displays three-way conflict context, and requires owner action before applying. A new local commit is parented to the fetched remote while old offline commits remain in historical storage.
6. **Preview Push** requires a clean working copy and fresh expected remote HEAD, persists a review digest; actual Push rechecks conditions and reads back the published revision. Server remains responsible for authentication, relation dependency derivation, owner approval for Agents and atomic HEAD CAS.

## Deliberate blocked features

- **No authenticated gateway on live Worker:** Phase B Durable Object remains private. The plugin's HTTPS `/sync/v1` client is wired but cannot contact any production-enabled route until Phase D implements the gateway. Never add a direct R2 bucket/S3 key into plugin settings.
- **No server-side semantic dependency coverage yet:** client-inferred relation groups are only defense in depth, not authoritative. Do not enable publishing relation changes until the server derives/verifies dependencies from trusted content.
- **No Remotely Save cutover:** external write credentials still bypass managed HEAD, so never claim end-to-end conflict freedom.
- **No automatic deletion or bulk tree transfer:** remote deletions fail closed, parent folders must exist; the Phase B snapshot format limits 650 KB per commit and 96 KB/note.
- **No unrestricted credential flow:** even the future Mac token is looked up at runtime from macOS Keychain via non-shell `security find-generic-password`. It is never written into Vault, plugin settings or commit metadata; the token service is not yet provisioned.

## Recovery semantics

A prepared journal is saved before writes. If a write/readback/final persistence fails, keep journal and block further commits. The user may (a) finalize only if every affected file exactly matches the intended final content, or (b) manually roll back where all affected files still match their old or new recorded versions. Newly created files are moved to Obsidian trash **only** in the explicit manual rollback, and only if their exact bytes still match. External edits prevent automatic rollback.

Local worktree application cannot be made atomically across multiple independent OS files; journaling offers conservative recovery, not a filesystem transaction. The *cloud* authoritative HEAD remains one atomic SQLite ref when Phase D cutover is complete.

## Next phase D development gates

- Owner-authenticated, rate-limited, feature-disabled-by-default HTTP sync gateway under `/sync/v1`; Mac `status/get/push` restricted to local owner role, never `bootstrap` from public. Bind to the existing Phase B isolated DO and R2 bucket only.
- Server-derived semantic groups: relation IDs and evidence dependencies computed and versioned server-side, not trusted from client request. Deny unresolvable dependency scope.
- Agent MCP proposal → independent browser approval → same versioned gateway. Old direct R2 reviewed writes disabled for managed subtree at cutover.
- Audited genesis adoption of existing `Research-MCP-Test` INSES content, complete SHA-256 verification, backup, staged credentials and a single-writer enforced R2 policy. Disable or restrict Remotely Save on managed paths.
- Real Mac Obsidian manual UI checks (including plugin reload, offline commit, simulated Agent update, conflict card, recovery after crash). No production Vault changes until verified.
