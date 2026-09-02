const profiles = require('../cloudflare/environments.json')

const trimTrailingSlash = value => String(value).replace(/\/+$/, '')
const asBoolean = (value, fallback) => value === undefined ? fallback : String(value) === 'true'

const resolveEnvironment = (options={}) => {
    const name = options.environment || (options.production ? 'production' : 'local')
    const profile = profiles[name]

    if (!profile)
        throw new Error(`Unknown build environment: ${name}`)

    return {
        ...profile,
        name,
        independentService: ['local', 'preview', 'beta'].includes(name),
        apiOrigin: trimTrailingSlash(options.apiOrigin || process.env.API_ORIGIN || profile.apiOrigin),
        appOrigin: trimTrailingSlash(options.appOrigin || process.env.APP_ORIGIN || profile.appOrigin),
        aiPageOrigin: trimTrailingSlash(options.aiPageOrigin || process.env.AI_PAGE_ORIGIN || profile.aiPageOrigin),
        turnstileSiteKey: options.turnstileSiteKey || process.env.TURNSTILE_SITE_KEY || profile.turnstileSiteKey || '',
        turnstileEnabled: asBoolean(options.turnstileEnabled ?? process.env.TURNSTILE_ENABLED, profile.turnstileEnabled)
    }
}

module.exports = {
    profiles,
    resolveEnvironment
}
