import { target, environment } from '~target'
import { independentService } from './environment'

const repositoryUrl = process.env.REPOSITORY_URL || 'https://github.com/your-org/your-repo'
const helpOrigin = process.env.HELP_ORIGIN || repositoryUrl
const appOrigin = independentService ? process.env.APP_ORIGIN || 'http://localhost:2000' : 'https://app.raindrop.io'

//safari extension in-app purchase
let overrideProLink = ''
if (!independentService && target == 'extension')
    if (environment.includes('safari-ios'))
        overrideProLink = 'https://api.raindrop.io/v1/auth/jwt?done_uri=raindrop://settings/pro'
    else if (environment.includes('safari'))
        overrideProLink = 'https://api.raindrop.io/v1/auth/jwt?done_uri=rniomacsafari://subscribe'

const hostedLinks = {
    app: {
        index: appOrigin,
        search: appOrigin + '/my/0/',
        import: appOrigin + '/settings/import'
    },

    download: 'https://raindrop.io/download',
    blog: 'https://blog.raindrop.io',
    home: 'https://raindrop.io',

    help: {
        index: 'https://help.raindrop.io',
        terms: 'https://help.raindrop.io/terms',
        privacy: 'https://help.raindrop.io/privacy',
        permanentCopy: 'https://help.raindrop.io/permanent-copy',
        about: 'https://help.raindrop.io/about',
        'open-multiple-links': 'https://help.raindrop.io/troubleshooting/open-multiple-links',
        import: 'https://help.raindrop.io/import',
        omnibox: 'https://help.raindrop.io/using-search#searching-from-the-browser-address-bar',
        'saved-indicator': 'https://help.raindrop.io/install-extension#enabling-saved-page-indicator',
        'login-problems': 'https://help.raindrop.io/troubleshooting/login',
        changelog: 'https://help.raindrop.io/changelog',
        embed: 'https://help.raindrop.io/embed',
        publicPage: 'https://help.raindrop.io/public-page',
        collaboration: 'https://help.raindrop.io/collaboration',
        'add-bookmark': 'https://help.raindrop.io/bookmarks',
        'add-note': 'https://help.raindrop.io/bookmarks#managing-a-bookmark',
        search: 'https://help.raindrop.io/using-search',
        tfa: 'https://help.raindrop.io/authentication#two-factor-authentication-2fa',
        highlights: {
            index: 'https://help.raindrop.io/highlights',
            addExtension: 'https://help.raindrop.io/highlights/#'+(environment.includes('safari-ios') ? 'add-extension-safari-ios' : 'add-extension')
        },
        backups: {
            automatic: 'https://help.raindrop.io/export#automatic-daily-backups'
        },
        troubleshooting: {
            brokenLinks: {
                modes: 'https://help.raindrop.io/broken-links#reducing-false-positives',
            }
        },
        stella: {
            index: 'https://help.raindrop.io/stella',
        }
    },

    pro: {
        'buy': overrideProLink || 'https://raindrop.io/pro/buy',
        'frame': 'https://raindrop.io/pro?frame=1',
        'compare': overrideProLink || 'https://raindrop.io/pro',
        'faq': 'https://help.raindrop.io/premium-features#faq',
        'help-change-billing-cycle': 'https://help.raindrop.io/premium-features#managing-your-subscription',
        'help-learn-more': 'https://help.raindrop.io/premium-features'
    },

    dev: {
        index: 'https://developer.raindrop.io',
        terms: 'https://developer.raindrop.io/terms',
        token: 'https://developer.raindrop.io/v1/authentication/token',
        github:'https://github.com/raindropio'
    }
}

const independentLinks = {
    app: {
        index: appOrigin,
        search: appOrigin + '/my/0/',
        import: appOrigin + '/settings/import'
    },
    download: repositoryUrl + '/releases',
    blog: repositoryUrl,
    home: appOrigin,
    help: {
        index: helpOrigin,
        terms: helpOrigin,
        privacy: helpOrigin,
        permanentCopy: helpOrigin,
        about: helpOrigin,
        'open-multiple-links': helpOrigin,
        import: helpOrigin,
        omnibox: helpOrigin,
        'saved-indicator': helpOrigin,
        'login-problems': helpOrigin,
        changelog: helpOrigin,
        embed: helpOrigin,
        publicPage: helpOrigin,
        collaboration: helpOrigin,
        'add-bookmark': helpOrigin,
        'add-note': helpOrigin,
        search: helpOrigin,
        tfa: helpOrigin,
        highlights: { index: helpOrigin, addExtension: helpOrigin },
        backups: { automatic: helpOrigin },
        troubleshooting: { brokenLinks: { modes: helpOrigin } },
        stella: { index: helpOrigin }
    },
    pro: {
        buy: repositoryUrl + '/discussions',
        frame: appOrigin,
        compare: repositoryUrl,
        faq: repositoryUrl,
        'help-change-billing-cycle': helpOrigin,
        'help-learn-more': helpOrigin
    },
    dev: {
        index: repositoryUrl,
        terms: repositoryUrl + '/blob/master/LICENSE.md',
        token: appOrigin + '/settings/integrations/dev',
        github: repositoryUrl
    }
}

export default independentService ? independentLinks : hostedLinks
