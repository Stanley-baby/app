# Cloudflare API worker

`wrangler.toml` keeps the top-level (default) configuration for `local` and
defines separate `preview`, `beta`, and `production` environments. Every
environment has its own Worker name, D1 database, R2 buckets, queues, origins,
and secret namespace. Replace the placeholder D1 IDs before a remote deploy.
Remote custom-domain deployment also requires an active Cloudflare zone for
the configured API hostnames; a dry-run validates syntax and bindings but does
not provision resources or verify zone ownership.

```sh
wrangler dev --config cloudflare/wrangler.toml
wrangler deploy --config cloudflare/wrangler.toml --env preview
wrangler secret put SESSION_SECRET --config cloudflare/wrangler.toml --env beta
```

Before each remote deploy, create the environment's D1/R2/Queue resources,
put the actual D1 ID in the matching block, and set each secret with the same
`--env` value. Identity deployments require `BETA_ACCESS_PASSWORD`,
`SESSION_SECRET`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, and
`MAIL_FROM`; the matching public `TURNSTILE_SITE_KEY` is supplied only to
the Web build. Apply the D1 migrations before deploying the Worker.

The client build selects the same profiles with `--env environment=preview`.
The contract test skeleton runs with `npm run test:contract`.

The AI page is served at `/ai` and is embedded by the existing Stella iframe.
Authenticated clients use `/v2/ai/config`, `/v2/ai/context`, `/v2/ai/chat` (SSE),
`/v2/ai/suggestions`, `/v2/ai/description-draft`, and `/v2/ai/history`. Workers
AI is the default provider. Users can test and save an optional Custom AI
Provider through `/v2/ai/provider` using a public HTTPS OpenAI-compatible
endpoint; its API key is encrypted at rest and never returned. Set `AI_MODEL` to a Workers AI model
with the Function calling capability (the profiles default to
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), plus `AI_DAILY_QUOTA` and
`AI_GLOBAL_DAILY_QUOTA`, per environment.
Quota responses include an ISO `resetAt`; exhausted requests return `429` with
`retryAt` and never fall back to another provider. Chat requests include an
explicit `provider` (`workers_ai` or `custom`); provider failures expose a
retry-or-switch choice without sending the same context automatically. The AI page uses the same
environment's Pages origin (`/ai`) so the Stella iframe and session cookie stay
on the deployed Beta app. Context requests include authorized Bookmark metadata
and Highlights only; Snapshots and attachments are excluded by default. Drafts
are returned for editing and are never written until the User explicitly applies
them.

AI Tools are exposed through `GET /v2/ai/tools` and authorized read execution on
`POST /v2/ai/tools`. Bookmark writes use `POST /v2/ai/action-proposals` and
remain pending until `POST /v2/ai/action-proposals/:id/decision` receives
`approve`, `reject`, or `always_approve`. Standing approvals are stored per User,
write Tool, and Collection through `/v2/ai/approvals`; deleting an approval
revokes it. Every application rechecks the current Bookmark and Collection role,
so a standing approval never bypasses normal permissions. Workers AI chat
requests pass the same read/write tool catalog; read calls return authorized
context, while write calls create proposals without applying mutations.

Each profile also sets `USAGE_QUOTA_DAILY` (default `1000`) and
`RATE_LIMIT_PER_MINUTE` (default `60`). Authenticated write requests consume
one daily usage unit; every `/v1` route uses a per-user or privacy-preserving
client rate bucket. A rejected request returns `429`, `Retry-After`,
`retryAfter`, and `retryAt`. D1 `audit_records` and `alerts` store only actor,
route, resource identifiers, outcome, and numeric reason metadata—never request
bodies, cookies, passwords, tokens, page contents, or attachment contents.

Bookmark saves create an idempotent `metadata_enrichment` task for public
HTTP(S) URLs. The Queue consumer follows redirects manually and validates each
target, records progress in `background_tasks`, retries failures three times
with backoff, then marks the task `dead_letter` and exposes `POST
/v1/tasks/:id/retry` for an explicit retry.
When `FETCH_DNS_RESOLVER` is configured, each hostname is resolved over HTTPS
and private or non-public A/AAAA answers are rejected before the fetch.

Protected content is stored only in the private `CONTENT_BUCKET`. When
`ATTACHMENT_SCAN_ENABLED=true`, uploads are limited to `ATTACHMENT_MAX_BYTES`
(50 MiB in every profile), start quarantined, and enqueue an `attachment_scan`
task. Set `SCANNER_URL` and
`SCANNER_API_KEY` as Worker secrets for a scanner that returns `clean: true` or
an approved/cleared status before downloads become available. `POST
/v1/raindrop/:id/capture` is the only path that creates a Dynamic Capture task;
the Beta Worker uses the `BROWSER` Browser Run binding, stores the result
privately, and applies the same safety check.
Downloads use `/v1/content/:id/download` and never expose an R2 object URL.

Beta currently sets `ATTACHMENT_SCAN_ENABLED=false`, so attachments remain
private but are marked Cleared immediately and do not enqueue a scanner task.
Set it to `true` before enabling `SCANNER_URL` and `SCANNER_API_KEY` for
quarantine-first uploads.

Collections support one-time invitations through `collection/:id/sharing` and
`collaborators/join`. Roles are Owner, Editor, and Viewer; a role granted on a
Parent Collection is inherited by its descendants and is never silently
weakened by a lower child role. Ownership changes use the explicit
`collection/:id/transfer` route.

Public Collections expose a stable link containing the numeric Resource ID and
mutable slug. Bookmark metadata is public only when the Collection is public;
Protected Content and Saved-page Snapshots remain private until the Owner
explicitly publishes a Cleared Snapshot through
`collection/:id/published-snapshots`. Public snapshot streams still go through
the Worker and never expose an R2 object URL.

Migration Archives use `POST /v1/import/preflight` with JSON (`collections`,
`bookmarks`, `attachments`, `covers`, and `snapshots`, or `items`) or a JSON
multipart file. Protected Content is carried inline and retained privately.
The response lists duplicate Bookmarks before any write. Submit explicit
`keep`/`skip` choices to
`/v1/import/:id/review`, then start the resumable `migration_import`
Background Task with `/v1/import/:id/commit`. `/v1/import/:id/status` and the
existing `/v1/tasks/:id` endpoint expose progress; `/v1/import/:id/mappings`
lists each source identifier and its assigned Resource ID (numeric for
Collections and Bookmarks, opaque for Protected Content). Per-source keys make
retries idempotent, while a failed task can be retried explicitly with
`/v1/import/:id/retry`. A skipped duplicate maps to the existing Resource ID so
the source identifier remains traceable without creating a second Bookmark.
When scanning is enabled, import status also reports child safety tasks and
their pending or failed state; an explicit retry requeues failed safety tasks.
