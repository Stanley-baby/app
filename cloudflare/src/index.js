const encoder = new TextEncoder()
const sessionDays = 30
const verificationHours = 24
const googleStateMinutes = 10
const deletionDays = 30
const passwordIterations = 100000

const requestId = request => request.headers.get('X-Request-ID') || String(Date.now()) + '-' + Math.random()

const addCorsHeaders = (headers, request, env) => {
    const origin = request.headers.get('Origin')
    const allowedOrigins = String(env.CORS_ORIGINS || '').split(/\s+/).filter(Boolean)

    const isAllowedOrigin = origin && allowedOrigins.some(allowed =>
        allowed === origin || allowed.endsWith('*') && origin.startsWith(allowed.slice(0, -1)))

    if (isAllowedOrigin) {
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Access-Control-Allow-Credentials', 'true')
        headers.set('Vary', 'Origin')
    }

    return headers
}

const json = (body, status, request, env, extraHeaders = {}) => {
    const headers = addCorsHeaders(new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': requestId(request),
        ...extraHeaders
    }), request, env)

    return new Response(JSON.stringify(body), { status, headers })
}

const error = (code, status, request, env, errorMessage = code) =>
    json({ result: false, error: code, errorMessage }, status, request, env)

const cors = (request, env) => {
    const headers = addCorsHeaders(new Headers({
        'X-Request-ID': requestId(request)
    }), request, env)
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID, X-Device-Name')
    headers.set('Access-Control-Max-Age', '600')
    return new Response(null, { status: 204, headers })
}

const bytesToBase64url = bytes => btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const base64urlToBytes = value => Uint8Array.from(
    atob(String(value).replace(/-/g, '+').replace(/_/g, '/')),
    char => char.charCodeAt(0)
)

const randomToken = size => {
    const bytes = new Uint8Array(size)
    crypto.getRandomValues(bytes)
    return bytesToBase64url(bytes)
}

const equal = (a, b) => {
    const left = encoder.encode(String(a))
    const right = encoder.encode(String(b))
    if (left.length !== right.length) return false
    let difference = 0
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
    return difference === 0
}

const hmac = async (value, secret) => {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
    return bytesToBase64url(new Uint8Array(signature))
}

const passwordHash = async (password, salt) => {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
    const hash = await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt,
        iterations: passwordIterations
    }, key, 256)
    return bytesToBase64url(new Uint8Array(hash))
}

const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

const readBody = async request => {
    const contentType = request.headers.get('Content-Type') || ''
    try {
        if (contentType.includes('application/json'))
            return { data: await request.json(), form: false }

        return { data: Object.fromEntries((await request.formData()).entries()), form: true }
    } catch {
        return { data: {}, form: false }
    }
}

const cookieValue = (request, name) => {
    const prefix = name + '='
    return (request.headers.get('Cookie') || '').split(/;\s*/).find(value => value.startsWith(prefix))?.slice(prefix.length)
}

const sessionCookie = token =>
    'rd_session=' + token + '; Path=/; Max-Age=' + sessionDays * 86400 + '; HttpOnly; Secure; SameSite=None'

const expiredSessionCookie = 'rd_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None'

const publicUser = user => ({
    _id: String(user.id || user.user_id),
    email: user.email,
    name: user.name,
    email_verified: Boolean(user.email_verified_at),
    ...(user.google_enabled ? { google: { enabled: true } } : {})
})

