# Self-hosting

This repository ships an independently operated bookmark service. The Worker
owns its own users and data; it does not proxy the original Raindrop service.

## 1. Prepare Cloudflare

Install Node 18 and Wrangler, then run `wrangler login`. Create one D1 database,
the `CONTENT_BUCKET` and `BACKUP_BUCKET` R2 buckets, and the task and dead-letter
queues in your account. For example:

```sh
npx wrangler d1 create raindrop-db-selfhosted
npx wrangler r2 bucket create raindrop-content-selfhosted
npx wrangler r2 bucket create raindrop-backup-selfhosted
npx wrangler queues create raindrop-tasks-selfhosted
npx wrangler queues create raindrop-tasks-dlq-selfhosted
```

Copy the public configuration template:

```sh
cp cloudflare/wrangler.toml cloudflare/wrangler.private.toml
```

Edit the `selfhosted` blocks in `cloudflare/wrangler.private.toml` with the D1
ID, resource names, and origins you own. Keep this file ignored and never put
secrets in TOML. If you choose different resource names, use the same names in
the migration and secret commands below.

Apply migrations and deploy:

```sh
npx wrangler d1 migrations apply raindrop-db-selfhosted --remote \
  --config cloudflare/wrangler.private.toml --env selfhosted
npx wrangler deploy --config cloudflare/wrangler.private.toml --env selfhosted
```

Set `SESSION_SECRET` and `ENCRYPTION_KEY` at minimum. Add `MAIL_FROM` and
`RESEND_API_KEY` for email verification; add Google, Apple, Turnstile, scanner,
or custom-provider secrets only when those features are enabled. Use the same
`--config` and `--env selfhosted` arguments with `wrangler secret put`.

## 2. Build clients

Use the same API, Web, AI, help, and repository origins for every client:

```sh
export API_ORIGIN=https://api.example.com
export APP_ORIGIN=https://app.example.com
export AI_PAGE_ORIGIN=https://app.example.com/ai
export REPOSITORY_URL=https://github.com/your-org/your-repo
export HELP_ORIGIN=https://github.com/your-org/your-repo
npm run build:selfhosted

npm run build:extension:selfhosted
```

The Web build is in `dist/web/selfhosted`. Chrome, Edge, Firefox, and Opera ZIPs
are written to `dist/*.zip`. `WORKERS_BASE_URL` is optional; when it is empty,
the client does not call the original image/render proxy.

## 3. Distribute without stores

Create a GitHub Release from a version tag such as `v5.8.1` and attach the Web
archive and extension ZIPs. Users deploy the Web files to their own static host
and load an extension ZIP in browser developer mode. Safari source remains
available for operators who choose to sign it themselves; no store credentials
are part of this project.

## 4. Upgrade and rollback

Pull a tagged release, review its migrations, apply them to the operator-owned
D1 database, and deploy the Worker. Keep the previous release tag available so
the Worker and client artifacts can be restored together if a deployment fails.

Contract coverage is the release gate:

```sh
npm run test:contract
npm run build:selfhosted
npm run build:extension:selfhosted
```

The MIT license and original attribution remain in `LICENSE.md`.

For the staging acceptance flow, run the email-secret wizard from the repository
root after the operator has verified a staging sender in Resend:

```sh
bash scripts/setup-selfhosted-staging-secrets.sh
```

The wizard ensures `SESSION_SECRET` and `ENCRYPTION_KEY` exist, then stores
`MAIL_FROM` and `RESEND_API_KEY` in the staging Worker secret store; it does
not write secret values to the repository or `.env`.
