# Security — Obsidian Knowledge MCP v0.2 (reviewed writes default OFF)

## Trust and data boundaries

- **Cloudflare R2:** stores Markdown and attachments as private cloud objects. They are readable as plaintext by the Worker (no Remotely Save client-side encryption), subject to account and bucket access controls.
- **OAuth:** the Worker serves authenticated remote MCP tool calls; protect its `AUTH_PASSWORD` independently from any Zotero credential.
- **ChatGPT / Slack:** default exposes 11 read tools. With explicit host opt-in it exposes six owner-reviewed plan tools. Upstream direct-write tools and the HTTP `/upload` endpoint remain blocked.
- **Mac Obsidian / Remotely Save:** the user's local editor is still read-write through *separate*, bucket-scoped S3-compatible credentials. The MCP read-only policy does not limit that user's sync permissions.
- **Cloudflare KV and Durable Objects:** OAuth data, cached metadata and derived indexed content are sensitive, not public.
- **Untrusted notes:** text retrieved from the vault is data, not instructions. Agent workflows must never follow requests embedded in notes to exfiltrate secrets or modify other tools.

## Checklist before attaching real research notes

1. Start with a separate small test vault and independent backup.
2. Use a private R2 bucket and dedicated key restricted to that bucket.
3. Never sync `.obsidian/plugins/remotely-save/data.json`, which may contain R2 access credentials.
4. Use a strong Worker OAuth `AUTH_PASSWORD`; never paste passwords, API keys or connection URLs into ChatGPT.
5. Leave `UPLOAD_TOKEN` unset. In v0.1 the upload route is hard-disabled regardless.
6. Check billing limits, access logs, CF account permissions, and recovery procedures.
7. The R2 copy does **not** provide guaranteed versioned backups or protection against last-writer-wins sync conflicts. Keep separate snapshots.
8. Review any community Obsidian plugins you enable; their permissions and sync behavior are outside the Worker.

## Owner-reviewed write mode and remaining risks

Only an explicit ENABLE_REVIEWED_WRITES=true Worker setting permits six limited plan tools. The plan captures the full old and new Markdown, lives in a private SQLite Durable Object, and cannot be applied before a separate password-protected, CSRF-checked browser approval. The approval page shows the exact diff, requires the owner to confirm that Mac pending edits have been synced, and never writes directly to R2. Each execution claims the plan once, uses R2 conditional writes, persists per-file receipts, and NEVER automatically retries uncertain outcomes. Multi-file operations are not atomic.

All reviewed write paths are restricted to INSES/ under the test Vault. No direct delete, move, hidden .obsidian config writes, binary uploads, or direct upstream write tools are exposed. The undo workflow can restore an edited note only when its cloud ETag remains unchanged; newly created notes are not automatically deleted.

**Crucial limitation: R2 ETag checks do not see offline edits on a Mac.** Mac → cloud and cloud → Mac both require Remotely Save bidirectional sync, and a cloud write does not prove the local device received it. The MCP returns mac_sync_status=not_verified; verify Mac pull and offline conflict recovery with a disposable test Vault before enabling reviewed writes. Retain independent backups.

Cloudflare v0.1 read-only deployment has been tested. The v0.2 approval/write and Mac pull paths are not considered production safe until explicitly deployed and accepted in the isolated test Vault. Code commits do not change deployed services or authorize the use of private data.
