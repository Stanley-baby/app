const profiles = require('../cloudflare/environments.json')

const trimTrailingSlash = value => String(value).replace(/\/+$/, '')

const resolveEnvironment = (options={}) => {
    const name = options.environment || (options.production ? 'production' : 'local')
    const profile = profiles[name]

    if (!profile)
        throw new Error(`Unknown build environment: ${name}`)

    return {
        ...profile,
        name,
        apiOrigin: trimTrailingSlash(options.apiOrigin || process.env.API_ORIGIN || profile.apiOrigin),
        appOrigin: trimTrailingSlash(options.appOrigin || process.env.APP_ORIGIN || profile.appOrigin),
        aiPageOrigin: trimTrailingSlash(options.aiPageOrigin || process.env.AI_PAGE_ORIGIN || profile.aiPageOrigin)
    }
}

module.exports = {
    profiles,
    resolveEnvironment
}
