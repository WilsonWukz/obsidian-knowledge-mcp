# Obsidian Knowledge MCP

[中文部署指引](docs/CLOUDFLARE_SETUP.zh-CN.md) · [Mac 双向同步验收](docs/MAC_BIDIRECTIONAL_SYNC.zh-CN.md) · [Security](SECURITY.md)

**v0.2.0 — Cloudflare R2 research vault with optional, independently approved note writes.**

Obsidian on Mac / iPad remains your editor. Remotely Save syncs notes to a private Cloudflare R2 bucket. A Cloudflare Worker exposes an OAuth-authenticated MCP endpoint so ChatGPT and Slack Jarvis can read and search notes even when the Mac is offline.

**Deployment status:** The v0.1 read-only Worker, isolated R2 test vault and ChatGPT connection have been verified. The v0.2 reviewed writes are under development and NOT yet enabled on the live Cloudflare Worker. Real Mac cloud-to-local sync acceptance is pending. This GitHub repository contains no private notes.

## v0.2: owner-reviewed note writes (default OFF)

The optional write mode adds six MCP tools: **plan_note_changes**, **get_note_plan**, **apply_note_changes**, **cancel_note_plan**, **plan_note_undo**, **list_note_history**. They are registered only when the host sets ENABLE_REVIEWED_WRITES=true.

- Restricts write paths to the INSES/ folder; no unrestricted vault mutation, deletion, renames or binary attachment uploads.
- Allows a reviewed batch of at most five Markdown changes (create, replace, unique-string patch, simple YAML frontmatter patch).
- Saves immutable exact-before/after previews, checks R2 ETags when applying and persists individual receipts in a singleton SQLite Durable Object.
- **Requires the owner to open a separate password-protected review page** and inspect the full content before approval; the MCP client cannot bypass this with a confirmation flag.
- An interrupted or uncertain write is NOT automatically retried. Cross-note changes are not atomic.
- Already-created files are not automatically deleted by undo. Only successfully applied edits to unchanged files can be restored with a second owner approval.
- **After an R2 write, the Mac remains unverified** until Remotely Save executes a bidirectional sync and the user checks the actual local note. The tool reports mac_sync_status=not_verified.
- A Mac with pending offline changes cannot be detected by cloud ETag checks. Preserve backups and avoid concurrent local/cloud editing of the same file.

See [the Mac bidirectional pull-and-conflict acceptance checklist](docs/MAC_BIDIRECTIONAL_SYNC.zh-CN.md). The public OAuth MCP URL and login password are unchanged when reviewed writes are enabled.

## Architecture

```text
Mac Obsidian ↔ Remotely Save ↔ Private Cloudflare R2 bucket
                                       ↑
                              Cloudflare Worker
                                 R2 + OAuth
                                       ↑
                              ChatGPT / Slack Jarvis
```

The Worker uses a Cloudflare Durable Object for an incremental text/search index and Cloudflare KV for OAuth. Both contain potentially private derived data.

