# Beta API operations runbook

This runbook covers the isolated Beta Worker (`raindrop-api-beta`) and its
D1 accounting tables. The same steps apply to Preview after substituting its
Worker and database names. Production is intentionally not part of this
runbook.

## Alert contract

The Worker writes one redacted row to `alerts` for these operational events:

| Kind | Meaning | First action |
| --- | --- | --- |
| `api_error` | An unexpected API exception | Correlate `request_id` with Worker logs and deploy history. |
| `login_anomaly` | Invalid email/password login | Check the rate and source bucket; do not inspect passwords. |
| `rate_limit_exceeded` | A client or User exceeded a route limit | Use `retryAfter`/`Retry-After`; raise the limit only after checking capacity. |
| `usage_quota_threshold` | A User crossed 80% of daily storage/work quota | Confirm the configured quota and current demand. |
| `usage_quota_exceeded` | A User reached the daily quota | The response supplies `retryAt`; no data is discarded. |
| `ai_quota_threshold` | A User or the service crossed 80% of AI quota | Check AI budget and provider health before increasing limits. |
| `ai_quota_exceeded` | An AI User or global budget is exhausted | Wait for `resetAt` or adjust the Beta quota. |
| `metadata_enrichment_failed` | Metadata task reached dead-letter | Inspect the safe task failure and retry explicitly when the URL is healthy. |
| `capture_failed` | Dynamic Capture task reached dead-letter | Verify the Browser binding and Fetchable URL, then retry the task. |
| `attachment_scan_failed` | Attachment safety task reached dead-letter | Keep the content quarantined until the scanner is healthy. |
| `migration_import_failed` | Migration task reached dead-letter | Review the archive status and retry after fixing the reported cause. |
| `backup_failed` | A private Backup or External Copy failed | Check the destination/storage binding and retry the Backup. |
| `task_enqueue_failed` | A Queue message could not be published | Check Queue binding health before retrying the originating request. |

Alert metadata contains only the event kind, severity, route, request ID,
resource/task IDs, numeric counters, and safe error codes. It must never contain
request bodies, cookies, passwords, tokens, URLs, page text, attachment bytes,
or provider credentials. Rows are retained for one year by the scheduled
accounting cleanup.

## Inspect recent alerts

```sh
cd "/Users/xx/Downloads/插件项目/raindrop-app"
npx wrangler d1 execute raindrop-db-beta --remote --config cloudflare/wrangler.toml --env beta \
  --command "SELECT id, created_at, kind, severity, route, request_id, metadata FROM alerts ORDER BY created_at DESC LIMIT 100"
```

Filter by kind or time without selecting any content table:

```sh
npx wrangler d1 execute raindrop-db-beta --remote --config cloudflare/wrangler.toml --env beta \
  --command "SELECT kind, severity, COUNT(*) AS count FROM alerts WHERE created_at >= strftime('%s','now')*1000-3600000 GROUP BY kind, severity ORDER BY count DESC"
```

## Triage and recovery

1. Check `https://raindrop-api-beta.shenyuan.workers.dev/health` and
   `/version`; a non-200 response is an API incident.
2. For `api_error`, use the redacted `request_id` and route in Worker logs.
   Return the API to the last known-good Beta commit; never copy request data
   into the incident record.
3. For task failures, call the authenticated task status endpoint and retry
   only after the dependency is healthy:

   ```sh
   curl -sS -H "Cookie: rd_session=<session-cookie>" \
     https://raindrop-api-beta.shenyuan.workers.dev/v1/tasks/<task-id>
   curl -sS -X POST -H "Cookie: rd_session=<session-cookie>" \
     https://raindrop-api-beta.shenyuan.workers.dev/v1/tasks/<task-id>/retry
   ```

   The cookie and task ID are operator placeholders; do not paste real
   sessions into tickets or logs.
4. For `usage_quota_threshold`, `ai_quota_threshold`, or rate-limit alerts,
   compare aggregate counts with the configured Beta limits in
   `cloudflare/wrangler.toml`. Change one limit at a time and re-run the
   contract suite before a Beta deploy.
5. For scanner, Capture, enrichment, migration, or Backup alerts, preserve the
   failed task state, fix the dependency, and use the explicit retry route.
   Never bypass quarantine or turn an unsafe URL into a trusted one.

## Release checks

Before a Beta release, run:

```sh
PATH="$(brew --prefix node@18)/bin:$PATH" npm run test:contract
PATH="$(brew --prefix node@18)/bin:$PATH" npx webpack --config build/web.js --env production --env environment=beta
PATH="$(brew --prefix node@18)/bin:$PATH" npx webpack --config build/extension.js --env production --env vendor=chrome --env environment=beta
```

Deploy only the Beta Worker/Pages targets, verify `/health` and `/version`,
and keep the Production deploy command unused.
