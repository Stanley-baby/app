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