This code derives from [dszp/obsidian-mcp-cloudflare](https://github.com/dszp/obsidian-mcp-cloudflare), provided under the MIT license; see [LICENSE](LICENSE). Our v0.1 deliberately **does not expose the upstream writing tools**.

## The 11 read-only tools

| Tool | What it does |
|---|---|
| `list_notes` | Lists Markdown paths |
| `read_note` | Reads Markdown with frontmatter and R2 ETag |
| `search_notes` | Searches indexed text and paths |
| `get_note_graph` | Returns a paginated link graph from explicit `[[wikilinks]]` |
| `parse_frontmatter` | Reads YAML metadata |
| `generate_permalink` | Gets optional Obsidian deep link |
| `list_tags` | Aggregates note tags |
| `list_backlinks` | Finds inbound note links |
| `read_attachment` | Reads an allowlisted image/document attachment |
| `head_attachment` | Reads attachment metadata |
| `list_attachments` | Lists attachment metadata |

In `get_note_graph`, destinations can be `resolved`, `ambiguous` or `missing`. Links are *observations from your notes*, **not** verified scholarly evidence or inferred conceptual claims. Pagination caps R2 I/O per call.

**Default remains read-only.** The server-side allowlist exposes only the 11 read tools unless the deployer explicitly enables reviewed writes. Direct upstream create/edit/delete/attachment upload and `/upload` remain blocked in either mode. Desktop Obsidian syncs normally through independent R2 credentials.

## Recommended: browser-only deployment through GitHub Actions

To deploy without a Mac terminal, use the **manually triggered** [Deploy Obsidian Cloud](https://github.com/WilsonWukz/obsidian-knowledge-mcp/actions/workflows/deploy-cloudflare.yml) workflow. Create an account-scoped Cloudflare deployment API Token with **Workers Scripts Write, Workers KV Storage Write, and Workers R2 Storage Write** (the *Edit Cloudflare Workers* template is a starting point).

In **GitHub → Settings → Secrets and variables → Actions**, create exactly two repository secrets:

- `CLOUDFLARE_API_TOKEN` — Cloudflare deployment API Token, **not** an R2 S3 Access Key.
- `OBSIDIAN_MCP_AUTH_PASSWORD` — a new independent 32+-character login password; retain it in your password manager for OAuth consent.

Run the workflow manually on `main`, entering your 32-character Cloudflare Account ID as the `account_id` input, with the default **`wilson-obsidian-mcp-test`** private test bucket. The job performs offline tests, idempotently provisions the bucket and OAuth KV namespace, deploys the read-only Worker, uploads its OAuth password as a Cloudflare secret and verifies the health route. Its run summary contains the MCP URL. Never enter passwords or tokens in workflow inputs.

GitHub Actions is one-time user-approved provisioning, **not** automatic deployment on every push. Both Cloudflare and GitHub credentials must remain private. A separate bucket-scoped R2 token is required later for the Obsidian Remotely Save plugin. [Chinese setup guide](docs/CLOUDFLARE_SETUP.zh-CN.md) has complete UI steps.

## Getting started

Start with a **separate synthetic test vault**, not your full research notes.

1. Create a Cloudflare account, enable R2, and note its free-tier and payment setup.
2. Install Node.js 22+ and clone this repository.
3. Run `npm ci`, `npm test`; copy `.env.example` to `.env`.
4. Add `CLOUDFLARE_ACCOUNT_ID` and a new `R2_BUCKET_NAME` to `.env`. No paid domain is required: leave `MCP_HOSTNAME` empty for a free `*.workers.dev` endpoint.
5. Run `npx wrangler login`, `npm run setup`, `npx wrangler secret put AUTH_PASSWORD`, `npx wrangler deploy`.
6. In a separate Obsidian vault install Remotely Save, configure its S3-compatible R2 endpoint, bucket, path-style URL and bucket-scoped token. Keep encryption **OFF** for direct R2 MCP parsing (privacy implications below).
7. Check Worker `/health`, then connect your MCP `/mcp` endpoint in ChatGPT and Slack Jarvis. Test note lists, text search and graph retrieval.
8. After test-vault sync works across devices and offline edits are backed up, plan any migration of your real vault.

See the step-by-step [Chinese setup guide](docs/CLOUDFLARE_SETUP.zh-CN.md) and the detailed [upstream deployment reference](DEPLOYMENT.md). Upstream docs mention write tools; this derivative intentionally disables them for v0.1.

## Privacy and safety

Cloudflare R2 encrypts objects at rest, but Remotely Save encryption is **off** in this architecture, so the Worker can read note bodies. This is **not end-to-end encryption**. Use private buckets, restricted API tokens and OAuth, and avoid storing passwords/keys inside notes.

Never upload `.env`, `.dev.vars`, `.secrets.env`, `.obsidian/plugins/remotely-save/data.json`, or your actual vault into GitHub. Keep an independent backup and test sync conflict handling. See [SECURITY.md](SECURITY.md).

## Development and roadmap

```bash
npm ci
npm test
npx wrangler types --config wrangler.test.jsonc
npx tsc --noEmit
```

- **v0.1**: cloud read-only MCP + note search + links/tags + safe deterministic graph + synthetic CI.
- **v0.2**: exact-diff browser-approved writes, R2 conditional ETags, durable receipts and separate undo for edits; Mac cloud-to-local sync and offline conflicts require live tests before use.
- **v0.3**: Zotero Key → literature note linking, citations and source provenance from PDFs/Slack/Figma.
- **v0.4**: typed note graph (paper/concept/method/dataset/question), explicit claims vs personal hypotheses, reproducible evidence trails.

This project is not affiliated with Obsidian, Zotero or OpenAI and has not undergone a professional security audit.