const arrayValue = value => {
    if (Array.isArray(value)) return value
    try {
        const parsed = JSON.parse(value || '[]')
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

const tagValue = value => String(value || '').trim()

const bookmarkTags = value => [...new Set(arrayValue(value).map(tagValue).filter(Boolean))]

const validTagList = value => Array.isArray(value) && value.every(tag => tagValue(tag).length <= 100)

const highlightId = value => {
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : null
}

const highlightItem = (item={}, fallbackId=1) => ({
    _id: highlightId(item._id || item.id) || fallbackId,
    text: String(item.text || ''),
    note: String(item.note || ''),
    color: ['yellow', 'blue', 'green', 'red'].includes(item.color) ? item.color : 'yellow',
    created: item.created || new Date().toISOString(),
    ...(item.position === undefined ? {} : { position: item.position })
})

const bookmarkHighlights = value => arrayValue(value).map((item, index) => highlightItem(item, index + 1))

const applyHighlightChanges = (existingValue, changes) => {
    const current = bookmarkHighlights(existingValue)
    if (!Array.isArray(changes)) return current
    if (!changes.length) return []

    let nextId = Math.max(0, ...current.map(item => item._id)) + 1
    for (const change of changes) {
        const id = highlightId(change?._id || change?.id)
        const index = id ? current.findIndex(item => item._id === id) : -1
        const hasText = Object.prototype.hasOwnProperty.call(change || {}, 'text')
        const text = String(change?.text || '')

        if (id && hasText && !text && index !== -1) {
            current.splice(index, 1)
            continue
        }
        if (id && hasText && !text && index === -1)
            continue

        const assignedId = id || nextId++
        const item = index === -1 ? { ...change, _id: assignedId } : { ...current[index], ...change, _id: current[index]._id }
        const normalized = highlightItem(item, assignedId)
        if (index === -1) current.push(normalized)
        else current[index] = normalized
    }
    return current
}

const validHighlightChanges = changes => Array.isArray(changes) && changes.every(change => {
    const id = highlightId(change?._id || change?.id)
    const text = String(change?.text || '')
    const note = String(change?.note || '')
    return text.length <= 10000 && note.length <= 10000 && (id || text.trim())
})

const bookmarkItem = item => {
    const changeVersion = Number(item.change_version || 0)
    const description = item.description || item.excerpt || ''
    return {
        _id: Number(item.id),
        link: item.url,
        title: item.title,
        description,
        excerpt: description,
        note: item.note || '',
        collectionId: item.removed_at ? -99 : item.collection_id,
        tags: bookmarkTags(item.tags),
        highlights: bookmarkHighlights(item.highlights),
        removed: Boolean(item.removed_at),
        created: new Date(item.created_at).toISOString(),
        lastUpdate: new Date(item.updated_at).toISOString(),
        changeVersion,
        version: changeVersion
    }
}

const bookmarkSync = async (env, userId) => {
    const latest = await env.DB.prepare('SELECT version, changed_at FROM bookmark_changes WHERE user_id = ? ORDER BY version DESC LIMIT 1').bind(userId).first()
    return {
        version: Number(latest?.version || 0),
        lastAction: Number(latest?.changed_at || 0)
    }
}

const requestedSyncVersion = url => {
    const value = ['version', 'since', 'fromVersion', 'changeVersion']
        .map(name => url.searchParams.get(name))
        .find(value => value !== null)
    if (value === undefined || value === '') return null
    const version = Number(value)
    return Number.isSafeInteger(version) && version >= 0 ? version : -1
}

const changedBookmarks = async (env, userId, since) => {
    const rows = await env.DB.prepare(`SELECT b.id, b.user_id, b.url, b.title, b.description, b.note,
        b.collection_id, b.tags, b.highlights, b.removed_at, b.created_at, b.updated_at,
        c.version AS sync_version
        FROM bookmark_changes c JOIN bookmarks b ON b.id = c.bookmark_id AND b.user_id = c.user_id
        WHERE c.user_id = ? AND c.version > ? ORDER BY c.version`).bind(userId, since).all()
    const latest = new Map()
    for (const row of rows.results || [])
        latest.set(row.id, { ...row, change_version: row.sync_version })
    return [...latest.values()].map(bookmarkItem)
}

const collectionItem = item => ({
    _id: Number(item.id),
    title: item.title,
    parentId: item.parent_id,
    count: Number(item.count || 0),
    removed: Boolean(item.removed_at),
    access: { level: 4, draggable: true }
})

const parseCollectionId = value => {
    if (value === undefined) return undefined
    if (value === null || value === '' || value === 'root' || value === 0 || value === '0') return null
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : NaN
}

const parseBookmarkCollectionId = value => {
    const id = Number(value)
    return Number.isSafeInteger(id) && id >= -1 ? (id > 0 ? id : -1) : NaN
}

const collectionOwned = async (env, userId, collectionId) =>
    collectionId <= 0 || Boolean(await env.DB.prepare('SELECT id FROM collections WHERE id = ? AND user_id = ? AND removed_at IS NULL').bind(collectionId, userId).first())

const userCollections = async (env, userId) => {
    const rows = await env.DB.prepare('SELECT id, parent_id, removed_at FROM collections WHERE user_id = ?').bind(userId).all()
    return rows.results || []
}

const descendantCollectionIds = (collections, roots) => {
    const ids = new Set(roots)
    let changed = true
    while (changed) {
        changed = false
        for (const item of collections)
            if (ids.has(Number(item.parent_id)) && !ids.has(Number(item.id))) {
                ids.add(Number(item.id))
                changed = true
            }
    }
    return [...ids]
}

const collectionParentAllowed = async (env, userId, collectionId, parentId) => {
    if (!parentId) return true

    const visited = new Set()
    let current = parentId
    while (current && !visited.has(current)) {
        if (current === collectionId) return false
        visited.add(current)
        const parent = await env.DB.prepare('SELECT id, parent_id FROM collections WHERE id = ? AND user_id = ?').bind(current, userId).first()
        if (!parent) return false
        current = Number(parent.parent_id) || null
    }
    return true
}

const tagItems = async (env, userId, collectionId=0, search='', sort='') => {
    let query = 'SELECT tags, updated_at FROM bookmarks WHERE user_id = ? AND removed_at IS NULL'
    const values = [userId]
    if (collectionId === -1) {
        query += ' AND collection_id = -1'
    } else if (collectionId > 0) {
        query += ' AND collection_id = ?'
        values.push(collectionId)
    }
    query += ' ORDER BY updated_at DESC'

    const rows = await env.DB.prepare(query).bind(...values).all()
    const entries = new Map()
    for (const row of rows.results || []) {
        for (const name of bookmarkTags(row.tags)) {
            const entry = entries.get(name) || { _id: name, count: 0, last: Number(row.updated_at || 0) }
            entry.count++
            entry.last = Math.max(entry.last, Number(row.updated_at || 0))
            entries.set(name, entry)
        }
    }

    const needle = tagValue(search).replace(/^#/, '').replace(/^"|"$/g, '').toLowerCase()
    const items = [...entries.values()]
        .filter(item => !needle || item._id.toLowerCase().includes(needle))
        .map(({ _id, count, last }) => ({ _id, count, last }))

    if (sort === 'recent') items.sort((left, right) => right.last - left.last || left._id.localeCompare(right._id))
    else if (sort === '-count') items.sort((left, right) => right.count - left.count || left._id.localeCompare(right._id))
    else items.sort((left, right) => left._id.localeCompare(right._id))

    return items.map(({ _id, count }) => ({ _id, count }))
}

const runStatements = async (env, statements) => {
    if (!statements.length) return []
    if (env.DB.batch) return env.DB.batch(statements)
    const results = []
    for (const statement of statements) results.push(await statement.run())
    return results
}

const mutateBookmarkTags = async (env, userId, transform) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const rows = await env.DB.prepare('SELECT id, tags, change_version FROM bookmarks WHERE user_id = ? AND removed_at IS NULL').bind(userId).all()
        const now = Date.now()
        const statements = []
        for (const row of rows.results || []) {
            const updated = transform(bookmarkTags(row.tags))
            if (!updated) continue
            statements.push(env.DB.prepare('UPDATE bookmarks SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ? AND change_version = ?')
                .bind(JSON.stringify(updated), now, row.id, userId, Number(row.change_version || 0)))
        }
        const results = await runStatements(env, statements)
        if (results.every(result => Number(result?.meta?.changes ?? 0) === 1)) return true
    }
    return false
}

const authReady = env => Boolean(env.DB && env.SESSION_SECRET)
const turnstileEnabled = env => String(env.TURNSTILE_ENABLED || '').toLowerCase() === 'true'
const googleReady = env => Boolean(authReady(env) && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.API_ORIGIN)

const configurationError = (request, env) =>
    error('auth_configuration_missing', 503, request, env, 'Authentication is not configured')

const createSession = async (request, env, userId) => {
    const token = randomToken(32)
    const id = randomToken(16)
    const now = Date.now()
    const deviceName = (request.headers.get('X-Device-Name') || request.headers.get('User-Agent') || 'Unknown device').slice(0, 200)

    await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, device_name, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, await hmac(token, env.SESSION_SECRET), deviceName, now, now, now + sessionDays * 86400 * 1000).run()

    return { id, token }
}

const getSession = async (request, env) => {
    const token = cookieValue(request, 'rd_session')
    if (!token || !authReady(env)) return null

    const now = Date.now()
    const session = await env.DB.prepare(`SELECT s.id AS session_id, s.user_id, s.device_name, s.created_at, s.last_seen_at, s.expires_at,
        u.id, u.email, u.name, u.email_verified_at,
        u.federated_only,
        EXISTS(SELECT 1 FROM connected_identities ci WHERE ci.user_id = u.id AND ci.provider = 'google') AS google_enabled
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`)
        .bind(await hmac(token, env.SESSION_SECRET), now).first()

    if (!session) return null
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, session.session_id).run()
    return { ...session, token }
}

const verifyTurnstile = async (request, env, token) => {
    if (!env.TURNSTILE_SECRET_KEY) return null
    if (!token || String(token).length > 2048) return false

    const body = new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: String(token)
    })
    const remoteIp = request.headers.get('CF-Connecting-IP')
    if (remoteIp) body.set('remoteip', remoteIp)

    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        })
        return response.ok && (await response.json()).success === true
    } catch {
        return false
    }
}

const createVerification = async (env, userId) => {
    const token = randomToken(32)
    await env.DB.prepare('INSERT INTO email_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(await hmac(token, env.SESSION_SECRET), userId, Date.now() + verificationHours * 60 * 60 * 1000).run()
    return token
}

const sendVerification = async (env, email, token) => {
    if (env.MAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY || !env.MAIL_FROM)
        return false

    const confirmationUrl = new URL('/account/confirm/' + token, env.APP_ORIGIN).toString()
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: env.MAIL_FROM,
            to: [email],
            subject: 'Confirm your Raindrop Beta email',
            html: '<p>Confirm your email to finish setting up Raindrop Beta.</p><p><a href="' + confirmationUrl + '">Confirm email</a></p>'
        })
    })

    return response.ok
}

