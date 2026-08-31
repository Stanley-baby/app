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
