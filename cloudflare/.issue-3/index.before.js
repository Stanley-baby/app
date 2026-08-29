const json = (body, status, request, env) => {
    const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': request.headers.get('X-Request-ID') || `${Date.now()}-${Math.random()}`
    })
    const origin = request.headers.get('Origin')
    const allowedOrigins = String(env.CORS_ORIGINS || '').split(/\s+/).filter(Boolean)

    const isAllowedOrigin = origin && allowedOrigins.some(allowed =>
        allowed === origin || allowed.endsWith('*') && origin.startsWith(allowed.slice(0, -1)))

    if (isAllowedOrigin) {
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Access-Control-Allow-Credentials', 'true')
        headers.set('Vary', 'Origin')
    }

    return new Response(JSON.stringify(body), { status, headers })
}

const cors = (request, env) => {
    const headers = json({}, 204, request, env).headers
    headers.delete('Content-Type')
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID')
    headers.set('Access-Control-Max-Age', '600')
    return new Response(null, { status: 204, headers })
}

const hasSession = request => Boolean(request.headers.get('Cookie')?.match(/(?:^|;\s*)rd_session=/))

const version = env => env.VERSION || '0.1.0'

export default {
    async fetch(request, env) {
        const url = new URL(request.url)

        if (request.method === 'OPTIONS')
            return cors(request, env)

        if (url.pathname === '/health')
            return json({ result: true, status: 'ok', environment: env.ENVIRONMENT, version: version(env) }, 200, request, env)

        if (url.pathname === '/version')
            return json({ result: true, environment: env.ENVIRONMENT, version: version(env) }, 200, request, env)

        if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
            if (!hasSession(request))
                return json({
                    result: false,
                    auth: false,
                    error: 'auth_required',
                    errorMessage: 'Login is required',
                    login: `${env.APP_ORIGIN}/account/login`
                }, 401, request, env)

            return json({ result: false, error: 'route_not_implemented' }, 404, request, env)
        }

        return json({ result: false, error: 'not_found' }, 404, request, env)
    }
}