const requiresVerification = pathname =>
    pathname.startsWith('/v1/oauth/') ||
    pathname.startsWith('/v1/developer/') ||
    pathname.includes('/sharing') ||
    pathname.startsWith('/v1/backups') ||
    pathname.startsWith('/v1/import/')

const redirect = (request, env, location, token) => {
    const appOrigin = new URL(env.APP_ORIGIN)
    const target = new URL(location || '/', appOrigin)
    const safeLocation = target.origin === appOrigin.origin ? target.toString() : appOrigin.toString()
    const headers = new Headers({
        Location: safeLocation,
        'Set-Cookie': sessionCookie(token),
        'X-Request-ID': requestId(request)
    })
    return new Response(null, { status: 303, headers })
}

const appRedirect = (request, env, path, token) => {
    const headers = new Headers({
        Location: new URL(path, env.APP_ORIGIN).toString(),
        'X-Request-ID': requestId(request)
    })
    if (token) headers.set('Set-Cookie', sessionCookie(token))
    return new Response(null, { status: 303, headers })
}

const googleCallbackUrl = env => new URL('/v1/auth/google/callback', env.API_ORIGIN).toString()

const appPath = (env, value, fallback = '/') => {
    try {
        const appOrigin = new URL(env.APP_ORIGIN)
        const target = new URL(value || fallback, appOrigin)
        return target.origin === appOrigin.origin ? target.pathname + target.search + target.hash : fallback
    } catch {
        return fallback
    }
}

const createGoogleState = async (env, purpose, userId, redirectPath = '/', admissionGranted = false) => {
    const state = randomToken(32)
    await env.DB.prepare('INSERT INTO oauth_states (state_hash, purpose, user_id, redirect_path, admission_granted, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(await hmac(state, env.SESSION_SECRET), purpose, userId || null, redirectPath, admissionGranted ? 1 : 0, Date.now() + googleStateMinutes * 60 * 1000).run()
    return state
}

const googleAuthorization = (env, state) => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: googleCallbackUrl(env),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account'
    }).toString()
    return url.toString()
}

const googleProfile = async (env, code) => {
    try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET,
                redirect_uri: googleCallbackUrl(env),
                grant_type: 'authorization_code'
            })
        })
        if (!response.ok) return null
        const token = await response.json()
        if (!token.access_token) return null

        const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: 'Bearer ' + token.access_token }
        })
        if (!profile.ok) return null
        const data = await profile.json()
        if (!data.sub || !validEmail(String(data.email || '')) || data.email_verified !== true) return null
        return { subject: String(data.sub), email: String(data.email).toLowerCase(), name: String(data.name || data.email).slice(0, 100) }
    } catch {
        return null
    }
}

const hasSharedCollections = (env, userId) => env.DB.prepare(`SELECT 1 FROM collection_collaborators cc
    JOIN collections c ON c.id = cc.collection_id
    WHERE c.user_id = ? AND cc.user_id != ? LIMIT 1`).bind(userId, userId).first()

