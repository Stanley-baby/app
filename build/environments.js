const profiles = require('../cloudflare/environments.json')

const trimTrailingSlash = value => String(value).replace(/\/+$/, '')
const asBoolean = (value, fallback) => value === undefined ? fallback : String(value) === 'true'
const defaultRepositoryUrl = 'https://github.com/your-org/your-repo'

const resolveEnvironment = (options={}) => {
    const name = options.environment || (options.production ? 'production' : 'local')
    const profile = profiles[name]

    if (!profile)
        throw new Error(`Unknown build environment: ${name}`)

    return {
        ...profile,
        name,
        independentService: profile.independentService ?? ['local', 'preview', 'beta'].includes(name),
        apiOrigin: trimTrailingSlash(options.apiOrigin || process.env.API_ORIGIN || profile.apiOrigin),
        appOrigin: trimTrailingSlash(options.appOrigin || process.env.APP_ORIGIN || profile.appOrigin),
        aiPageOrigin: trimTrailingSlash(options.aiPageOrigin || process.env.AI_PAGE_ORIGIN || profile.aiPageOrigin),
        helpOrigin: trimTrailingSlash(options.helpOrigin || process.env.HELP_ORIGIN || profile.helpOrigin || defaultRepositoryUrl),
        repositoryUrl: trimTrailingSlash(options.repositoryUrl || process.env.REPOSITORY_URL || profile.repositoryUrl || defaultRepositoryUrl),
        workersBaseUrl: trimTrailingSlash(options.workersBaseUrl ?? process.env.WORKERS_BASE_URL ?? profile.workersBaseUrl ?? ''),
        previewUrl: trimTrailingSlash(options.previewUrl ?? process.env.PREVIEW_URL ?? profile.previewUrl ?? ''),
        turnstileSiteKey: options.turnstileSiteKey || process.env.TURNSTILE_SITE_KEY || profile.turnstileSiteKey || '',
        turnstileEnabled: asBoolean(options.turnstileEnabled ?? process.env.TURNSTILE_ENABLED, profile.turnstileEnabled)
    }
}

module.exports = {
    profiles,
    resolveEnvironment
}
