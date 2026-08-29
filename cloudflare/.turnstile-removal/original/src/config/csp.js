module.exports = {
    hosts: 'https://app.raindrop.io https://www.google.com https://www.gstatic.com https://challenges.cloudflare.com '+(process.env.SENTRY_RELEASE ? 'https://*.sentry.io https://sentry.io' : '')
}