const deleteUserData = async (env, userId) => {
    const statements = [
        env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM connected_identities WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM oauth_states WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM collection_collaborators WHERE collection_id IN (SELECT id FROM collections WHERE user_id = ?) OR user_id = ?').bind(userId, userId),
        env.DB.prepare('DELETE FROM bookmark_changes WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM collections WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM account_deletions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
    ]
    if (env.DB.batch) return env.DB.batch(statements)
    for (const statement of statements) await statement.run()
}

const purgeExpiredDeletions = async env => {
    if (!env.DB) return
    const expired = await env.DB.prepare('SELECT user_id FROM account_deletions WHERE purge_after <= ?').bind(Date.now()).all()
    for (const { user_id: userId } of expired.results) {
        if (!await hasSharedCollections(env, userId))
            await deleteUserData(env, userId)
    }
}

const loginErrorPage = (request, env, message) => new Response(`<!doctype html><meta charset="utf-8"><title>Login failed</title><main><h1>Login failed</h1><p>${message}</p><p><a href="${env.APP_ORIGIN}/">Return to login</a></p></main>`, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Request-ID': requestId(request) }
})

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

        if (url.pathname === '/v1/auth/google' && request.method === 'GET') {
            if (!googleReady(env)) return configurationError(request, env)
            const state = await createGoogleState(env, 'login', null, appPath(env, url.searchParams.get('redirect')))
            return new Response(null, { status: 302, headers: { Location: googleAuthorization(env, state), 'X-Request-ID': requestId(request) } })
        }

        if (url.pathname === '/v1/auth/google' && request.method === 'POST') {
            if (!googleReady(env)) return configurationError(request, env)
            const { data } = await readBody(request)
            const admitted = env.ENVIRONMENT !== 'beta' || Boolean(env.BETA_ACCESS_PASSWORD && equal(data.betaAccessPassword, env.BETA_ACCESS_PASSWORD))
            if (!admitted)
                return error('beta_access_denied', 403, request, env, 'Beta access password is invalid')
            const state = await createGoogleState(env, 'login', null, appPath(env, data.redirect), true)
            return json({ result: true, location: googleAuthorization(env, state) }, 200, request, env)
        }

        if (url.pathname === '/v1/auth/google/callback' && request.method === 'GET') {
            if (!googleReady(env)) return configurationError(request, env)
            const stateHash = await hmac(String(url.searchParams.get('state') || ''), env.SESSION_SECRET)
            const state = await env.DB.prepare('SELECT purpose, user_id, redirect_path, admission_granted FROM oauth_states WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?')
                .bind(stateHash, Date.now()).first()
            if (!state || !url.searchParams.get('code'))
                return appRedirect(request, env, '/account/login?error=google_sign_in_failed')

            await env.DB.prepare('UPDATE oauth_states SET used_at = ? WHERE state_hash = ?').bind(Date.now(), stateHash).run()
            const profile = await googleProfile(env, url.searchParams.get('code'))
            if (!profile)
                return appRedirect(request, env, state.purpose === 'connect' ? '/settings/account?connect_error=google_sign_in_failed' : '/account/login?error=google_sign_in_failed')

            let identity = await env.DB.prepare('SELECT user_id FROM connected_identities WHERE provider = ? AND provider_subject = ?')
                .bind('google', profile.subject).first()
            if (state.purpose === 'connect') {
                if (identity && identity.user_id !== state.user_id)
                    return appRedirect(request, env, '/settings/account?connect_error=conflict')
                if (!identity)
                    await env.DB.prepare('INSERT INTO connected_identities (provider, provider_subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
                        .bind('google', profile.subject, state.user_id, profile.email, Date.now()).run()
                return appRedirect(request, env, '/settings/account?connected=google')
            }

            if (!identity) {
                if (env.ENVIRONMENT === 'beta' && !state.admission_granted)
                    return appRedirect(request, env, '/account/signup?error=beta_access_required')
                const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(profile.email).first()
                if (existing)
                    return appRedirect(request, env, '/account/login?error=google_identity_conflict')
                const salt = new Uint8Array(16)
                crypto.getRandomValues(salt)
                const inserted = await env.DB.prepare('INSERT INTO users (email, name, password_hash, password_salt, email_verified_at, created_at, federated_only) VALUES (?, ?, ?, ?, ?, ?, 1)')
                    .bind(profile.email, profile.name, await passwordHash(randomToken(32), salt), bytesToBase64url(salt), Date.now(), Date.now()).run()
                identity = { user_id: Number(inserted.meta.last_row_id) }
                await env.DB.prepare('INSERT INTO connected_identities (provider, provider_subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
                    .bind('google', profile.subject, identity.user_id, profile.email, Date.now()).run()
            }
            const session = await createSession(request, env, identity.user_id)
            return appRedirect(request, env, state.redirect_path || '/', session.token)
        }

        if (url.pathname === '/v1/auth/email/signup' && request.method === 'POST') {
            if (!authReady(env)) return configurationError(request, env)
            if ((turnstileEnabled(env) && !env.TURNSTILE_SECRET_KEY) || env.MAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY || !env.MAIL_FROM)
                return configurationError(request, env)

            const { data } = await readBody(request)
            const email = String(data.email || '').trim().toLowerCase()
            const name = String(data.name || '').trim()
            const password = String(data.password || '')
            const accessPassword = String(data.betaAccessPassword || data.beta_access_password || '')
            const turnstileToken = data.turnstileToken || data['cf-turnstile-response'] || data.recaptcha

            if (!validEmail(email) || !name || name.length > 100 || password.length < 12 || password.length > 256)
                return error('validation_failed', 400, request, env, 'Enter a valid email, name, and password of at least 12 characters')

            if (env.ENVIRONMENT === 'beta' && (!env.BETA_ACCESS_PASSWORD || !equal(accessPassword, env.BETA_ACCESS_PASSWORD)))
                return error('beta_access_denied', 403, request, env, 'Beta access password is invalid')

            if (turnstileEnabled(env)) {
                const turnstile = await verifyTurnstile(request, env, turnstileToken)
                if (!turnstile)
                    return error('turnstile_failed', 400, request, env, 'Turnstile verification failed')
            }

            const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
            if (existing)
                return error('email_in_use', 409, request, env, 'Email is already registered')

            const salt = new Uint8Array(16)
            crypto.getRandomValues(salt)
            const inserted = await env.DB.prepare('INSERT INTO users (email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)')
                .bind(email, name, await passwordHash(password, salt), bytesToBase64url(salt), Date.now()).run()
            const userId = Number(inserted.meta.last_row_id)
            const token = await createVerification(env, userId)

            if (!await sendVerification(env, email, token)) {
                await env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(userId).run()
                await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
                return error('email_delivery_failed', 502, request, env, 'Could not send confirmation email')
            }

            return json({ result: true, email, verified: false }, 201, request, env)
        }

        if (url.pathname === '/v1/auth/email/login' && request.method === 'POST') {
            if (!authReady(env)) return configurationError(request, env)
            const { data, form } = await readBody(request)
            const email = String(data.email || '').trim().toLowerCase()
            const password = String(data.password || '')
            const user = await env.DB.prepare('SELECT id, email, name, password_hash, password_salt, email_verified_at FROM users WHERE email = ?').bind(email).first()

            const validPassword = user && equal(await passwordHash(password, base64urlToBytes(user.password_salt)), user.password_hash)
            if (!validPassword)
                return form ? loginErrorPage(request, env, 'Email or password is invalid') : error('invalid_credentials', 401, request, env, 'Email or password is invalid')

            const session = await createSession(request, env, user.id)
            if (form) return redirect(request, env, data.redirect, session.token)
            return json({ result: true, user: publicUser(user) }, 200, request, env, { 'Set-Cookie': sessionCookie(session.token) })
        }

        if (url.pathname === '/v1/auth/email/confirm' && request.method === 'POST') {
            if (!authReady(env)) return configurationError(request, env)
            const { data } = await readBody(request)
            const now = Date.now()
            const hash = await hmac(String(data.token || ''), env.SESSION_SECRET)
            const token = await env.DB.prepare('SELECT user_id FROM email_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').bind(hash, now).first()
            if (!token)
                return error('confirmation_invalid', 400, request, env, 'Confirmation link is invalid or expired')

            await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').bind(now, token.user_id).run()
            await env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').bind(now, hash).run()
            return json({ result: true }, 200, request, env)
        }

        if (url.pathname === '/v1/auth/logout') {
            const session = await getSession(request, env)
            if (session) {
                const all = url.searchParams.has('all')
                const query = all
                    ? 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
                    : 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL'
                const values = all ? [Date.now(), session.user_id] : [Date.now(), session.user_id, session.session_id]
                await env.DB.prepare(query).bind(...values).run()
            }
            return json({ result: true }, 200, request, env, { 'Set-Cookie': expiredSessionCookie })
        }

        if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
            if (!authReady(env)) return configurationError(request, env)
            const session = await getSession(request, env)
            if (!session)
                return json({
                    result: false,
                    auth: false,
                    error: 'auth_required',
                    errorMessage: 'Login is required',
                    login: env.APP_ORIGIN + '/account/login'
                }, 401, request, env)

            if (requiresVerification(url.pathname) && !session.email_verified_at)
                return error('email_verification_required', 403, request, env, 'Confirm your email before this action')

            if (url.pathname === '/v1/user/connect/google' && request.method === 'GET') {
                if (!googleReady(env)) return configurationError(request, env)
                const state = await createGoogleState(env, 'connect', session.user_id, '/settings/account')
                return new Response(null, { status: 302, headers: { Location: googleAuthorization(env, state), 'X-Request-ID': requestId(request) } })
            }

            if (url.pathname === '/v1/user/connect/google/revoke' && request.method === 'POST') {
                if (request.headers.get('Origin') !== env.APP_ORIGIN)
                    return error('origin_not_allowed', 403, request, env, 'Use the Web app to disconnect Google')
                if (session.federated_only)
                    return error('alternative_sign_in_required', 409, request, env, 'Set an email password before disconnecting Google')
                await env.DB.prepare('DELETE FROM connected_identities WHERE user_id = ? AND provider = ?').bind(session.user_id, 'google').run()
                return json({ result: true }, 200, request, env)
            }

            if (url.pathname === '/v1/user/remove' && request.method === 'GET') {
                const action = new URL('/v1/user/deletion', env.API_ORIGIN || request.url).toString()
                const deletion = await env.DB.prepare('SELECT requested_at, purge_after FROM account_deletions WHERE user_id = ?').bind(session.user_id).first()
                const scheduled = Boolean(deletion)
                const date = scheduled ? new Date(deletion.purge_after).toISOString() : ''
                return new Response(`<!doctype html><meta charset="utf-8"><title>${scheduled ? 'Restore account' : 'Schedule account deletion'}</title><main><h1>${scheduled ? 'Restore account' : 'Schedule account deletion'}</h1><p>${scheduled ? 'Deletion is scheduled for ' + date + '.' : 'Your account can be restored for 30 days.'}</p><button>${scheduled ? 'Restore account' : 'Schedule deletion'}</button><p id="result"></p><script>document.querySelector('button').onclick=async()=>{const r=await fetch('${action}',{method:'${scheduled ? 'DELETE' : 'POST'}',credentials:'include'});document.querySelector('#result').textContent=r.ok?'Done.':'Request failed.';if(r.ok)setTimeout(()=>location.reload(),500)}</script></main>`, {
                    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Request-ID': requestId(request) }
                })
            }

            if (url.pathname === '/v1/user/deletion') {
                if (request.method === 'GET') {
                    const deletion = await env.DB.prepare('SELECT requested_at, purge_after FROM account_deletions WHERE user_id = ?').bind(session.user_id).first()
                    return json({ result: true, deletion: deletion || null }, 200, request, env)
                }
                if (request.method === 'POST') {
                    const shared = await hasSharedCollections(env, session.user_id)
                    if (shared)
                        return error('shared_collections_pending', 409, request, env, 'Transfer or remove collaborators from shared collections before deletion')
                    const requestedAt = Date.now()
                    const purgeAfter = requestedAt + deletionDays * 86400 * 1000
                    await env.DB.prepare('INSERT INTO account_deletions (user_id, requested_at, purge_after) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET requested_at = excluded.requested_at, purge_after = excluded.purge_after')
                        .bind(session.user_id, requestedAt, purgeAfter).run()
                    return json({ result: true, purge_after: purgeAfter }, 202, request, env)
                }
                if (request.method === 'DELETE') {
                    const result = await env.DB.prepare('DELETE FROM account_deletions WHERE user_id = ?').bind(session.user_id).run()
                    return json({ result: true, cancelled: Boolean(result.meta.changes) }, 200, request, env)
                }
            }

            if (url.pathname === '/v1/user' && request.method === 'GET')
                return json({ result: true, user: publicUser(session) }, 200, request, env)

            if (url.pathname === '/v1/user/stats' && request.method === 'GET') {
                const rows = await env.DB.prepare(`SELECT
                    SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END) AS all_count,
                    SUM(CASE WHEN removed_at IS NULL AND collection_id = -1 THEN 1 ELSE 0 END) AS unsorted_count,
                    SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS trash_count
                    FROM bookmarks WHERE user_id = ?`).bind(session.user_id).first()
                return json({ result: true, items: [
                    { _id: 0, count: Number(rows?.all_count || 0) },
                    { _id: -1, count: Number(rows?.unsorted_count || 0) },
                    { _id: -99, count: Number(rows?.trash_count || 0) }
                ] }, 200, request, env)
            }

            if (url.pathname === '/v1/collections/all' && request.method === 'GET') {
                const removed = url.searchParams.get('removed') === 'true'
                const rows = await env.DB.prepare(`SELECT c.*, COUNT(b.id) AS count
                    FROM collections c LEFT JOIN bookmarks b ON b.collection_id = c.id AND b.removed_at IS NULL
                    WHERE c.user_id = ? AND c.removed_at IS ${removed ? 'NOT NULL' : 'NULL'} GROUP BY c.id ORDER BY c.id`).bind(session.user_id).all()
                return json({ result: true, items: rows.results.map(collectionItem) }, 200, request, env)
            }

            if (url.pathname === '/v1/collections' && request.method === 'DELETE') {
                const { data } = await readBody(request)
                const roots = Array.isArray(data.ids) ? data.ids.map(Number) : []
                if (!roots.length || roots.some(id => !Number.isSafeInteger(id) || id <= 0))
                    return error('validation_failed', 400, request, env, 'Provide one or more Collection IDs')
                const collections = await userCollections(env, session.user_id)
                if (roots.some(id => !collections.some(item => Number(item.id) === id && !item.removed_at)))
                    return error('collection_not_found', 404, request, env)
                const ids = descendantCollectionIds(collections, roots)
                const now = Date.now()
                const placeholders = ids.map(() => '?').join(',')
                await env.DB.prepare(`UPDATE bookmarks SET removed_at = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND collection_id IN (${placeholders})`)
                    .bind(now, now, session.user_id, ...ids).run()
                await env.DB.prepare(`UPDATE collections SET removed_at = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND id IN (${placeholders})`)
                    .bind(now, now, session.user_id, ...ids).run()
                return json({ result: true, count: ids.length, ...(await bookmarkSync(env, session.user_id)) }, 200, request, env)
            }

            if (url.pathname === '/v1/collection' && request.method === 'POST') {
                const { data } = await readBody(request)
                const title = String(data.title || '').trim()
                if (!title || title.length > 200)
                    return error('validation_failed', 400, request, env, 'Enter a collection title under 200 characters')
                const parentId = parseCollectionId(data.parentId)
                if (Number.isNaN(parentId) || parentId && !await collectionOwned(env, session.user_id, parentId))
                    return error('collection_not_found', 404, request, env)
                const now = Date.now()
                const inserted = await env.DB.prepare('INSERT INTO collections (user_id, title, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
                    .bind(session.user_id, title, parentId || null, now, now).run()
                return json({ result: true, item: collectionItem({ id: inserted.meta.last_row_id, title, parent_id: parentId || null }) }, 201, request, env)
            }

            const collectionMatch = url.pathname.match(/^\/v1\/collection\/(-?\d+)(?:\/lastAction)?$/)
            if (collectionMatch && url.pathname.endsWith('/lastAction') && request.method === 'GET') {
                const marker = await bookmarkSync(env, session.user_id)
                return json({ result: true, ...marker }, 200, request, env)
            }

            if (collectionMatch && !url.pathname.endsWith('/lastAction')) {
                const collectionId = Number(collectionMatch[1])
                if (request.method === 'GET') {
                    const item = await env.DB.prepare(`SELECT c.*, COUNT(b.id) AS count FROM collections c
                        LEFT JOIN bookmarks b ON b.collection_id = c.id AND b.removed_at IS NULL
                        WHERE c.id = ? AND c.user_id = ? GROUP BY c.id`).bind(collectionId, session.user_id).first()
                    return item ? json({ result: true, item: collectionItem(item) }, 200, request, env) : error('collection_not_found', 404, request, env)
                }
                if (request.method === 'PUT') {
                    const { data } = await readBody(request)
                    const existing = await env.DB.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').bind(collectionId, session.user_id).first()
                    if (!existing) return error('collection_not_found', 404, request, env)

                    if (data.removed === false && existing.removed_at) {
                        const collections = await userCollections(env, session.user_id)
                        const ids = descendantCollectionIds(collections, [collectionId])
                        const now = Date.now()
                        const placeholders = ids.map(() => '?').join(',')
                        await env.DB.prepare(`UPDATE collections SET removed_at = NULL, updated_at = ? WHERE user_id = ? AND id IN (${placeholders})`)
                            .bind(now, session.user_id, ...ids).run()
                        await env.DB.prepare(`UPDATE bookmarks SET removed_at = NULL, updated_at = ? WHERE user_id = ? AND collection_id IN (${placeholders}) AND removed_at >= ?`)
                            .bind(now, session.user_id, ...ids, Number(existing.removed_at)).run()
                        const item = await env.DB.prepare(`SELECT c.*, COUNT(b.id) AS count FROM collections c
                            LEFT JOIN bookmarks b ON b.collection_id = c.id AND b.removed_at IS NULL
                            WHERE c.id = ? AND c.user_id = ? GROUP BY c.id`).bind(collectionId, session.user_id).first()
                        return json({ result: true, item: collectionItem(item || { ...existing, removed_at: null }) }, 200, request, env)
                    }

                    const title = data.title === undefined ? existing.title : String(data.title).trim()
                    if (!title || title.length > 200)
                        return error('validation_failed', 400, request, env, 'Enter a collection title under 200 characters')
                    const parentId = data.parentId === undefined ? existing.parent_id : parseCollectionId(data.parentId)
                    if (Number.isNaN(parentId) || parentId && !await collectionParentAllowed(env, session.user_id, collectionId, parentId))
                        return error('collection_not_found', 404, request, env)
                    await env.DB.prepare('UPDATE collections SET title = ?, parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(title, parentId || null, Date.now(), collectionId, session.user_id).run()
                    return json({ result: true, item: collectionItem({ ...existing, title, parent_id: parentId || null }) }, 200, request, env)
                }
                if (request.method === 'DELETE') {
                    if (collectionId === -99) {
                        const removed = await env.DB.prepare('SELECT id FROM bookmarks WHERE user_id = ? AND removed_at IS NOT NULL').bind(session.user_id).all()
                        const bookmarkIds = (removed.results || []).map(item => Number(item.id))
                        if (bookmarkIds.length) {
                            const placeholders = bookmarkIds.map(() => '?').join(',')
                            await env.DB.prepare(`DELETE FROM bookmark_changes WHERE user_id = ? AND bookmark_id IN (${placeholders})`).bind(session.user_id, ...bookmarkIds).run()
                            await env.DB.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND id IN (${placeholders}) AND removed_at IS NOT NULL`).bind(session.user_id, ...bookmarkIds).run()
                        }
                        const collections = await env.DB.prepare('SELECT id FROM collections WHERE user_id = ? AND removed_at IS NOT NULL').bind(session.user_id).all()
                        const collectionIds = (collections.results || []).map(item => Number(item.id))
                        if (collectionIds.length) {
                            const placeholders = collectionIds.map(() => '?').join(',')
                            await env.DB.prepare(`DELETE FROM collection_collaborators WHERE collection_id IN (${placeholders})`).bind(...collectionIds).run()
                            await env.DB.prepare(`DELETE FROM collections WHERE user_id = ? AND id IN (${placeholders}) AND removed_at IS NOT NULL`).bind(session.user_id, ...collectionIds).run()
                        }
                        return json({ result: true, count: bookmarkIds.length, collections: collectionIds.length }, 200, request, env)
                    }

                    if (collectionId <= 0)
                        return error('collection_not_found', 404, request, env)
                    const existing = await env.DB.prepare('SELECT id, removed_at FROM collections WHERE id = ? AND user_id = ?').bind(collectionId, session.user_id).first()
                    if (!existing || existing.removed_at)
                        return error('collection_not_found', 404, request, env)
                    const collections = await userCollections(env, session.user_id)
                    const ids = descendantCollectionIds(collections, [collectionId])
                    const placeholders = ids.map(() => '?').join(',')
                    const now = Date.now()
                    await env.DB.prepare(`UPDATE bookmarks SET removed_at = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND collection_id IN (${placeholders})`)
                        .bind(now, now, session.user_id, ...ids).run()
                    await env.DB.prepare(`UPDATE collections SET removed_at = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND id IN (${placeholders})`)
                        .bind(now, now, session.user_id, ...ids).run()
                    return json({ result: true, count: ids.length, ...(await bookmarkSync(env, session.user_id)) }, 200, request, env)
                }
            }

            if (url.pathname === '/v1/collections/clean' && request.method === 'PUT') {
                const collections = (await userCollections(env, session.user_id)).filter(item => !item.removed_at)
                const bookmarks = await env.DB.prepare('SELECT collection_id FROM bookmarks WHERE user_id = ? AND removed_at IS NULL').bind(session.user_id).all()
                const used = new Set((bookmarks.results || []).map(item => Number(item.collection_id)))
                const empty = new Set(collections.filter(item => !used.has(Number(item.id))).map(item => Number(item.id)))
                let changed = true
                while (changed) {
                    changed = false
                    for (const item of collections)
                        if (empty.has(Number(item.id)) && collections.some(child => Number(child.parent_id) === Number(item.id) && !empty.has(Number(child.id)))) {
                            empty.delete(Number(item.id))
                            changed = true
                        }
                }
                const depth = id => {
                    let level = 0
                    let current = collections.find(item => Number(item.id) === id)
                    while (current?.parent_id) {
                        level++
                        current = collections.find(item => Number(item.id) === Number(current.parent_id))
                    }
                    return level
                }
                const ids = [...empty].sort((left, right) => depth(right) - depth(left))
                for (const id of ids) {
                    await env.DB.prepare('DELETE FROM collection_collaborators WHERE collection_id = ?').bind(id).run()
                    await env.DB.prepare('DELETE FROM collections WHERE user_id = ? AND id = ? AND removed_at IS NULL').bind(session.user_id, id).run()
                }
                return json({ result: true, count: ids.length }, 200, request, env)
            }

            const listMatch = url.pathname.match(/^\/v1\/raindrops\/(-?\d+)$/)
            if (listMatch && request.method === 'DELETE') {
                const collectionId = Number(listMatch[1])
                if (collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId))
                    return error('collection_not_found', 404, request, env)
                const { data } = await readBody(request)
                const ids = Array.isArray(data.ids) ? data.ids.map(Number) : []
                if (ids.some(id => !Number.isSafeInteger(id) || id <= 0))
                    return error('validation_failed', 400, request, env, 'Bookmark IDs must be positive integers')
                if (collectionId === -99) {
                    let query = 'SELECT id FROM bookmarks WHERE user_id = ? AND removed_at IS NOT NULL'
                    const values = [session.user_id]
                    if (ids.length) {
                        query += ` AND id IN (${ids.map(() => '?').join(',')})`
                        values.push(...ids)
                    }
                    const removed = await env.DB.prepare(query).bind(...values).all()
                    const bookmarkIds = (removed.results || []).map(item => Number(item.id))
                    if (bookmarkIds.length) {
                        const placeholders = bookmarkIds.map(() => '?').join(',')
                        await env.DB.prepare(`DELETE FROM bookmark_changes WHERE user_id = ? AND bookmark_id IN (${placeholders})`).bind(session.user_id, ...bookmarkIds).run()
                        await env.DB.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND id IN (${placeholders}) AND removed_at IS NOT NULL`).bind(session.user_id, ...bookmarkIds).run()
                    }
                    return json({ result: true, count: bookmarkIds.length }, 200, request, env)
                }
                const now = Date.now()
                let query = 'UPDATE bookmarks SET removed_at = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL'
                const values = [now, now, session.user_id]
                if (collectionId > 0) {
                    query += ' AND collection_id = ?'
                    values.push(collectionId)
                } else if (collectionId === -1) {
                    query += ' AND collection_id = -1'
                }
                if (ids.length) {
                    query += ` AND id IN (${ids.map(() => '?').join(',')})`
                    values.push(...ids)
                }
                const result = await env.DB.prepare(query).bind(...values).run()
                return json({ result: true, count: Number(result.meta?.changes || 0), ...(await bookmarkSync(env, session.user_id)) }, 200, request, env)
            }
            if (listMatch && request.method === 'GET') {
                const since = requestedSyncVersion(url)
                if (since === -1)
                    return error('validation_failed', 400, request, env, 'Change Version must be a non-negative integer')
                if (since !== null) {
                    const items = await changedBookmarks(env, session.user_id, since)
                    const marker = await bookmarkSync(env, session.user_id)
                    return json({ result: true, items, count: items.length, ...marker, fromVersion: since }, 200, request, env)
                }
                const spaceId = Number(listMatch[1])
                const search = String(url.searchParams.get('search') || '').replace(/^"|"$/g, '')
                let where = 'user_id = ?'
                const values = [session.user_id]
                if (spaceId === -99) where += ' AND removed_at IS NOT NULL'
                else {
                    where += ' AND removed_at IS NULL'
                    if (spaceId !== 0) { where += ' AND collection_id = ?'; values.push(spaceId) }
                }
                if (search) {
                    where += ' AND (title LIKE ? OR url LIKE ? OR description LIKE ? OR tags LIKE ? OR note LIKE ? OR highlights LIKE ?)'
                    values.push(...Array(6).fill(`%${search}%`))
                }
                const rows = await env.DB.prepare(`SELECT id, user_id, url, title, description, note, collection_id, tags, highlights, removed_at, created_at, updated_at, change_version FROM bookmarks WHERE ${where} ORDER BY updated_at DESC`).bind(...values).all()
                const marker = await bookmarkSync(env, session.user_id)
                return json({ result: true, items: rows.results.map(bookmarkItem), count: rows.results.length, ...marker }, 200, request, env)
            }

            if (url.pathname === '/v1/raindrops/changes' && request.method === 'GET') {
                const since = requestedSyncVersion(url)
                if (since === null || since === -1)
                    return error('validation_failed', 400, request, env, 'Provide a non-negative Change Version')
                const items = await changedBookmarks(env, session.user_id, since)
                const marker = await bookmarkSync(env, session.user_id)
                return json({ result: true, items, count: items.length, ...marker, fromVersion: since }, 200, request, env)
            }

            if (url.pathname === '/v1/raindrops' && request.method === 'POST') {
                const { data } = await readBody(request)
                if (!Array.isArray(data.items) || !data.items.length)
                    return error('validation_failed', 400, request, env, 'Provide at least one bookmark')
                const items = []
                for (const input of data.items) {
                    const link = String(input.link || input.url || '').trim()
                    const title = String(input.title || '').trim()
                    if (!['http:', 'https:'].includes((() => { try { return new URL(link).protocol } catch { return '' } })()))
                        return error('validation_failed', 400, request, env, 'Enter an HTTP(S) bookmark URL')
                    if (input.tags !== undefined && !validTagList(input.tags))
                        return error('validation_failed', 400, request, env, 'Bookmark tags must be 100 characters or fewer')
                    const description = String(input.description ?? input.excerpt ?? '').trim()
                    const note = String(input.note || '').trim()
                    const highlights = input.highlights === undefined ? [] : input.highlights
                    if (description.length > 10000 || note.length > 10000 || !validHighlightChanges(highlights))
                        return error('validation_failed', 400, request, env, 'Bookmark metadata is invalid')
                    const now = Date.now()
                    const collectionId = input.collectionId === undefined ? -1 : parseBookmarkCollectionId(input.collectionId)
                    if (!Number.isSafeInteger(collectionId) || collectionId < -1 || !await collectionOwned(env, session.user_id, collectionId))
                        return error('collection_not_found', 404, request, env)
                    const tags = bookmarkTags(input.tags)
                    const inserted = await env.DB.prepare('INSERT INTO bookmarks (user_id, url, title, description, note, highlights, created_at, updated_at, collection_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                        .bind(session.user_id, link, title, description, note, JSON.stringify(applyHighlightChanges('[]', highlights)), now, now, collectionId, JSON.stringify(tags)).run()
                    const item = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
                        .bind(inserted.meta.last_row_id, session.user_id).first()
                    items.push(bookmarkItem(item || { id: inserted.meta.last_row_id, url: link, title, description, note, highlights: JSON.stringify(highlights), created_at: now, updated_at: now, collection_id: collectionId, tags: JSON.stringify(tags), removed_at: null }))
                }
                return json({ result: true, items, ...(await bookmarkSync(env, session.user_id)) }, 201, request, env)
            }

            if (url.pathname === '/v1/raindrop' && request.method === 'POST') {
                const { data } = await readBody(request)
                const bookmarkUrl = String(data.link || data.url || '').trim()
                const title = String(data.title || '').trim()
                let protocol
                try {
                    protocol = new URL(bookmarkUrl).protocol
                } catch {
                    protocol = ''
                }
                if (!['http:', 'https:'].includes(protocol) || title.length > 500)
                    return error('validation_failed', 400, request, env, 'Enter an HTTP(S) bookmark URL and a title under 500 characters')
                if (data.tags !== undefined && !validTagList(data.tags))
                    return error('validation_failed', 400, request, env, 'Bookmark tags must be 100 characters or fewer')
                const description = String(data.description ?? data.excerpt ?? '').trim()
                const note = String(data.note || '').trim()
                const highlights = data.highlights === undefined ? [] : data.highlights
                if (description.length > 10000 || note.length > 10000 || !validHighlightChanges(highlights))
                    return error('validation_failed', 400, request, env, 'Bookmark metadata is invalid')

                const now = Date.now()
                const collectionId = data.collectionId === undefined ? -1 : parseBookmarkCollectionId(data.collectionId)
                if (!Number.isSafeInteger(collectionId) || collectionId < -1 || !await collectionOwned(env, session.user_id, collectionId))
                    return error('collection_not_found', 404, request, env)
                const tags = bookmarkTags(data.tags)
                const inserted = await env.DB.prepare('INSERT INTO bookmarks (user_id, url, title, description, note, highlights, created_at, updated_at, collection_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .bind(session.user_id, bookmarkUrl, title, description, note, JSON.stringify(applyHighlightChanges('[]', highlights)), now, now, collectionId, JSON.stringify(tags)).run()
                const item = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
                    .bind(inserted.meta.last_row_id, session.user_id).first()
                return json({
                    result: true,
                    item: bookmarkItem(item || { id: inserted.meta.last_row_id, url: bookmarkUrl, title, description, note, highlights: JSON.stringify(highlights), created_at: now, updated_at: now, collection_id: collectionId, tags: JSON.stringify(tags), removed_at: null }),
                    ...(await bookmarkSync(env, session.user_id))
                }, 201, request, env)
            }

            const highlightExport = url.pathname.match(/^\/v1\/raindrop\/(\d+)\/highlights\.(txt|csv)$/)
            if (highlightExport && request.method === 'GET') {
                const bookmark = await env.DB.prepare('SELECT highlights FROM bookmarks WHERE id = ? AND user_id = ?')
                    .bind(Number(highlightExport[1]), session.user_id).first()
                if (!bookmark) return error('bookmark_not_found', 404, request, env)
                const highlights = bookmarkHighlights(bookmark.highlights)
                const body = highlightExport[2] === 'csv'
                    ? ['text,note,color,created', ...highlights.map(item => [item.text, item.note, item.color, item.created].map(value => JSON.stringify(value)).join(','))].join('\n')
                    : highlights.map(item => item.text + (item.note ? '\n' + item.note : '')).join('\n\n')
                const headers = addCorsHeaders(new Headers({
                    'Content-Type': highlightExport[2] === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
                    'X-Request-ID': requestId(request)
                }), request, env)
                return new Response(body, { status: 200, headers })
            }

            const bookmarkMatch = url.pathname.match(/^\/v1\/raindrop\/(\d+)$/)
            if (bookmarkMatch) {
                const bookmarkId = Number(bookmarkMatch[1])
                const existing = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?').bind(bookmarkId, session.user_id).first()
                if (!existing) return error('bookmark_not_found', 404, request, env)
                if (request.method === 'GET')
                    return json({ result: true, item: bookmarkItem(existing) }, 200, request, env)
                if (request.method === 'PUT') {
                    const { data } = await readBody(request)
                    const title = data.title === undefined ? existing.title : String(data.title).trim()
                    const link = data.link === undefined ? existing.url : String(data.link).trim()
                    const description = data.description === undefined && data.excerpt === undefined
                        ? existing.description || existing.excerpt || ''
                        : String(data.description ?? data.excerpt).trim()
                    const note = data.note === undefined ? existing.note || '' : String(data.note).trim()
                    const tags = data.tags === undefined ? bookmarkTags(existing.tags) : bookmarkTags(data.tags)
                    let collectionId = data.collectionId === undefined ? existing.collection_id : parseBookmarkCollectionId(data.collectionId)
                    const removedAt = data.removed === false ? null : existing.removed_at
                    const highlights = data.highlights === undefined ? bookmarkHighlights(existing.highlights) : data.highlights
                    if (data.collectionId === undefined && data.removed === false && collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId))
                        collectionId = -1
                    let protocol
                    try {
                        protocol = new URL(link).protocol
                    } catch {
                        protocol = ''
                    }
                    if (!['http:', 'https:'].includes(protocol) || title.length > 500 || description.length > 10000 || note.length > 10000)
                        return error('validation_failed', 400, request, env, 'Enter an HTTP(S) bookmark URL and a title under 500 characters')
                    if (data.tags !== undefined && !validTagList(data.tags))
                        return error('validation_failed', 400, request, env, 'Bookmark tags must be 100 characters or fewer')
                    if (!Number.isSafeInteger(collectionId) || collectionId < -1 || !await collectionOwned(env, session.user_id, collectionId))
                        return error('collection_not_found', 404, request, env)
                    if (!validHighlightChanges(highlights))
                        return error('validation_failed', 400, request, env, 'Highlight text and note must be valid')
                    await env.DB.prepare('UPDATE bookmarks SET url = ?, title = ?, description = ?, note = ?, collection_id = ?, tags = ?, highlights = ?, removed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(link, title, description, note, collectionId, JSON.stringify(tags), JSON.stringify(applyHighlightChanges(existing.highlights, highlights)), removedAt, Date.now(), bookmarkId, session.user_id).run()
                    const item = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?').bind(bookmarkId, session.user_id).first()
                    return json({ result: true, item: bookmarkItem(item), ...(await bookmarkSync(env, session.user_id)) }, 200, request, env)
                }
                if (request.method === 'DELETE') {
                    const now = Date.now()
                    await env.DB.prepare('UPDATE bookmarks SET removed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(now, now, bookmarkId, session.user_id).run()
                    return json({ result: true, ...(await bookmarkSync(env, session.user_id)) }, 200, request, env)
                }
            }

            const tagsMatch = url.pathname.match(/^\/v1\/tags\/(-?\d+)$/)
            if (tagsMatch && request.method === 'GET') {
                const collectionId = Number(tagsMatch[1])
                if (collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId))
                    return error('collection_not_found', 404, request, env)
                const tags = await tagItems(env, session.user_id, collectionId, url.searchParams.get('search'), url.searchParams.get('tagsSort'))
                return json({ result: true, items: tags, tags }, 200, request, env)
            }

            if (url.pathname === '/v1/tags/recent' && request.method === 'GET') {
                const tags = await tagItems(env, session.user_id, 0, '', 'recent')
                return json({ result: true, items: tags.slice(0, 20) }, 200, request, env)
            }

            if (url.pathname === '/v1/tags/0' && request.method === 'PUT') {
                const { data } = await readBody(request)
                const tag = tagValue(data.tag)
                const replacement = tagValue(data.replace)
                if (!tag || !replacement || tag.length > 100 || replacement.length > 100)
                    return error('validation_failed', 400, request, env, 'Tag names must be between 1 and 100 characters')
                const updated = await mutateBookmarkTags(env, session.user_id, tags =>
                    tags.includes(tag) ? [...new Set(tags.map(value => value === tag ? replacement : value))] : null)
                if (!updated) return error('conflict', 409, request, env, 'Tag update conflicted; retry the request')
                return json({ result: true }, 200, request, env)
            }

            if (url.pathname === '/v1/tag' && request.method === 'DELETE') {
                const tag = tagValue(url.searchParams.get('tag'))
                if (!tag || tag.length > 100)
                    return error('validation_failed', 400, request, env, 'Tag name must be between 1 and 100 characters')
                const updated = await mutateBookmarkTags(env, session.user_id, tags =>
                    tags.includes(tag) ? tags.filter(value => value !== tag) : null)
                if (!updated) return error('conflict', 409, request, env, 'Tag update conflicted; retry the request')
                return json({ result: true }, 200, request, env)
            }

            const filtersMatch = url.pathname.match(/^\/v1\/filters\/(-?\d+)$/)
            if (filtersMatch && request.method === 'GET') {
                const collectionId = Number(filtersMatch[1])
                if (collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId))
                    return error('collection_not_found', 404, request, env)
                const tags = await tagItems(env, session.user_id, collectionId, url.searchParams.get('search'), url.searchParams.get('tagsSort'))
                return json({ result: true, items: [], tags }, 200, request, env)
            }

            if (url.pathname === '/v1/user/send_email_confirm' && request.method === 'POST') {
                if (session.email_verified_at)
                    return json({ result: true, verified: true }, 200, request, env)

                const token = await createVerification(env, session.user_id)
                if (!await sendVerification(env, session.email, token))
                    return error('email_delivery_failed', 502, request, env, 'Could not send confirmation email')
                return json({ result: true }, 200, request, env)
            }

            if (url.pathname === '/v1/sessions' && request.method === 'GET') {
                const records = await env.DB.prepare('SELECT id, device_name, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC')
                    .bind(session.user_id, Date.now()).all()
                return json({
                    result: true,
                    items: records.results.map(item => ({ ...item, current: item.id === session.session_id }))
                }, 200, request, env)
            }

            const sessionId = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/)?.[1]
            if (sessionId && request.method === 'DELETE') {
                const result = await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL')
                    .bind(Date.now(), session.user_id, sessionId).run()
                if (!result.meta.changes)
                    return error('session_not_found', 404, request, env, 'Session was not found')
                return json({ result: true }, 200, request, env, sessionId === session.session_id ? { 'Set-Cookie': expiredSessionCookie } : {})
            }

            return error('route_not_implemented', 404, request, env)
        }

        return error('not_found', 404, request, env)
    },

    async scheduled(controller, env, ctx) {
        ctx.waitUntil(purgeExpiredDeletions(env))
    }
}
