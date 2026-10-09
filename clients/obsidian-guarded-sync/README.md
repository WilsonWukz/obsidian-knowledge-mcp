# Guarded Sync — Mac Obsidian companion (Phase C)

**Development preview, independent of EvidenceWeave and the existing Obsidian Cloud/MCP.**

Local-first Git-like workflow for research notes in `INSES/`:

`Status → Stage → Commit → Fetch → Review Pull/Merge → Preview Push → Push`

This is a **local safety client**, not a replacement for the Cloudflare Worker, and not proof that existing Remotely Save transfers are conflict-safe. **Do not enable it for the real Vault until the authenticated gateway, Agent owner approval, and single-writer cutover have passed.**

### Implemented

- Stage snapshots the *exact bytes at stage time*; subsequently edited files remain unstaged.
- Commit creates content-addressed local history with canonical server-compatible SHA-256 IDs; no network write.
- Working copies, local staged snapshots, immutable local commits and a crash-recovery journal live at `~/.obsidian-guarded-sync/vaults/<sha256-realpath>/state.json` **outside** the Obsidian Vault (not in Remotely Save's `.obsidian/` tree).
- Mac files are read via Obsidian APIs and checked not to escape the Vault via symlinks. Secrets are NEVER saved to Obsidian plugin settings or commit metadata.
- Fetch obtains remote HEAD and verifies complete commit ancestry **without editing notes**. Remote history must intersect local genesis; unrelated histories are denied.
- Review Pull permits only clean working tree, no local pending commits, exact readback of applied files, durable journal before modifications, and no automatic deletions.
- Review Merge displays three-way preview; never merges overlapping file edits or declared semantic-group collisions. Explicit merge re-parents a new local revision to fetched remote HEAD while retaining previous local history.
- Preview Push creates a one-time, digest-bound approval state. Push rejects stale HEAD and dirty/staged work, and verifies the published tree via remote readback.
- On any interrupted Pull/Merge, pending journal blocks further operations. Owner may finalize if all files match the target or request a conservative rollback. External modifications fail closed.
- If a document contains relation IDs but the edit cannot be attributed to an exact ID, require the author to specify it manually. Overlarge semantic ranges are denied rather than guessed.

### Remote gateway status

**The Phase B Durable Object intentionally has no public authenticated endpoint.** The companion includes a transport abstraction and an HTTPS-only client for future `/sync/v1`, which looks up a scoped token in macOS Keychain; no token is persisted in Vault. At present no `/sync/v1` route is deployed, so Fetch and Push intentionally return a configuration/auth or unavailable error. A fake remote is used in automated tests. Do not create or paste a real token until the gateway security contract is implemented and reviewed.

### Test in an isolated Vault only

1. Do not point Remotely Save at a production managed directory. Back up `Research-MCP-Test`.
2. Copy `main.js`, `manifest.json`, `styles.css` into `<test-vault>/.obsidian/plugins/guarded-sync/` (the ZIP contains the folder). Enable the desktop-only community plugin.
3. Open **Guarded Sync** from the ribbon. Click `Initialize local history`; this records a local genesis snapshot without touching the cloud.
4. Edit an `INSES/` Markdown test file, choose it under **Working tree**, click Stage, enter a message and Commit. Refresh to confirm the local revision changed and no network activity occurred.
5. Confirm that Fetch/Push remain unavailable until the future safe API has been configured. Do not put bucket access keys in the plugin.

### Build and verification

```bash
node clients/obsidian-guarded-sync/scripts/build.mjs
node --experimental-strip-types --test clients/obsidian-guarded-sync/tests/*.cjs
node --check clients/obsidian-guarded-sync/main.js
```

### Limitations before production cutover

- The server currently **trusts client-declared semantic groups**, and other R2/S3 tools can still write managed notes. Remote `push` must remain disabled until Phase D adds server-derived dependency verification, authenticated authorization, owner review for Agents and credential revocation for bypassing writers.
- This alpha supports local Markdown under `INSES/` only. It does not manage images/PDFs, renames, or automatic deletes.
- A multi-file filesystem pull is *recoverable*, not a genuinely atomic filesystem transaction. The pending journal and backups preserve original exact note content and prevent claiming success on interruption.
- The Phase B full-tree payload is bounded to 650 KB per commit, 5 modified notes, 96 KB each; a larger Vault needs a sparse tree/protocol upgrade.
- Unexpected local state corruption causes a hard stop, not an automatic reset. State and research text must be backed up separately. Branch lineage is preserved even after a successful manual rebase/merge.
