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
`--env` value. The repository intentionally contains no resource IDs or
secret values.

The client build selects the same profiles with `--env environment=preview`.
The contract test skeleton runs with `npm run test:contract`.
