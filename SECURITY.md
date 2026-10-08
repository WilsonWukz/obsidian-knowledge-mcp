# Security — Obsidian Knowledge MCP v0.1

## Trust and data boundaries

- **Cloudflare R2:** stores Markdown and attachments as private cloud objects. They are readable as plaintext by the Worker (no Remotely Save client-side encryption), subject to account and bucket access controls.
- **OAuth:** the Worker serves authenticated remote MCP tool calls; protect its `AUTH_PASSWORD` independently from any Zotero credential.
- **ChatGPT / Slack:** only 11 server-side allowlisted read tools are registered. All upstream write tools are withheld and the direct `/upload` HTTP route is disabled.
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

## Write capability is deliberately deferred

The upstream repository includes writing functions. The derivative's `canExposeTool` admits only an enumerated read set, so a future upstream tool is denied by default. The roadmap requires a separate change-plan and owner-review system before enabling any direct MCP write. R2 ETag preconditions protect against some concurrent *cloud* edits, but **cannot guarantee safety when a Mac has unsynced offline changes**.

Cloudflare billing, external OAuth endpoints and the private vault are not configured by committing code. Do not report cloud deployment or real-data safety as proven until a separate R2 and ChatGPT/Slack live test passes.
