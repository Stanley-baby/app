# Contributing

1. Fork the repository and create a short-lived branch from
   `docs/add-repository-guidelines`.
2. Keep changes focused on one issue and preserve the `/v1` and `/v2/ai`
   contracts.
3. Run the contract suite, targeted lint, and the affected self-hosted build
   before opening a pull request:

   ```sh
   npm run test:contract
   npx eslint <changed-files>
   npm run build:selfhosted
   ```

4. Never commit `cloudflare/wrangler.private.toml`, `.dev.vars`, provider
   credentials, production resource IDs, or user data.

Pull requests target `docs/add-repository-guidelines`. After review and a
release check, maintainers promote the development branch to `master`.
