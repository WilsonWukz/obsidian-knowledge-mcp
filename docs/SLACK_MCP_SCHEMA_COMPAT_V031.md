# Slack MCP schema compatibility hotfix · 0.3.1

**Problem:** Slack Jarvis `list_notes` could list valid files including `INSES/M00-关系总览.md`, but `read_note` and `parse_frontmatter` failed client-side: `path [pattern]: String does not match pattern '.md$'`. ChatGPT successfully read the same exact path. This discrepancy is client-side tool schema validation, not proof of a missing note.

## Fix

- Removed the regex `pattern` constraint from the **published** `NotePathInput` tool JSON Schema. It now accepts strings without a client-specific regex conversion.
- Enforced Markdown-only, vault-relative, traversal-safe paths **inside the Worker** before any underlying note reads via `readNote`, `parseFrontmatter`, or `generatePermalink`. Invalid paths return `invalid_path`.
- Also removed the `endsWith(".md")` advertised schema constraint on Agent-reviewed write actions. Existing `validateWritablePath()` in `src/review/plan.ts` still limits writes to safe `INSES/*.md` and refuses other paths.
- Bumped Worker package/MCP server version to **0.3.1** to prompt tool-registry reload. GitHub workflow health check stays consistent.
- Unit tests cover published JSON Schema, Unicode paths, path traversal, unsafe extensions, and actual read/metadata behavior. They do not substitute for a real Slack client test.

## Rollout and Slack-specific acceptance

1. Merge reviewed PR only after full CI green. Do not deploy automatically.
2. From GitHub Actions, manually deploy `main` with **exactly the previously verified** Cloudflare account, test bucket and origin; preserve `enable_reviewed_writes=true`, `enable_guarded_sync_api=true`, `enable_sync_adoption=false`, `enable_guarded_sync_cutover=false`, `legacy_writers_revoked=false`. Do not change unrelated credentials.
3. Confirm `/health` reports version `0.3.1`.
4. In **Slack Jarvis**, refresh/reconnect Obsidian Knowledge MCP so the client obtains the new tool registry; verify `list_notes` then `read_note({path:"INSES/M00-关系总览.md"})`, `parse_frontmatter` with that same path, and `read_note({path:"INSES/P01-Think-on-Graph.md"})`. The decisive test is Slack itself, not ChatGPT.
5. Confirm the full Markdown and expected YAML are returned, then only prepare dry-run change plans. No Agent change should be applied before old/cloud/local versions and ETags/managed HEAD are reconciled under the project's safety workflow.
6. If Slack still fails the *same* preflight `pattern` error after refresh, capture the tool's registered JSON schema and error, investigate client cache/provider serialization; do not relax server-side validation or claim the bug is fixed.

**Security:** No actual Vault note content is committed, changed, or copied to this repository by this hotfix.
