# Cloudflare API worker

This Worker is an independently operated, self-hosted bookmarking backend.
Each operator supplies their own Cloudflare resources, domains, and secrets;
the repository does not provide a shared data plane.

## Self-hosted quick start

1. Install Node 18 and Wrangler, then authenticate with `wrangler login`.
2. Copy the committed template and keep the private copy out of Git:

   ```sh
   cp cloudflare/wrangler.toml cloudflare/wrangler.private.toml
   ```

3. Create a D1 database, two R2 buckets, and the task queues in your Cloudflare
   account. Put the returned D1 ID and your resource names in the `selfhosted`
   blocks of `cloudflare/wrangler.private.toml`; use those names in the commands
   below if they differ from the template.
4. Set `API_ORIGIN`, `APP_ORIGIN`, `AI_PAGE_ORIGIN`, and `CORS_ORIGINS` to
   origins you own. Apply migrations and deploy:

   ```sh
   npx wrangler d1 migrations apply raindrop-db-selfhosted --remote \
     --config cloudflare/wrangler.private.toml --env selfhosted
   npx wrangler deploy --config cloudflare/wrangler.private.toml --env selfhosted
   ```

5. Add `SESSION_SECRET` and `ENCRYPTION_KEY` at minimum. Add email, OAuth,
   Turnstile, scanner, and Apple credentials only when you enable those
   features. Secrets are stored with `wrangler secret put` and never committed.

The committed `wrangler.toml` contains placeholders only. The ignored
`wrangler.private.toml` is the local deployment copy. A custom API domain is
optional; `workers.dev` is sufficient for a self-hosted instance.

## Client builds and GitHub Releases

Build clients against the same self-hosted origins:

```sh
export API_ORIGIN=https://api.example.com
export APP_ORIGIN=https://app.example.com
export AI_PAGE_ORIGIN=https://app.example.com/ai
export REPOSITORY_URL=https://github.com/your-org/your-repo
export HELP_ORIGIN=https://github.com/your-org/your-repo
npm run build:selfhosted

npm run build:extension:selfhosted
```

The Web output is written to `dist/web/selfhosted`; extension ZIPs are written
to `dist/*.zip`. Publish those artifacts with a GitHub Release and install the
extensions manually in browser developer mode. No browser or mobile store
account is required. Safari source is retained for operators who choose to
sign it themselves.

`wrangler.toml` keeps the top-level (default) configuration for `local` and
defines separate `preview`, `beta`, `production`, and `selfhosted` environments.
Every environment has its own Worker name, D1 database, R2 buckets, queues,
origins, and secret namespace. Replace placeholder D1 IDs before a remote
deploy. Remote custom-domain deployment requires an active Cloudflare zone for
the configured API hostname; a dry-run validates syntax and bindings but does
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
`MAIL_FROM`; production Apple sign-in additionally requires
`APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY`.
The matching public `TURNSTILE_SITE_KEY` is supplied only to
the Web build. Apply the D1 migrations before deploying the Worker.

The client build selects the same profiles with `--env environment=preview` or
the self-hosted scripts `npm run build:selfhosted` and
`npm run build:extension:selfhosted`.
The versioned `/v1` route manifest and request fixtures live in
`contracts/v1-routes.json` and `contracts/v1-fixtures.json`; the contract suite
checks their OpenAPI operations and QA dimensions. Run it with
`npm run test:contract`. The alert taxonomy and recovery steps are in
`OPERATIONS_RUNBOOK.md`.

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

Public release identity and API access are exposed through the existing Web paths:
`/v1/auth/apple`, `/v1/user/tfa`, and `/v1/developer/tokens`. Developer Tokens
are returned only at creation, store only a keyed hash, enforce explicit scopes,
and expire or revoke independently of Device Sessions. OAuth Clients use
`/v1/oauth/authorize` and `/v1/oauth/access_token` (also available as
`/v1/oauth/token`) with an explicit, session-bound consent step, exact redirect
URI matching, and mandatory S256 PKCE;
bearer access is accepted by the scoped `/v1` read/write routes in non-Beta
environments without changing the Beta cookie-session contract.
