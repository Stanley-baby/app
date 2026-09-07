export const
	APP_DOMAIN 			= 'raindrop.io'

const defaultAppOrigin = process.env.NODE_ENV == 'production' ? 'https://app.example.com' : 'http://localhost:2000'
const defaultWorkersBaseUrl = process.env.RAINDROP_INDEPENDENT_SERVICE == 'true' ? '' : 'https://rdl.ink'

export const
	APP_BASE_URL 		= process.env.APP_ORIGIN || defaultAppOrigin,
	WORKERS_BASE_URL	= process.env.WORKERS_BASE_URL || defaultWorkersBaseUrl,
	LEGACY_WORKERS_BASE_URL=process.env.RAINDROP_INDEPENDENT_SERVICE == 'true' ? '' : `https://stella.${APP_DOMAIN}`

const defaultApiOrigin = process.env.NODE_ENV == 'production' || RAINDROP_ENVIRONMENT == 'react-native' ? 'https://api.example.com' : 'http://localhost:8787'
const defaultAiPageOrigin = process.env.NODE_ENV == 'production' ? 'https://app.example.com/ai' : 'http://localhost:5173/ai'
const trimTrailingSlash = value => String(value || '').replace(/\/+$/, '')
export const
	API_ORIGIN = trimTrailingSlash(process.env.API_ORIGIN || defaultApiOrigin),
	AI_PAGE_ORIGIN = trimTrailingSlash(process.env.AI_PAGE_ORIGIN || defaultAiPageOrigin),
	FAVICON_URL = WORKERS_BASE_URL ? `${WORKERS_BASE_URL}/favicon` : '',
	RENDER_URL = WORKERS_BASE_URL ? `${WORKERS_BASE_URL}/render` : ''

export const
	RECAPTCHA_SITE_KEY = '6LfB38wUAAAAAMX3VuFcriTz-Tb-qw7MD966XNnk'

export const
	TURNSTILE_SITE_KEY	= process.env.TURNSTILE_SITE_KEY || '',
	TURNSTILE_ENABLED	= process.env.TURNSTILE_ENABLED == 'true'

export const
	API_ENDPOINT_URL 	= `${API_ORIGIN}/v1/`,
	API_RETRIES 		= 3,
	API_TIMEOUT 		= 30000,
	PREVIEW_URL			= process.env.PREVIEW_URL || (process.env.RAINDROP_INDEPENDENT_SERVICE == 'true' ? '' : 'https://preview.systems'),
	BETA_AI_URL			= AI_PAGE_ORIGIN
