# Raindrop-compatible Bookmark Service

An MIT-licensed, independently operated bookmarking service with a
Cloudflare Worker backend, Web client, and browser extensions. Each operator
deploys their own data plane; this repository does not connect clients to a
shared hosted service.

## Self-hosting

The backend setup, Cloudflare resources, secrets, migrations, and client-origin
configuration are documented in [`SELF_HOSTING.md`](SELF_HOSTING.md) and
[`cloudflare/README.md`](cloudflare/README.md).
The shortest path is:

```sh
npm i
cp cloudflare/wrangler.toml cloudflare/wrangler.private.toml
# edit the selfhosted block and set your Cloudflare resource IDs and origins
npx wrangler d1 migrations apply raindrop-db-selfhosted --remote \
  --config cloudflare/wrangler.private.toml --env selfhosted
npx wrangler deploy --config cloudflare/wrangler.private.toml --env selfhosted
```

Build the Web client and manually installable extension ZIPs with your own
origins:

```sh
export API_ORIGIN=https://api.example.com
export APP_ORIGIN=https://app.example.com
export AI_PAGE_ORIGIN=https://app.example.com/ai
export REPOSITORY_URL=https://github.com/your-org/your-repo
export HELP_ORIGIN=https://github.com/your-org/your-repo
npm run build:selfhosted
npm run build:extension:selfhosted
```

Web output is written to `dist/web/selfhosted`; extension ZIPs are written to
`dist/*.zip`. Publish them through GitHub Releases and load the extensions in
browser developer mode. No app-store account or upstream repository is
required. Keep `cloudflare/wrangler.private.toml` and all secrets uncommitted.

The stable `master` branch is the release baseline. The `develop` branch is
the development branch.

## Build
Be sure to run `npm i` before calling any commands below
| target   | command | notes |
|----------|---------|-------|
| web      | `npm run build` |
| self-hosted web | `npm run build:selfhosted` | Uses operator-supplied origins |
| electron | `npm run build:electron` |
| chrome   | `npm run build:extension:chrome` |
| self-hosted extensions | `npm run build:extension:selfhosted` | Chrome, Edge, Firefox, Opera ZIPs |
| chrome beta | `npm run build:extension:chrome:beta` | Private Beta API at the isolated `beta` profile |
| edge     | `npm run build:extension:edge` |
| firefox   | `npm run build:extension:firefox` | Saved to `dist/firefox/prod`
| opera    | `npm run build:extension:opera` |
| safari   | `npm run build:extension:safari` | Then open **build/xcode** project

## Development
| target   | command | notes |
|----------|---------|-------|
| web      | `npm run local` |
| chrome   | `npm run local:extension:chrome` | Turn off `same-site-by-default-cookies` in Chrome browser flags

### Reset Safari extension state (dev purpose only)
Danger removes all safari settings!!!

```sh
rm -rf ~/Library/Containers/com.apple.Safari/Data/Library/Safari/*
rm -rf ~/Library/Containers/com.apple.Safari/Data/Library/WebKit/*
rm -rf ~/Library/Developer/Xcode/DerivedData/Save_to_Raindrop.io-*(N)
defaults delete com.apple.Safari 2>/dev/null
```

## Supported browsers
- Chrome >= 67 - older versions not support SameSite cookie
- Safari >= 11 (OS X 10.11) - older version not support JS Rest in objects
- Firefox >= 55 - older version not support JS Rest in objects
- Edge >= 80 - earlies Blink version
