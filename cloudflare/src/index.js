/* global Symbol, Uint8Array */

const encoder = new TextEncoder()
const sessionDays = 30
const verificationHours = 24
const googleStateMinutes = 10
const deletionDays = 30
const passwordIterations = 100000
const usageWindowMs = 24 * 60 * 60 * 1000
const rateWindowMs = 60 * 1000
const metadataTaskType = 'metadata_enrichment'
const attachmentTaskType = 'attachment_scan'
const captureTaskType = 'capture'
const migrationTaskType = 'migration_import'
const backupTaskType = 'backup'
const backgroundTaskTypes = new Set([metadataTaskType, attachmentTaskType, captureTaskType, migrationTaskType])
const metadataMaxRetries = 3
const metadataMaxRedirects = 5
const metadataBodyLimit = 256 * 1024
const contentBodyLimit = 50 * 1024 * 1024
const multipartOverhead = 16 * 1024
const captureBodyLimit = 10 * 1024 * 1024
const metadataFetchTimeoutMs = 8000
const metadataLeaseMs = 60 * 1000
const metadataRetryDelays = [5, 30, 300]
const invitationDays = 7
const collectionRoles = new Set(['owner', 'editor', 'viewer'])
const migrationDefaultMaxBytes = 2 * 1024 * 1024
const migrationMaxItems = 10000
const backupDailyRetention = 30
const backupMonthlyRetention = 12
const backupMaxBytes = 16 * 1024 * 1024
const backupUserPageSize = 100
const backupProviders = new Set(['gdrive', 'onedrive', 'webdav'])

const requestId = request => request.headers.get('X-Request-ID') || String(Date.now()) + '-' + Math.random()

const addCorsHeaders = (headers, request, env) => {
    const origin = request.headers.get('Origin')
    const allowedOrigins = String(env.CORS_ORIGINS || '').split(/\s+/).filter(Boolean)
    try {
        const aiOrigin = new URL(env.AI_PAGE_ORIGIN).origin
        if (aiOrigin && !allowedOrigins.includes(aiOrigin)) allowedOrigins.push(aiOrigin)
    } catch {}

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

const integerEnv = (env, names, fallback) => {
    for (const name of names) {
        const value = Number(env[name])
        if (Number.isSafeInteger(value) && value > 0) return value
    }
    return fallback
}

const attachmentMaxBytes = env => Math.min(
    contentBodyLimit,
    integerEnv(env, ['ATTACHMENT_MAX_BYTES', 'CONTENT_MAX_BYTES'], contentBodyLimit)
)

const attachmentScanEnabled = env => !['false', '0', 'off', 'no'].includes(
    String(env.ATTACHMENT_SCAN_ENABLED ?? 'true').trim().toLowerCase()
)

const retryableError = (code, request, env, errorMessage, retryAfterMs, details = {}) => {
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000))
    const retryAt = details.retryAt || new Date(Date.now() + retryAfter * 1000).toISOString()
    return json({ result: false, error: code, errorMessage, retryAfter, retryAt, ...details }, 429, request, env, {
        'Retry-After': String(retryAfter),
        'Cache-Control': 'no-store'
    })
}

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

const credentialKey = async env => {
    const secret = env.BACKUP_CREDENTIAL_KEY || env.SESSION_SECRET
    if (!secret) throw new Error('Backup credential encryption is not configured')
    const source = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey'])
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: encoder.encode('raindrop-backup-credentials'), iterations: passwordIterations, hash: 'SHA-256' },
        source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const encryptCredentials = async (env, credentials) => {
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await credentialKey(env), encoder.encode(JSON.stringify(credentials)))
    return bytesToBase64url(iv) + '.' + bytesToBase64url(new Uint8Array(encrypted))
}

const decryptCredentials = async (env, value) => {
    const [iv, encrypted] = String(value || '').split('.')
    if (!iv || !encrypted) throw new Error('Invalid encrypted credentials')
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64urlToBytes(iv) }, await credentialKey(env), base64urlToBytes(encrypted))
    return JSON.parse(new TextDecoder().decode(clear))
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

const migrationSourceId = (item, index, type) => {
    const value = item?.sourceId ?? item?.source_id ?? item?._id ?? item?.id
    return String(value === undefined || value === null || value === '' ? type + ':' + index : value).trim().slice(0, 200)
}

const migrationArray = (root, names) => {
    for (const name of names)
        if (Array.isArray(root?.[name])) return root[name]
    return []
}

const migrationCollectionSourceId = value => {
    if (value === undefined || value === null || value === '' || value === 0 || value === '0' || value === 'root') return null
    return String(value).trim().slice(0, 200) || null
}

const bytesToBase64 = bytes => {
    let value = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
        value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    return btoa(value)
}

const base64ToBytes = value => Uint8Array.from(
    atob(String(value).replace(/-/g, '+').replace(/_/g, '/')),
    char => char.charCodeAt(0)
)

const migrationAssetData = (item, kind) => {
    const value = item?.data ?? item?.content ?? item?.body ?? (kind === 'snapshot' ? item?.html : null)
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') return null
    if (item?.encoding === 'base64' || /^data:[^;]+;base64,/i.test(value))
        return value.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '')
    return bytesToBase64(encoder.encode(value))
}

const migrationAssets = (root, name, kind) => migrationArray(root, [name]).map((item, index) => {
    const assetType = kind === 'cover' ? 'cover' : kind
    return {
        sourceId: migrationSourceId(item, index, assetType),
        assetType,
        bookmarkSourceId: migrationCollectionSourceId(item?.bookmarkId ?? item?.bookmark_id ?? item?.raindropId ?? item?.bookmark),
        filename: safeFilename(item?.filename || (assetType === 'snapshot' ? 'snapshot.html' : assetType === 'cover' ? 'cover.png' : 'attachment')),
        contentType: safeContentType(item?.contentType || item?.content_type || (assetType === 'snapshot' ? 'text/html' : assetType === 'cover' ? 'image/png' : 'application/octet-stream')),
        data: migrationAssetData(item, assetType)
    }
})

const normalizeMigrationArchive = input => {
    const root = input && typeof input === 'object' && !Array.isArray(input)
        ? (input.archive && typeof input.archive === 'object' && !Array.isArray(input.archive) ? input.archive : input)
        : { bookmarks: Array.isArray(input) ? input : [] }
    const collections = migrationArray(root, ['collections', 'folders', 'spaces']).map((item, index) => ({
        sourceId: migrationSourceId(item, index, 'collection'),
        title: String(item?.title || item?.name || '').trim(),
        parentSourceId: migrationCollectionSourceId(item?.parentId ?? item?.parent_id ?? item?.parent),
        slug: slugify(item?.slug)
    }))
    const bookmarks = migrationArray(root, ['bookmarks', 'raindrops', 'items']).map((item, index) => {
        const link = String(item?.link ?? item?.url ?? '').trim()
        const tags = bookmarkTags(item?.tags)
        const highlights = item?.highlights === undefined ? [] : item.highlights
        return {
            sourceId: migrationSourceId(item, index, 'bookmark'),
            url: link,
            title: String(item?.title || '').trim(),
            description: String(item?.description ?? item?.excerpt ?? '').trim(),
            note: String(item?.note || '').trim(),
            tags,
            highlights,
            collectionSourceId: migrationCollectionSourceId(item?.collectionId ?? item?.collection_id ?? item?.collection)
        }
    })

    const assets = [
        ...migrationAssets(root, 'attachments', 'attachment'),
        ...migrationAssets(root, 'covers', 'cover'),
        ...migrationAssets(root, 'snapshots', 'snapshot')
    ]
    if (collections.length + bookmarks.length + assets.length > migrationMaxItems)
        throw metadataFailure('migration_too_large', 'The migration archive contains too many records', true)
    if (!collections.length && !bookmarks.length)
        throw metadataFailure('migration_empty', 'The migration archive has no Collections or Bookmarks', true)
    const seen = new Set()
    for (const item of collections) {
        if (!item.title || item.title.length > 200 || seen.has('collection:' + item.sourceId))
            throw metadataFailure('migration_invalid', 'The migration archive contains invalid Collections', true)
        seen.add('collection:' + item.sourceId)
    }
    for (const item of bookmarks) {
        const urlCheck = validateFetchableUrl(item.url)
        if (!urlCheck.ok || item.title.length > 500 || item.description.length > 10000 || item.note.length > 10000 ||
            !validTagList(item.tags) || !validHighlightChanges(item.highlights) || seen.has('bookmark:' + item.sourceId))
            throw metadataFailure('migration_invalid', 'The migration archive contains invalid Bookmarks', true)
        seen.add('bookmark:' + item.sourceId)
    }
    for (const item of assets) {
        let validData = false
        try { validData = migrationAssetBytes(item.data).byteLength <= contentBodyLimit } catch {}
        if (!item.bookmarkSourceId || !validData || seen.has('content:' + item.sourceId))
            throw metadataFailure('migration_invalid', 'The migration archive contains invalid Protected Content', true)
        seen.add('content:' + item.sourceId)
    }
    return {
        source: String(root.source || root.provider || 'archive').trim().slice(0, 100) || 'archive',
        collections,
        bookmarks,
        assets
    }
}

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
        cover: item.cover || '',
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
        b.cover, b.collection_id, b.tags, b.highlights, b.removed_at, b.created_at, b.updated_at,
        c.version AS sync_version
        FROM bookmark_changes c JOIN bookmarks b ON b.id = c.bookmark_id AND b.user_id = c.user_id
        WHERE c.user_id = ? AND c.version > ? ORDER BY c.version`).bind(userId, since).all()
    const latest = new Map()
    for (const row of rows.results || [])
        latest.set(row.id, { ...row, change_version: row.sync_version })
    return [...latest.values()].map(bookmarkItem)
}

const ipv4Parts = hostname => {
    if (!/^\d+(?:\.\d+){3}$/.test(hostname)) return null
    const parts = hostname.split('.').map(Number)
    return parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

const privateIpv4 = parts => {
    if (!parts) return false
    const [first, second, third, fourth] = parts
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
        first === 100 && second >= 64 && second <= 127 ||
        first === 169 && second === 254 ||
        first === 172 && second >= 16 && second <= 31 ||
        first === 192 && (second === 0 || second === 2 || second === 168) ||
        first === 192 && second === 88 && third === 99 ||
        first === 198 && (second === 18 || second === 19 || second === 51) ||
        first === 203 && second === 0 && third === 113 ||
        first === 255 && second === 255 && third === 255 && fourth === 255
}

const ipv6Parts = hostname => {
    const value = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
    if (!value.includes(':')) return null
    const halves = value.split('::')
    if (halves.length > 2) return null
    const parse = part => part ? part.split(':').map(value => /^[0-9a-f]{1,4}$/.test(value) ? parseInt(value, 16) : NaN) : []
    const left = parse(halves[0])
    const right = parse(halves[1] || '')
    if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null
    const missing = 8 - left.length - right.length
    if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return null
    return [...left, ...Array(Math.max(0, missing)).fill(0), ...right]
}

const privateIpv6 = parts => {
    if (!parts) return false
    const first = parts[0]
    const allZero = parts.every(part => part === 0)
    const mapped = parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff
    const mappedIpv4 = mapped ? [parts[6] >> 8, parts[6] & 255, parts[7] >> 8, parts[7] & 255] : null
    return allZero || parts.every((part, index) => index === 7 ? part === 1 : part === 0) ||
        first >= 0xfc00 && first <= 0xfdff ||
        first >= 0xfe80 && first <= 0xfebf ||
        first >= 0xff00 ||
        first === 0x2001 && parts[1] === 0xdb8 ||
        mapped && privateIpv4(mappedIpv4)
}

const validateFetchableUrl = value => {
    try {
        const url = new URL(String(value || '').trim())
        const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
        const protocol = url.protocol.toLowerCase()
        const blockedName = hostname === 'localhost' || hostname.endsWith('.localhost') ||
            hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.intranet') ||
            hostname === 'metadata' || hostname === 'metadata.google.internal' ||
            hostname === 'instance-data' || hostname === 'host.docker.internal' || hostname.endsWith('.svc') ||
            hostname === 'localtest.me' || hostname.endsWith('.localtest.me') ||
            hostname.endsWith('.nip.io') || hostname.endsWith('.sslip.io') || hostname.endsWith('.lvh.me')
        const address = ipv4Parts(hostname)
        const ipv6 = ipv6Parts(hostname)
        const isIp = Boolean(address || ipv6)

        if (!['http:', 'https:'].includes(protocol) || !hostname || blockedName ||
            !isIp && !hostname.includes('.') || privateIpv4(address) || privateIpv6(ipv6) ||
            url.username || url.password || url.port && !((protocol === 'http:' && url.port === '80') || (protocol === 'https:' && url.port === '443')))
            return { ok: false, code: 'url_not_public', message: 'Only public HTTP(S) URLs can be processed' }

        return { ok: true, url }
    } catch {
        return { ok: false, code: 'url_not_public', message: 'Only public HTTP(S) URLs can be processed' }
    }
}

const resolvePublicAddress = async (url, env) => {
    const resolver = String(env.FETCH_DNS_RESOLVER || '').trim()
    const address = ipv4Parts(url.hostname) || ipv6Parts(url.hostname)
    if (!resolver || address) return

    let endpoint
    try {
        endpoint = new URL(resolver)
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('invalid resolver')
    } catch {
        throw metadataFailure('metadata_dns_failed', 'The remote address could not be resolved', true)
    }

    const answers = []
    for (const [type, typeNumber] of [['A', 1], ['AAAA', 28]]) {
        endpoint.search = new URLSearchParams({ name: url.hostname, type }).toString()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), metadataFetchTimeoutMs)
        let response
        try {
            response = await fetch(endpoint.toString(), {
                headers: { Accept: 'application/dns-json' },
                signal: controller.signal
            })
            if (!response.ok) throw new Error('resolver response')
            const body = await response.json()
            answers.push(...(body.Answer || []).filter(item => Number(item.type) === typeNumber).map(item => String(item.data || '')))
        } catch {
            throw metadataFailure('metadata_dns_failed', 'The remote address could not be resolved', true)
        } finally {
            clearTimeout(timer)
        }
    }

    if (!answers.length)
        throw metadataFailure('metadata_dns_failed', 'The remote address could not be resolved', true)
    if (answers.some(value => privateIpv4(ipv4Parts(value)) || privateIpv6(ipv6Parts(value))))
        throw metadataFailure('url_not_public', 'The remote address is not public', true)
}

const metadataFailure = (code, message, fatal = false) => Object.assign(new Error(message), { code, fatal })

const readLimitedText = async response => {
    const contentLength = Number(response.headers.get('Content-Length'))
    if (Number.isSafeInteger(contentLength) && contentLength > metadataBodyLimit)
        throw metadataFailure('metadata_too_large', 'The remote page is too large to process', true)
    if (!response.body?.getReader) return (await response.text()).slice(0, metadataBodyLimit)

    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
        let chunk
        do {
            chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > metadataBodyLimit) {
                await reader.cancel()
                throw metadataFailure('metadata_too_large', 'The remote page is too large to process', true)
            }
            chunks.push(chunk.value)
        } while (!chunk.done)
    } finally {
        reader.releaseLock?.()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

const readLimitedStream = async (stream, limit) => {
    if (!stream?.getReader) return new Uint8Array(0)
    const reader = stream.getReader()
    const chunks = []
    let size = 0
    try {
        let chunk
        do {
            chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > limit) {
                await reader.cancel()
                throw metadataFailure('content_too_large', 'The content exceeds the size limit', true)
            }
            chunks.push(chunk.value)
        } while (!chunk.done)
    } finally {
        reader.releaseLock?.()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
}

const readUpload = async (request, maxBytes) => {
    const contentType = String(request.headers.get('Content-Type') || '').toLowerCase()
    if (contentType.includes('multipart/form-data')) {
        const declaredSize = Number(request.headers.get('Content-Length'))
        if (Number.isSafeInteger(declaredSize) && declaredSize > maxBytes + multipartOverhead)
            return { error: 'content_too_large' }
        let form
        try {
            const body = await readLimitedStream(request.body, maxBytes + multipartOverhead)
            form = await new Response(body, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } }).formData()
        } catch (failure) {
            if (failure?.code === 'content_too_large') return { error: 'content_too_large' }
            return { error: 'invalid_upload' }
        }
        let file = null
        for (const value of form.values()) {
            if (value && typeof value.arrayBuffer === 'function' && Number.isSafeInteger(Number(value.size))) {
                file = value
                break
            }
        }
        if (!file) return { error: 'missing_file' }
        const size = Number(file.size)
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
            return { error: 'content_too_large' }
        const fields = {}
        for (const [key, value] of form.entries())
            if (value !== file) fields[key] = String(value)
        return {
            body: file,
            size,
            filename: file.name || fields.filename || 'upload',
            contentType: file.type || fields.contentType || 'application/octet-stream',
            fields
        }
    }

    const contentLengthHeader = request.headers.get('Content-Length')
    const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader)
    if (Number.isSafeInteger(contentLength) && contentLength > maxBytes)
        return { error: 'content_too_large' }
    if (request.body) {
        let body
        try {
            body = await readLimitedStream(request.body, maxBytes)
        } catch (failure) {
            return { error: failure?.code === 'content_too_large' ? 'content_too_large' : 'invalid_upload' }
        }
        return { body, size: body.byteLength, filename: request.headers.get('X-Filename') || 'upload', contentType: contentType || 'application/octet-stream', fields: {} }
    }
    return { error: 'missing_file' }
}

const safeFilename = value => String(value || 'upload').split(/[\\/]/).pop().split('').filter(char => char.charCodeAt(0) >= 32).join('').replace(/["']/g, '_').trim().slice(0, 255) || 'upload'

const safeContentType = value => String(value || 'application/octet-stream').split(';')[0].trim().slice(0, 200) || 'application/octet-stream'

const decodeHtml = value => String(value || '')
    .replace(/&#(\d+);/g, (_, code) => Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : '')
    .replace(/&#x([\da-f]+);/gi, (_, code) => parseInt(code, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(code, 16)) : '')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, String.fromCharCode(39))
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/<[^>]+>/g, '').trim()

const htmlAttributes = tag => Object.fromEntries([...tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(match => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '']))

const parsePageMetadata = html => {
    const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => htmlAttributes(match[0]))
    const meta = names => {
        const tag = tags.find(item => names.includes(String(item.name || item.property || '').toLowerCase()))
        return decodeHtml(tag?.content || '')
    }
    const title = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    return {
        ...(title ? { title: title.slice(0, 500) } : {}),
        ...(meta(['description', 'og:description', 'twitter:description']) ? { description: meta(['description', 'og:description', 'twitter:description']).slice(0, 10000) } : {}),
        ...(meta(['og:image', 'twitter:image']) ? { cover: meta(['og:image', 'twitter:image']).slice(0, 2000) } : {}),
        ...(meta(['og:type']) ? { type: meta(['og:type']).slice(0, 100) } : {})
    }
}

const fetchPageMetadata = async (source, env = {}) => {
    let current = validateFetchableUrl(source)
    if (!current.ok) throw metadataFailure(current.code, current.message, true)

    for (let redirect = 0; redirect <= metadataMaxRedirects; redirect++) {
        await resolvePublicAddress(current.url, env)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), metadataFetchTimeoutMs)
        let response
        try {
            response = await fetch(current.url, { redirect: 'manual', signal: controller.signal })
        } catch {
            throw metadataFailure('metadata_fetch_failed', 'The remote page could not be fetched')
        } finally {
            clearTimeout(timer)
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('Location')
            if (!location || redirect === metadataMaxRedirects)
                throw metadataFailure('metadata_redirect_failed', 'The remote page returned too many redirects', true)
            let target
            try {
                target = new URL(location, current.url).toString()
            } catch {
                throw metadataFailure('metadata_redirect_failed', 'The remote page returned an invalid redirect', true)
            }
            const next = validateFetchableUrl(target)
            if (!next.ok) throw metadataFailure('redirect_not_public', 'The remote page redirected to a private address', true)
            current = next
            continue
        }
        if (!response.ok) throw metadataFailure('metadata_upstream_error', 'The remote page returned an error')

        const contentType = String(response.headers.get('Content-Type') || '').toLowerCase()
        if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml'))
            return {}
        return parsePageMetadata(await readLimitedText(response))
    }
    throw metadataFailure('metadata_redirect_failed', 'The remote page returned too many redirects', true)
}

const taskDate = value => value ? new Date(Number(value)).toISOString() : null

const parseTaskMetadata = value => {
    try {
        const metadata = JSON.parse(value || '{}')
        return metadata && typeof metadata === 'object' ? metadata : {}
    } catch {
        return {}
    }
}

const publicTask = task => {
    const payload = parseTaskMetadata(task.payload)
    return {
        id: String(task.id),
        taskId: String(task.id),
        type: task.type,
        ...(task.bookmark_id === null || task.bookmark_id === undefined ? {} : { bookmarkId: Number(task.bookmark_id) }),
        ...(task.content_id ? { contentId: String(task.content_id) } : {}),
        ...(payload.archiveId ? { archiveId: String(payload.archiveId) } : {}),
        status: task.status,
        progress: Number(task.progress || 0),
        retryCount: Number(task.retry_count || 0),
        attempts: task.status === 'queued' ? 0 : Number(task.retry_count || 0) + 1,
        metadata: parseTaskMetadata(task.result_metadata),
        failure: task.error_code ? { code: task.error_code, message: task.error_message } : null,
        createdAt: taskDate(task.created_at),
        updatedAt: taskDate(task.updated_at),
        nextRetryAt: taskDate(task.next_retry_at),
        completedAt: taskDate(task.completed_at)
    }
}

const publicContent = content => ({
    id: String(content.id),
    contentId: String(content.id),
    bookmarkId: Number(content.bookmark_id),
    kind: content.kind,
    status: content.status,
    filename: content.filename || 'upload',
    contentType: content.content_type || 'application/octet-stream',
    size: Number(content.size_bytes || 0),
    createdAt: taskDate(content.created_at),
    updatedAt: taskDate(content.updated_at),
    clearedAt: taskDate(content.cleared_at)
})

const selectContent = async (env, contentId, userId = null) => {
    const where = userId === null ? 'id = ?' : 'id = ? AND user_id = ?'
    const values = userId === null ? [contentId] : [contentId, userId]
    return env.DB.prepare(`SELECT id, user_id, bookmark_id, kind, status, object_key,
        filename, content_type, size_bytes, created_at, updated_at, cleared_at, migration_key
        FROM content_objects WHERE ${where}`).bind(...values).first()
}

const listContent = async (env, bookmarkId, userId) => {
    const rows = await env.DB.prepare(`SELECT id, user_id, bookmark_id, kind, status, object_key,
        filename, content_type, size_bytes, created_at, updated_at, cleared_at
        FROM content_objects WHERE bookmark_id = ? ORDER BY created_at DESC`).bind(bookmarkId).all()
    const visible = []
    for (const item of rows.results || [])
        if (await contentAuthorized(env, item, userId)) visible.push(publicContent(item))
    return visible
}

const bookmarkAccessible = async (env, bookmarkId, userId) => {
    const owned = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
        .bind(bookmarkId, userId).first()
    if (owned) return owned
    try {
        const shared = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ?').bind(bookmarkId).first()
        return shared && await collectionRole(env, userId, shared.collection_id) ? shared : null
    } catch {
        return null
    }
}

const contentAuthorized = async (env, content, userId) => {
    if (!content || Number(content.user_id) === Number(userId)) return Boolean(content)
    try {
        const bookmark = await env.DB.prepare('SELECT collection_id FROM bookmarks WHERE id = ? AND user_id = ?')
            .bind(content.bookmark_id, content.user_id).first()
        return Boolean(bookmark && await collectionRole(env, userId, bookmark.collection_id))
    } catch {
        return false
    }
}

const selectTask = async (env, taskId, userId = null) => {
    const where = userId === null ? 'id = ?' : 'id = ? AND user_id = ?'
    const values = userId === null ? [taskId] : [taskId, userId]
    return await env.DB.prepare(`SELECT id, user_id, bookmark_id, type, status, progress, retry_count,
        idempotency_key, source_url, content_id, payload, result_metadata, error_code, error_message, next_retry_at, created_at, updated_at, completed_at
        FROM background_tasks WHERE ${where}`).bind(...values).first()
}

const taskPayload = task => ({ taskId: String(task.id), type: task.type })

const enqueueTask = async (env, task) => {
    if (!env.TASK_QUEUE?.send) return true
    try {
        await env.TASK_QUEUE.send(taskPayload(task))
        return true
    } catch {
        try {
            await env.DB.prepare(`UPDATE background_tasks SET status = 'dead_letter', progress = 0,
                error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`).bind(
                'task_enqueue_failed', 'Background task could not be queued', Date.now(), Date.now(), task.id).run()
        } catch {}
        return false
    }
}

const createMetadataTask = async (env, request, userId, bookmarkId, sourceUrl) => {
    try {
        const idempotencyKey = 'metadata:' + bookmarkId + ':' + await hmac(sourceUrl, env.SESSION_SECRET || 'task-key')
        const now = Date.now()
        const id = randomToken(18)
        const inserted = await env.DB.prepare(`INSERT INTO background_tasks
            (id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key, source_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO NOTHING`).bind(
            id, userId, bookmarkId, metadataTaskType, idempotencyKey, sourceUrl, now, now).run()
        let task = await selectTask(env, id, userId)
        if (!task)
            task = await env.DB.prepare('SELECT id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key, source_url, content_id, payload, result_metadata, error_code, error_message, next_retry_at, created_at, updated_at, completed_at FROM background_tasks WHERE idempotency_key = ? AND user_id = ?').bind(idempotencyKey, userId).first()
        if (!task) return null

        if (Number(inserted?.meta?.changes || 0) === 1) {
            await enqueueTask(env, task)
            task = await selectTask(env, task.id, userId) || task
            if (request) await recordAudit(env, request, { userId, action: 'task.created', resourceType: 'background_task', resourceId: task.id, outcome: 'success' })
        }
        return task
    } catch {
        return null
    }
}

const createContentTask = async (env, request, { userId, bookmarkId, type, contentId, sourceUrl, payload = {} }) => {
    try {
        const idempotencyKey = type + ':' + contentId
        const now = Date.now()
        const id = randomToken(18)
        const inserted = await env.DB.prepare(`INSERT INTO background_tasks
            (id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key,
             source_url, content_id, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO NOTHING`).bind(
            id, userId, bookmarkId, type, idempotencyKey, sourceUrl, contentId,
            JSON.stringify(payload), now, now).run()
        let task = await selectTask(env, id, userId)
        if (!task)
            task = await env.DB.prepare(`SELECT id, user_id, bookmark_id, type, status, progress, retry_count,
                idempotency_key, source_url, content_id, payload, result_metadata, error_code, error_message,
                next_retry_at, created_at, updated_at, completed_at
                FROM background_tasks WHERE idempotency_key = ? AND user_id = ?`).bind(idempotencyKey, userId).first()
        if (!task) return null

        if (Number(inserted?.meta?.changes || 0) === 1) {
            await enqueueTask(env, task)
            task = await selectTask(env, task.id, userId) || task
            if (request) await recordAudit(env, request, { userId, action: 'task.created', resourceType: 'background_task', resourceId: task.id, outcome: 'success' })
        }
        return task
    } catch {
        return null
    }
}

const putContentObject = async (env, content, body, metadata = {}) => {
    if (!env.CONTENT_BUCKET?.put) throw metadataFailure('content_storage_unavailable', 'Content storage is not configured', true)
    await env.CONTENT_BUCKET.put(content.object_key, body, {
        httpMetadata: {
            contentType: metadata.contentType || content.content_type,
            contentDisposition: 'attachment; filename="' + safeFilename(metadata.filename || content.filename) + '"'
        },
        customMetadata: {
            contentId: String(content.id),
            bookmarkId: String(content.bookmark_id),
            status: content.status
        }
    })
}

const scanStoredContent = async (env, content) => {
    const scannerUrl = String(env.SCANNER_URL || '').trim()
    const scannerKey = String(env.SCANNER_API_KEY || '').trim()
    if (!scannerUrl || !scannerKey)
        throw metadataFailure('scanner_not_configured', 'Content safety scanning is not configured', true)
    try {
        const endpoint = new URL(scannerUrl)
        const localScanner = env.ENVIRONMENT === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        if (endpoint.protocol !== 'https:' && !localScanner)
            throw new Error('scanner must use HTTPS')
    } catch {
        throw metadataFailure('scanner_not_configured', 'Content safety scanning is not configured', true)
    }
    if (!env.CONTENT_BUCKET?.get)
        throw metadataFailure('content_storage_unavailable', 'Content storage is not configured', true)

    const object = await env.CONTENT_BUCKET.get(content.object_key)
    if (!object) throw metadataFailure('content_missing', 'Protected content is no longer available', true)
    let response
    try {
        response = await fetch(scannerUrl, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + scannerKey,
                'Content-Type': content.content_type || 'application/octet-stream',
                'X-Content-ID': String(content.id)
            },
            body: object.body
        })
    } catch {
        throw metadataFailure('scanner_unavailable', 'Content safety scanning is temporarily unavailable')
    }
    if (!response.ok) throw metadataFailure('scanner_unavailable', 'Content safety scanning is temporarily unavailable')

    let result
    try {
        result = await response.json()
    } catch {
        throw metadataFailure('scanner_invalid_response', 'Content safety scanning returned an invalid result', true)
    }
    const status = String(result?.status || result?.result || '').toLowerCase()
    const clean = result?.clean === true || ['clean', 'approved', 'cleared', 'ok', 'safe'].includes(status)
    const unsafe = result?.clean === false || ['malicious', 'blocked', 'quarantined', 'unsafe', 'infected'].includes(status)
    if (!clean && !unsafe)
        throw metadataFailure('scanner_invalid_response', 'Content safety scanning returned an invalid result', true)
    if (unsafe)
        throw metadataFailure('content_quarantined', 'Protected content did not pass the safety check', true)
    const now = Date.now()
    await env.DB.prepare(`UPDATE content_objects SET status = 'cleared', updated_at = ?, cleared_at = ?
        WHERE id = ? AND status = 'quarantined'`).bind(now, now, content.id).run()
    return { status: 'cleared' }
}

const captureResponse = async (source, env, kind = 'snapshot') => {
    let current = validateFetchableUrl(source)
    if (!current.ok) throw metadataFailure(current.code, current.message, true)

    for (let redirect = 0; redirect <= metadataMaxRedirects; redirect++) {
        await resolvePublicAddress(current.url, env)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), metadataFetchTimeoutMs)
        let response
        try {
            const renderer = env.BROWSER_RENDERING || env.BROWSER
            if (!renderer?.quickAction && !renderer?.fetch)
                throw metadataFailure('capture_renderer_unavailable', 'Dynamic Capture is not configured', true)
            if (renderer?.quickAction) {
                const host = current.url.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                // ponytail: exact-host allowlist blocks cross-host redirects; request interception if broader navigation is required.
                response = await renderer.quickAction(kind === 'screenshot' ? 'screenshot' : 'content', {
                    url: current.url.toString(),
                    allowRequestPattern: ['/^' + current.url.protocol + '\\/\\/' + host + '(?:\\/|$)/'],
                    gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 }
                })
                if (!response?.ok)
                    throw metadataFailure('capture_fetch_failed', 'The linked page could not be captured')
                if (kind !== 'screenshot') {
                    let rendered
                    try { rendered = await response.json() } catch { rendered = null }
                    if (!rendered?.success || typeof rendered.result !== 'string')
                        throw metadataFailure('capture_render_failed', 'Dynamic Capture returned an invalid result', true)
                    const body = encoder.encode(rendered.result)
                    if (body.byteLength > captureBodyLimit)
                        throw metadataFailure('capture_too_large', 'The captured page is too large to store', true)
                    return { body, contentType: 'text/html', size: body.byteLength, url: current.url.toString() }
                }
            } else response = await renderer.fetch(current.url.toString(), { headers: { Accept: 'text/html,image/*' }, signal: controller.signal, redirect: 'manual' })
        } catch (failure) {
            if (failure?.code) throw failure
            throw metadataFailure('capture_fetch_failed', 'The linked page could not be captured')
        } finally {
            clearTimeout(timer)
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('Location')
            if (!location || redirect === metadataMaxRedirects)
                throw metadataFailure('capture_redirect_failed', 'The linked page returned too many redirects', true)
            let target
            try {
                target = new URL(location, current.url).toString()
            } catch {
                throw metadataFailure('capture_redirect_failed', 'The linked page returned an invalid redirect', true)
            }
            const next = validateFetchableUrl(target)
            if (!next.ok) throw metadataFailure('redirect_not_public', 'The remote page redirected to a private address', true)
            current = next
            continue
        }
        if (!response.ok) throw metadataFailure('capture_upstream_error', 'The linked page returned an error')
        let body
        try {
            body = await readLimitedStream(response.body, captureBodyLimit)
        } catch (failure) {
            if (failure?.code === 'content_too_large')
                throw metadataFailure('capture_too_large', 'The captured page is too large to store', true)
            throw failure
        }
        return {
            body,
            contentType: safeContentType(response.headers.get('Content-Type')),
            size: body.byteLength,
            url: current.url.toString()
        }
    }
    throw metadataFailure('capture_redirect_failed', 'The linked page returned too many redirects', true)
}

const taskFailureDetails = failure => {
    const messages = {
        metadata_fetch_failed: 'The remote page could not be fetched',
        metadata_upstream_error: 'The remote page returned an error',
        metadata_redirect_failed: 'The remote page returned too many redirects',
        redirect_not_public: 'The remote page redirected to a private address',
        metadata_too_large: 'The remote page is too large to process',
        metadata_dns_failed: 'The remote address could not be resolved',
        url_not_public: 'The remote address is not public',
        scanner_not_configured: 'Content safety scanning is not configured',
        scanner_unavailable: 'Content safety scanning is temporarily unavailable',
        scanner_invalid_response: 'Content safety scanning returned an invalid result',
        scanner_config_invalid: 'Content safety scanning is not configured',
        content_missing: 'Protected content is no longer available',
        content_quarantined: 'Protected content did not pass the safety check',
        capture_fetch_failed: 'The linked page could not be captured',
        capture_renderer_unavailable: 'Dynamic Capture is not configured',
        capture_upstream_error: 'The linked page returned an error',
        capture_redirect_failed: 'The linked page returned too many redirects',
        capture_too_large: 'The captured page is too large to store',
        content_storage_unavailable: 'Content storage is not configured',
        content_too_large: 'The content exceeds the size limit',
        migration_too_large: 'The migration archive is too large',
        migration_empty: 'The migration archive has no Collections or Bookmarks',
        migration_invalid: 'The migration archive contains invalid data',
        migration_archive_missing: 'The migration archive is no longer available',
        migration_write_failed: 'The migration could not be written',
        migration_duplicate_target_missing: 'The duplicate target is no longer available',
        duplicate_review_required: 'Duplicate review is incomplete'
    }
    const code = messages[failure?.code] ? failure.code : 'metadata_failed'
    return { code, message: messages[code] || 'Metadata enrichment failed' }
}

const taskRequest = (env, taskId) => {
    try {
        return new Request(new URL('/v1/tasks/' + encodeURIComponent(taskId), env.API_ORIGIN || 'https://worker.invalid'))
    } catch {
        return new Request('https://worker.invalid/v1/tasks/' + encodeURIComponent(taskId))
    }
}

const markTaskFailure = async (env, task, failure) => {
    const now = Date.now()
    const details = taskFailureDetails(failure)
    const retryCount = Number(task.retry_count || 0) + 1
    if (!failure?.fatal && retryCount <= metadataMaxRetries) {
        const delaySeconds = metadataRetryDelays[retryCount - 1]
        await env.DB.prepare(`UPDATE background_tasks SET status = 'retrying', progress = 10,
            retry_count = ?, error_code = ?, error_message = ?, next_retry_at = ?, updated_at = ?
            WHERE id = ? AND status = 'processing'`).bind(
            retryCount, details.code, details.message, now + delaySeconds * 1000, now, task.id).run()
        return { action: 'retry', delaySeconds }
    }

    const finalRetryCount = failure?.fatal ? Number(task.retry_count || 0) : Math.min(metadataMaxRetries, retryCount)
    await env.DB.prepare(`UPDATE background_tasks SET status = 'dead_letter', progress = 0,
        retry_count = ?, error_code = ?, error_message = ?, next_retry_at = NULL,
        updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`).bind(
        finalRetryCount, details.code, details.message, now, now, task.id).run()
    await recordAlert(env, taskRequest(env, task.id), {
        userId: task.user_id,
        kind: task.type + '_failed',
        metadata: { taskId: task.id, code: details.code, retryCount: finalRetryCount }
    })
    return { action: 'dead_letter', failure: details }
}

const claimTask = async (env, taskId) => {
    const task = await selectTask(env, taskId)
    if (!task || !backgroundTaskTypes.has(task.type)) return { action: 'skip' }
    if (['succeeded', 'dead_letter'].includes(task.status)) return { action: 'skip' }
    const now = Date.now()
    if (task.status === 'retrying' && task.next_retry_at > now)
        return { action: 'defer', delaySeconds: Math.max(1, Math.ceil((task.next_retry_at - now) / 1000)) }
    const staleProcessing = task.status === 'processing' && Number(task.updated_at || 0) <= now - metadataLeaseMs
    if (task.status === 'processing' && !staleProcessing) return { action: 'skip' }
    const claimed = await env.DB.prepare(`UPDATE background_tasks SET status = 'processing', progress = 10,
        next_retry_at = NULL, updated_at = ? WHERE id = ? AND
        ((status IN ('queued', 'retrying') AND (next_retry_at IS NULL OR next_retry_at <= ?)) OR
        (status = 'processing' AND updated_at <= ?))`).bind(now, taskId, now, now - metadataLeaseMs).run()
    if (Number(claimed?.meta?.changes || 0) !== 1) return { action: 'skip' }
    return { action: 'process', task }
}

const processMetadataTask = async (env, taskId) => {
    const claimed = await claimTask(env, taskId)
    if (claimed.action !== 'process') return claimed

    try {
        const metadata = await fetchPageMetadata(claimed.task.source_url, env)
        const bookmark = await env.DB.prepare('SELECT id, url, title, description FROM bookmarks WHERE id = ? AND user_id = ? AND removed_at IS NULL AND url = ?')
            .bind(claimed.task.bookmark_id, claimed.task.user_id, claimed.task.source_url).first()
        if (bookmark && (metadata.title && !bookmark.title || metadata.description && !bookmark.description)) {
            await env.DB.prepare(`UPDATE bookmarks SET
                title = CASE WHEN title = '' THEN ? ELSE title END,
                description = CASE WHEN description = '' THEN ? ELSE description END,
                updated_at = ? WHERE id = ? AND user_id = ? AND removed_at IS NULL`).bind(
                metadata.title || '', metadata.description || '', Date.now(), claimed.task.bookmark_id, claimed.task.user_id).run()
        }
        const now = Date.now()
        await env.DB.prepare(`UPDATE background_tasks SET status = 'succeeded', progress = 100,
            result_metadata = ?, error_code = NULL, error_message = NULL, next_retry_at = NULL,
            updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`).bind(
            JSON.stringify(metadata), now, now, taskId).run()
        return { action: 'ack' }
    } catch (failure) {
        return markTaskFailure(env, claimed.task, failure)
    }
}

const parseTaskKind = task => {
    try {
        const payload = JSON.parse(task.payload || '{}')
        return ['snapshot', 'screenshot'].includes(payload.kind) ? payload.kind : 'snapshot'
    } catch {
        return 'snapshot'
    }
}

const processAttachmentScanTask = async (env, taskId) => {
    const claimed = await claimTask(env, taskId)
    if (claimed.action !== 'process') return claimed

    try {
        const content = await selectContent(env, claimed.task.content_id)
        if (!content) throw metadataFailure('content_missing', 'Protected content is no longer available', true)
        if (!attachmentScanEnabled(env)) {
            const now = Date.now()
            await env.DB.prepare(`UPDATE content_objects SET status = 'cleared', updated_at = ?, cleared_at = ?
                WHERE id = ? AND status = 'quarantined'`).bind(now, now, content.id).run()
            await env.DB.prepare(`UPDATE background_tasks SET status = 'succeeded', progress = 100,
                result_metadata = ?, error_code = NULL, error_message = NULL, next_retry_at = NULL,
                updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`).bind(
                JSON.stringify({ contentId: content.id, status: 'cleared', scanned: false }), now, now, taskId).run()
            return { action: 'ack' }
        }
        const result = await scanStoredContent(env, content)
        const now = Date.now()
        await env.DB.prepare(`UPDATE background_tasks SET status = 'succeeded', progress = 100,
            result_metadata = ?, error_code = NULL, error_message = NULL, next_retry_at = NULL,
            updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`).bind(
            JSON.stringify({ contentId: content.id, ...result }), now, now, taskId).run()
        return { action: 'ack' }
    } catch (failure) {
        return markTaskFailure(env, claimed.task, failure)
    }
}

const processCaptureTask = async (env, taskId) => {
    const claimed = await claimTask(env, taskId)
    if (claimed.action !== 'process') return claimed

    try {
        const content = await selectContent(env, claimed.task.content_id)
        if (!content) throw metadataFailure('content_missing', 'Protected content is no longer available', true)
        const captured = await captureResponse(claimed.task.source_url, env, parseTaskKind(claimed.task))
        await putContentObject(env, content, captured.body, {
            contentType: captured.contentType,
            filename: content.filename
        })
        const now = Date.now()
        await env.DB.prepare(`UPDATE content_objects SET content_type = ?, size_bytes = ?, updated_at = ?
            WHERE id = ? AND status = 'quarantined'`).bind(captured.contentType, captured.size, now, content.id).run()
        const updated = await selectContent(env, content.id)
        const scan = await scanStoredContent(env, updated || { ...content, content_type: captured.contentType })
        await env.DB.prepare(`UPDATE background_tasks SET status = 'succeeded', progress = 100,
            result_metadata = ?, error_code = NULL, error_message = NULL, next_retry_at = NULL,
            updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`).bind(
            JSON.stringify({ contentId: content.id, url: captured.url, size: captured.size, ...scan }), now, now, taskId).run()
        return { action: 'ack' }
    } catch (failure) {
        return markTaskFailure(env, claimed.task, failure)
    }
}

const processTask = async (env, taskId, type) => {
    if (type === metadataTaskType) return processMetadataTask(env, taskId)
    if (type === attachmentTaskType) return processAttachmentScanTask(env, taskId)
    if (type === captureTaskType) return processCaptureTask(env, taskId)
    if (type === migrationTaskType) return processMigrationTask(env, taskId)
    if (type === backupTaskType) return processBackupTask(env, taskId)
    return { action: 'skip' }
}

const readR2Object = async object => {
    if (!object) return null
    if (object.arrayBuffer) return new Uint8Array(await object.arrayBuffer())
    if (object.body) return new Uint8Array(await new Response(object.body).arrayBuffer())
    return null
}

const exportBookmark = item => ({
    _id: Number(item.id ?? item._id),
    id: Number(item.id ?? item._id),
    link: String(item.link ?? item.url ?? ''),
    title: String(item.title || ''),
    description: String(item.description ?? item.excerpt ?? ''),
    excerpt: String(item.description ?? item.excerpt ?? ''),
    note: String(item.note || ''),
    cover: String(item.cover || ''),
    collectionId: Number(item.collectionId ?? item.collection_id ?? -1),
    tags: bookmarkTags(item.tags),
    highlights: bookmarkHighlights(item.highlights),
    created: item.created || taskDate(item.created_at),
    lastUpdate: item.lastUpdate || taskDate(item.updated_at)
})

const exportCollection = item => ({
    _id: Number(item.id ?? item._id),
    id: Number(item.id ?? item._id),
    title: String(item.title || ''),
    parentId: item.parentId ?? item.parent_id ?? null,
    slug: String(item.slug || ''),
    created: item.created || taskDate(item.created_at),
    lastUpdate: item.lastUpdate || taskDate(item.updated_at)
})

const exportIds = url => {
    const raw = url.searchParams.get('ids')
    if (raw === null) return null
    const values = String(raw).split(',')
        .map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
    return new Set(values)
}

const exportSearchMatch = (item, search) => {
    if (!search) return true
    const value = search.toLowerCase()
    return [item.url, item.link, item.title, item.description, item.excerpt, item.note, item.tags, item.highlights]
        .some(field => String(field || '').toLowerCase().includes(value))
}

const exportData = async (env, userId, { spaceId = 0, url = null, includeContent = false } = {}) => {
    const requestedIds = url ? exportIds(url) : null
    const search = url ? String(url.searchParams.get('search') || '').replace(/^"|"$/g, '').trim() : ''
    const targetCollection = Number(spaceId)
    const rows = (await env.DB.prepare(`WITH RECURSIVE accessible(id) AS (
            SELECT c.id FROM collections c
            LEFT JOIN collection_collaborators cc ON cc.collection_id = c.id AND cc.user_id = ?
            WHERE c.removed_at IS NULL AND (c.user_id = ? OR cc.user_id IS NOT NULL)
            UNION
            SELECT c.id FROM collections c JOIN accessible parent ON c.parent_id = parent.id
            WHERE c.removed_at IS NULL
        )
        SELECT b.* FROM bookmarks b WHERE b.removed_at IS NULL
        AND (b.user_id = ? OR b.collection_id IN (SELECT id FROM accessible))
        ORDER BY b.updated_at DESC`).bind(userId, userId, userId).all()).results || []

    const bookmarks = []
    for (const row of rows) {
        const id = Number(row.id)
        const collectionId = Number(row.collection_id)
        if (targetCollection > 0 && collectionId !== targetCollection ||
            targetCollection === -1 && collectionId !== -1 || requestedIds && !requestedIds.has(id) ||
            !exportSearchMatch(row, search)) continue
        bookmarks.push(row)
    }

    const collections = []
    const result = await env.DB.prepare(`WITH RECURSIVE accessible(id) AS (
            SELECT c.id FROM collections c
            LEFT JOIN collection_collaborators cc ON cc.collection_id = c.id AND cc.user_id = ?
            WHERE c.removed_at IS NULL AND (c.user_id = ? OR cc.user_id IS NOT NULL)
            UNION
            SELECT c.id FROM collections c JOIN accessible parent ON c.parent_id = parent.id
            WHERE c.removed_at IS NULL
        )
        SELECT c.* FROM collections c JOIN accessible ON accessible.id = c.id ORDER BY c.id`)
        .bind(userId, userId).all()
    const bookmarkCollections = new Set(bookmarks.map(item => Number(item.collection_id)).filter(id => id > 0))
    for (const row of result.results || []) {
        const id = Number(row.id)
        if (targetCollection > 0 && id !== targetCollection || targetCollection === -1 ||
            targetCollection === 0 && !bookmarkCollections.has(id) && Number(row.user_id) !== Number(userId)) continue
        collections.push(row)
    }

    const contents = []
    if (includeContent && bookmarks.length) {
        let result
        try {
            const placeholders = bookmarks.map(() => '?').join(',')
            result = await env.DB.prepare(`SELECT id, user_id, bookmark_id, kind, status, object_key,
                filename, content_type, size_bytes, created_at, updated_at, cleared_at
                FROM content_objects WHERE bookmark_id IN (${placeholders}) AND status = 'cleared' ORDER BY created_at`)
                .bind(...bookmarks.map(bookmark => bookmark.id)).all()
        } catch { throw new Error('Export content could not be read') }
        const bookmarkOwners = new Map(bookmarks.map(bookmark => [Number(bookmark.id), Number(bookmark.user_id)]))
        const maxBytes = integerEnv(env, ['BACKUP_MAX_BYTES'], backupMaxBytes)
        const declaredBytes = (result.results || []).reduce((total, content) => total + Number(content.size_bytes || 0), 0)
        if (declaredBytes > maxBytes)
            throw Object.assign(new Error('Export content exceeds the archive limit'), { code: 'export_too_large', status: 413 })
        for (const content of result.results || []) {
            if (content.status !== 'cleared' || Number(content.user_id) !== bookmarkOwners.get(Number(content.bookmark_id))) continue
            let bytes
            if (!env.CONTENT_BUCKET?.get) throw new Error('Export content storage is unavailable')
            try { bytes = await readR2Object(await env.CONTENT_BUCKET.get(content.object_key)) } catch { throw new Error('Export content could not be read') }
            if (!bytes) continue
            contents.push({
                id: String(content.id),
                bookmarkId: Number(content.bookmark_id),
                kind: content.kind,
                filename: safeFilename(content.filename),
                contentType: safeContentType(content.content_type),
                size: Number(content.size_bytes || bytes.byteLength),
                data: bytesToBase64(bytes)
            })
        }
    }

    return {
        collections: collections.map(exportCollection),
        bookmarks: bookmarks.map(exportBookmark),
        contents
    }
}

const htmlEscape = value => String(value || '').replace(/[&<>"']/g, char =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;')

const csvValue = value => '"' + String(value ?? '').replace(/"/g, '""') + '"'

const exportBody = (format, data) => {
    const bookmarks = (data.bookmarks || []).map(exportBookmark)
    const collections = (data.collections || []).map(exportCollection)
    const collectionNames = new Map(collections.map(item => [item.id, item.title]))

    if (format === 'html') return '<!doctype html><meta charset="utf-8"><title>Raindrop export</title><ul>' +
        bookmarks.map(item => '<li><a href="' + htmlEscape(item.link) + '">' +
            htmlEscape(item.title || item.link) + '</a>' +
            (item.description ? '<p>' + htmlEscape(item.description) + '</p>' : '') +
            (item.note ? '<p>' + htmlEscape(item.note) + '</p>' : '') + '</li>').join('') + '</ul>'

    if (format === 'csv') return [
        'title,url,description,note,collection,tags,highlights,created,lastUpdate',
        ...bookmarks.map(item => [item.title, item.link, item.description, item.note,
            collectionNames.get(item.collectionId) || '', item.tags.join(', '),
            bookmarkHighlights(item.highlights).map(highlight => highlight.text).join('\n'),
            item.created, item.lastUpdate].map(csvValue).join(','))
    ].join('\n')

    return bookmarks.map(item => [
        item.title,
        item.link,
        item.description,
        item.note,
        item.tags.join(', '),
        bookmarkHighlights(item.highlights).map(highlight => highlight.text + (highlight.note ? '\n' + highlight.note : '')).join('\n\n')
    ].filter(Boolean).join('\n')).join('\n\n')
}

const concatBytes = chunks => {
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
    }
    return result
}

const numberBytes = (value, size) => {
    const result = new Uint8Array(size)
    let number = Number(value) >>> 0
    for (let index = 0; index < size; index++) {
        result[index] = number & 255
        number >>>= 8
    }
    return result
}

const crc32 = bytes => {
    let crc = 0xffffffff
    for (const byte of bytes) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1
    }
    return (crc ^ 0xffffffff) >>> 0
}

// ponytail: store-only ZIP keeps the Worker dependency-free; add deflate when archive size requires compression.
const zipArchive = entries => {
    const local = []
    const central = []
    let offset = 0
    for (const entry of entries) {
        const name = encoder.encode(entry.name)
        const body = entry.body instanceof Uint8Array ? entry.body : encoder.encode(String(entry.body || ''))
        const checksum = crc32(body)
        const header = concatBytes([
            numberBytes(0x04034b50, 4), numberBytes(20, 2), numberBytes(0x800, 2), numberBytes(0, 2),
            numberBytes(0, 2), numberBytes(0, 2), numberBytes(checksum, 4), numberBytes(body.length, 4),
            numberBytes(body.length, 4), numberBytes(name.length, 2), numberBytes(0, 2), name
        ])
        local.push(header, body)
        central.push(concatBytes([
            numberBytes(0x02014b50, 4), numberBytes(20, 2), numberBytes(20, 2), numberBytes(0x800, 2),
            numberBytes(0, 2), numberBytes(0, 2), numberBytes(0, 2), numberBytes(checksum, 4),
            numberBytes(body.length, 4), numberBytes(body.length, 4), numberBytes(name.length, 2),
            numberBytes(0, 2), numberBytes(0, 2), numberBytes(0, 2), numberBytes(0, 2), numberBytes(offset, 4), name
        ]))
        offset += header.length + body.length
    }
    const centralBytes = concatBytes(central)
    return concatBytes([
        ...local,
        centralBytes,
        concatBytes([
            numberBytes(0x06054b50, 4), numberBytes(0, 2), numberBytes(0, 2), numberBytes(entries.length, 2),
            numberBytes(entries.length, 2), numberBytes(centralBytes.length, 4), numberBytes(offset, 4), numberBytes(0, 2)
        ])
    ])
}

const exportEntries = data => {
    const entries = [
        { name: 'bookmarks.html', body: encoder.encode(exportBody('html', data)) },
        { name: 'bookmarks.csv', body: encoder.encode(exportBody('csv', data)) },
        { name: 'bookmarks.txt', body: encoder.encode(exportBody('txt', data)) },
        { name: 'bookmarks.json', body: encoder.encode(JSON.stringify(data.bookmarks || [], null, 2)) },
        { name: 'collections.json', body: encoder.encode(JSON.stringify(data.collections || [], null, 2)) },
        { name: 'backup.json', body: encoder.encode(JSON.stringify({
            ...data,
            contents: (data.contents || []).map(content => ({
                id: content.id,
                bookmarkId: content.bookmarkId,
                kind: content.kind,
                filename: content.filename,
                contentType: content.contentType,
                size: content.size
            }))
        }, null, 2)) }
    ]
    const names = new Set(entries.map(entry => entry.name))
    for (const content of data.contents || []) {
        let name = 'attachments/' + Number(content.bookmarkId) + '/' + safeFilename(content.filename)
        if (names.has(name)) name = 'attachments/' + Number(content.bookmarkId) + '/' + safeFilename(content.id) + '-' + safeFilename(content.filename)
        names.add(name)
        entries.push({ name, body: base64ToBytes(content.data) })
    }
    return entries
}

const exportResponse = (request, env, format, data, filename = 'raindrop-export') => {
    const isZip = format === 'zip'
    const body = isZip ? zipArchive(exportEntries(data)) : encoder.encode(exportBody(format, data))
    const contentType = isZip ? 'application/zip' : format === 'html' ? 'text/html; charset=utf-8' :
        format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8'
    const headers = addCorsHeaders(new Headers({
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        'Content-Disposition': 'attachment; filename="' + filename + '.' + format + '"',
        'Cache-Control': 'private, no-store',
        'X-Request-ID': requestId(request)
    }), request, env)
    return new Response(body, { status: 200, headers })
}

const backupRetention = (env, kind) => integerEnv(env,
    [kind === 'daily' ? 'BACKUP_RETENTION_DAILY' : 'BACKUP_RETENTION_MONTHLY'],
    kind === 'daily' ? backupDailyRetention : backupMonthlyRetention)

const selectBackup = async (env, id, userId = null) => {
    const where = userId === null ? 'id = ?' : 'id = ? AND user_id = ?'
    const values = userId === null ? [id] : [id, userId]
    return env.DB.prepare(`SELECT id, user_id, kind, period_key, status, object_key, size_bytes,
        error_code, error_message, created_at, updated_at, completed_at FROM backups WHERE ${where}`)
        .bind(...values).first()
}

const publicBackup = backup => ({
    _id: String(backup.id),
    id: String(backup.id),
    type: backup.kind,
    kind: backup.kind,
    status: backup.status,
    created: taskDate(backup.created_at),
    createdAt: taskDate(backup.created_at),
    completed: taskDate(backup.completed_at),
    completedAt: taskDate(backup.completed_at),
    size: Number(backup.size_bytes || 0),
    failure: backup.error_code ? { code: backup.error_code, message: backup.error_message } : null
})

const publicBackupConnection = connection => ({
    id: String(connection.id),
    provider: connection.provider,
    default: Boolean(connection.is_default),
    verifiedAt: taskDate(connection.verified_at)
})

const backupConnectionCredentials = (provider, value = {}) => {
    if (provider === 'gdrive') throw new Error('Connect Google Drive with OAuth')
    if (provider === 'webdav') {
        const url = new URL(String(value.url || ''))
        if (url.protocol !== 'https:' || !value.username || !value.password)
            throw new Error('WebDAV requires an HTTPS URL, username, and app password')
        return { url: url.toString().replace(/\/$/, ''), username: String(value.username), password: String(value.password) }
    }
    if (!value.accessToken) throw new Error('An access token is required')
    return { accessToken: String(value.accessToken) }
}

const backupProviderRequest = (env, provider, credentials, operation, filename, bytes) => {
    if (provider === 'webdav') {
        const target = credentials.url + (operation === 'verify' ? '' : '/' + encodeURIComponent(filename))
        return new Request(target, {
            method: operation === 'verify' ? 'PROPFIND' : 'PUT',
            headers: {
                Authorization: 'Basic ' + btoa(credentials.username + ':' + credentials.password),
                ...(operation === 'verify' ? { Depth: '0' } : { 'Content-Type': 'application/json' })
            },
            body: operation === 'verify' ? undefined : bytes
        })
    }
    const authorization = { Authorization: 'Bearer ' + credentials.accessToken }
    const boundary = 'raindrop-backup-boundary'
    const googleBody = operation === 'verify' ? undefined : concatBytes([
        encoder.encode('--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify({ name: filename }) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n'),
        bytes,
        encoder.encode('\r\n--' + boundary + '--')
    ])
    if (provider === 'gdrive') return new Request(operation === 'verify'
        ? (env.GOOGLE_DRIVE_API_ORIGIN || 'https://www.googleapis.com') + '/drive/v3/about?fields=user'
        : (env.GOOGLE_DRIVE_UPLOAD_ORIGIN || 'https://www.googleapis.com') + '/upload/drive/v3/files?uploadType=multipart', {
        method: operation === 'verify' ? 'GET' : 'POST',
        headers: { ...authorization, ...(operation === 'verify' ? {} : { 'Content-Type': 'multipart/related; boundary=' + boundary }) },
        body: googleBody
    })
    return new Request(operation === 'verify'
        ? (env.ONEDRIVE_API_ORIGIN || 'https://graph.microsoft.com') + '/v1.0/me/drive'
        : (env.ONEDRIVE_API_ORIGIN || 'https://graph.microsoft.com') + '/v1.0/me/drive/root:/' + encodeURIComponent(filename) + ':/content', {
        method: operation === 'verify' ? 'GET' : 'PUT',
        headers: { ...authorization, ...(operation === 'verify' ? {} : { 'Content-Type': 'application/json' }) },
        body: operation === 'verify' ? undefined : bytes
    })
}

const verifyBackupConnection = async (env, provider, credentials) => {
    const response = await fetch(backupProviderRequest(env, provider, credentials, 'verify'))
    if (!response.ok) throw new Error('The backup destination rejected the credentials')
}

const saveBackupConnection = async (env, userId, provider, credentials, makeDefault = false) => {
    const existing = await env.DB.prepare(`SELECT id, is_default FROM backup_connections
        WHERE user_id = ? AND provider = ?`).bind(userId, provider).first()
    const id = existing?.id || randomToken(18)
    const now = Date.now()
    const isDefault = makeDefault || existing?.is_default ? 1 : 0
    if (isDefault) await env.DB.prepare('UPDATE backup_connections SET is_default = 0 WHERE user_id = ?').bind(userId).run()
    await env.DB.prepare(`INSERT INTO backup_connections
        (id, user_id, provider, encrypted_credentials, is_default, verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, provider) DO UPDATE SET encrypted_credentials = excluded.encrypted_credentials,
        is_default = excluded.is_default, verified_at = excluded.verified_at, updated_at = excluded.updated_at`).bind(
            id, userId, provider, await encryptCredentials(env, credentials), isDefault, now, now, now).run()
    return env.DB.prepare(`SELECT id, provider, is_default, verified_at
        FROM backup_connections WHERE user_id = ? AND provider = ?`).bind(userId, provider).first()
}

const refreshGoogleDriveCredentials = async (env, connection, credentials) => {
    if (credentials.accessToken && Number(credentials.expiresAt || 0) > Date.now() + 60000) return credentials
    if (!credentials.refreshToken) throw new Error('Google Drive authorization has expired')
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            refresh_token: credentials.refreshToken,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token'
        })
    })
    if (!response.ok) throw new Error('Google Drive authorization could not be refreshed')
    const token = await response.json()
    const refreshed = {
        accessToken: String(token.access_token || ''),
        refreshToken: credentials.refreshToken,
        expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
    }
    if (!refreshed.accessToken) throw new Error('Google Drive authorization could not be refreshed')
    await env.DB.prepare('UPDATE backup_connections SET encrypted_credentials = ?, updated_at = ? WHERE id = ?')
        .bind(await encryptCredentials(env, refreshed), Date.now(), connection.id).run()
    return refreshed
}

const copyExternalBackup = async (env, backup, bytes) => {
    const connection = await env.DB.prepare(`SELECT id, provider, encrypted_credentials FROM backup_connections
        WHERE user_id = ? AND is_default = 1`).bind(backup.user_id).first()
    if (!connection) return
    const filename = 'raindrop-backup-' + backup.id + '.json'
    const now = Date.now()
    try {
        let credentials = await decryptCredentials(env, connection.encrypted_credentials)
        if (connection.provider === 'gdrive') credentials = await refreshGoogleDriveCredentials(env, connection, credentials)
        const response = await fetch(backupProviderRequest(env, connection.provider, credentials, 'copy', filename, bytes))
        if (!response.ok) throw new Error('External backup copy failed with HTTP ' + response.status)
        await env.DB.prepare(`INSERT INTO external_backup_copies
            (backup_id, connection_id, status, remote_path, error_message, created_at, completed_at)
            VALUES (?, ?, 'succeeded', ?, NULL, ?, ?)
            ON CONFLICT(backup_id, connection_id) DO UPDATE SET status = 'succeeded', remote_path = excluded.remote_path,
            error_message = NULL, completed_at = excluded.completed_at`).bind(backup.id, connection.id, filename, now, now).run()
    } catch (failure) {
        await env.DB.prepare(`INSERT INTO external_backup_copies
            (backup_id, connection_id, status, remote_path, error_message, created_at, completed_at)
            VALUES (?, ?, 'failed', NULL, ?, ?, ?)
            ON CONFLICT(backup_id, connection_id) DO UPDATE SET status = 'failed', error_message = excluded.error_message,
            completed_at = excluded.completed_at`).bind(backup.id, connection.id, failure.message, now, now).run()
        throw failure
    }
}

const enqueueBackup = async (env, backup) => {
    if (!env.TASK_QUEUE?.send) return true
    try {
        await env.TASK_QUEUE.send({ taskId: String(backup.id), type: backupTaskType })
        return true
    } catch {
        const now = Date.now()
        try {
            await env.DB.prepare(`UPDATE backups SET status = 'failed', error_code = ?, error_message = ?,
                updated_at = ?, completed_at = ? WHERE id = ? AND status = 'queued'`).bind(
                'backup_enqueue_failed', 'The backup could not be queued', now, now, backup.id).run()
        } catch {}
        return false
    }
}

const createBackup = async (env, userId, kind = 'manual', periodKey = null, request = null) => {
    const id = randomToken(18)
    const period = periodKey || 'manual:' + id
    const now = Date.now()
    const objectKey = 'backups/' + userId + '/' + id + '.json'
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO backups
        (id, user_id, kind, period_key, status, object_key, size_bytes, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?)`).bind(
        id, userId, kind, period, objectKey, now, now).run()
    let backup = await selectBackup(env, id, userId)
    if (!backup && kind !== 'manual')
        backup = await env.DB.prepare(`SELECT id, user_id, kind, period_key, status, object_key, size_bytes,
            error_code, error_message, created_at, updated_at, completed_at FROM backups
            WHERE user_id = ? AND kind = ? AND period_key = ?`).bind(userId, kind, period).first()
    if (!backup) return null
    if (Number(inserted?.meta?.changes || 0) === 1 || backup.status === 'queued' || backup.status === 'failed') {
        if (backup.status === 'failed') {
            await env.DB.prepare(`UPDATE backups SET status = 'queued', error_code = NULL, error_message = NULL,
                completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`).bind(now, backup.id).run()
            backup = await selectBackup(env, backup.id, userId) || backup
        }
        await enqueueBackup(env, backup)
        backup = await selectBackup(env, backup.id, userId) || backup
        if (request) await recordAudit(env, request, { userId, action: 'backup.created', resourceType: 'backup', resourceId: backup.id, outcome: backup.status === 'failed' ? 'failed' : 'success' })
    }
    return backup
}

const processBackupTask = async (env, backupId) => {
    let backup = await selectBackup(env, backupId)
    if (!backup || backup.status === 'succeeded') return { action: 'skip' }
    const now = Date.now()
    if (backup.status === 'processing') {
        if (now - Number(backup.updated_at || 0) < metadataLeaseMs)
            return { action: 'defer', delaySeconds: Math.ceil(metadataLeaseMs / 1000) }
        await env.DB.prepare(`UPDATE backups SET status = 'queued', updated_at = ?
            WHERE id = ? AND status = 'processing' AND updated_at = ?`).bind(now, backupId, backup.updated_at).run()
        backup = await selectBackup(env, backupId)
    }
    if (backup?.status !== 'queued') return { action: 'skip' }
    const claimed = await env.DB.prepare(`UPDATE backups SET status = 'processing', updated_at = ?
        WHERE id = ? AND status = 'queued'`).bind(now, backupId).run()
    if (Number(claimed?.meta?.changes || 0) !== 1) return { action: 'skip' }

    try {
        if (!env.BACKUP_BUCKET?.put)
            throw metadataFailure('backup_storage_unavailable', 'Backup storage is not configured', true)
        const snapshot = await createExportSnapshot(env, backup.user_id, now)
        const bytes = encoder.encode(JSON.stringify(snapshot))
        await env.BACKUP_BUCKET.put(backup.object_key, bytes, {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { userId: String(backup.user_id), backupId: String(backup.id) }
        })
        await copyExternalBackup(env, backup, bytes)
        const completedAt = Date.now()
        await env.DB.prepare(`UPDATE backups SET status = 'succeeded', size_bytes = ?, error_code = NULL,
            error_message = NULL, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`)
            .bind(bytes.length, completedAt, completedAt, backupId).run()
        return { action: 'ack' }
    } catch (failure) {
        const failedAt = Date.now()
        const code = failure?.code || 'backup_failed'
        const message = failure?.message || 'The backup could not be created'
        await env.DB.prepare(`UPDATE backups SET status = 'queued', error_code = ?, error_message = ?,
            updated_at = ?, completed_at = NULL WHERE id = ? AND status = 'processing'`)
            .bind(code, message, failedAt, backupId).run()
        await recordAlert(env, taskRequest(env, backupId), {
            userId: backup.user_id,
            kind: 'backup_failed',
            metadata: { backupId: String(backupId), code }
        })
        return { action: 'retry', delaySeconds: metadataRetryDelays[0], failure: { code, message } }
    }
}

const createExportSnapshot = async (env, userId, createdAt = Date.now()) => ({
    version: 1,
    createdAt: new Date(createdAt).toISOString(),
    ...(await exportData(env, userId, { includeContent: true }))
})

const readBackupSnapshot = async (env, backup) => {
    if (!env.BACKUP_BUCKET?.get) return null
    const object = await env.BACKUP_BUCKET.get(backup.object_key)
    const bytes = await readR2Object(object)
    if (!bytes) return null
    try {
        const snapshot = JSON.parse(new TextDecoder().decode(bytes))
        return snapshot && typeof snapshot === 'object' ? snapshot : null
    } catch {
        return null
    }
}

const purgeBackups = async (env) => {
    let rows
    try {
        rows = (await env.DB.prepare(`SELECT id, user_id, kind, status, object_key, created_at
            FROM backups WHERE kind IN ('daily', 'monthly') AND status = 'succeeded'
            ORDER BY user_id, kind, created_at DESC`).bind().all()).results || []
    } catch { return }
    const counts = new Map()
    for (const row of rows) {
        const key = row.user_id + ':' + row.kind
        const count = counts.get(key) || 0
        counts.set(key, count + 1)
        if (count < backupRetention(env, row.kind)) continue
        try {
            if (env.BACKUP_BUCKET?.delete) await env.BACKUP_BUCKET.delete(row.object_key)
            await env.DB.prepare('DELETE FROM backups WHERE id = ?').bind(row.id).run()
        } catch {}
    }
}

const scheduleBackups = async (env, scheduledTime = Date.now()) => {
    const numericTime = Number(scheduledTime)
    const now = Number.isFinite(numericTime) ? numericTime : Date.now()
    const date = new Date(now)
    if (Number.isNaN(date.getTime())) return
    const day = date.toISOString().slice(0, 10)
    const month = date.toISOString().slice(0, 7)
    let afterId = 0
    for (;;) {
        let users
        try {
            users = (await env.DB.prepare('SELECT id FROM users WHERE id > ? ORDER BY id LIMIT ?')
                .bind(afterId, backupUserPageSize).all()).results || []
        } catch { return }
        if (!users.length) break
        for (const user of users) {
            try { await createBackup(env, user.id, 'daily', day) } catch {}
            if (date.getUTCDate() === 1)
                try { await createBackup(env, user.id, 'monthly', month) } catch {}
        }
        afterId = Number(users[users.length - 1].id)
        if (users.length < backupUserPageSize) break
    }
    await purgeBackups(env)
}

const createContentRecord = async (env, { userId, bookmarkId, kind, filename, contentType, size, status = 'quarantined', migrationKey = null }) => {
    const id = randomToken(18)
    const objectKey = 'content/' + userId + '/' + id
    const now = Date.now()
    if (migrationKey) {
        await env.DB.prepare(`INSERT INTO content_objects
            (id, user_id, bookmark_id, kind, status, object_key, filename, content_type, size_bytes, created_at, updated_at, cleared_at, migration_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, userId, bookmarkId, kind, status === 'cleared' ? 'cleared' : 'quarantined', objectKey,
                safeFilename(filename), safeContentType(contentType), size, now, now, status === 'cleared' ? now : null, migrationKey).run()
    } else {
        await env.DB.prepare(`INSERT INTO content_objects
            (id, user_id, bookmark_id, kind, status, object_key, filename, content_type, size_bytes, created_at, updated_at, cleared_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, userId, bookmarkId, kind, status === 'cleared' ? 'cleared' : 'quarantined', objectKey,
                safeFilename(filename), safeContentType(contentType), size, now, now, status === 'cleared' ? now : null).run()
    }
    return selectContent(env, id)
}

const removeContentRecord = async (env, content) => {
    if (!content) return
    if (env.CONTENT_BUCKET?.delete && content.object_key)
        await env.CONTENT_BUCKET.delete(content.object_key)
    await env.DB.prepare('DELETE FROM content_objects WHERE id = ?').bind(content.id).run()
}

const discardContentTask = async (env, task) => {
    if (!task?.id || !env.DB?.prepare) return
    try { await env.DB.prepare('DELETE FROM background_tasks WHERE id = ?').bind(task.id).run() } catch {}
}

const deleteContentObjects = async (env, userId, bookmarkIds) => {
    if (!bookmarkIds.length || !env.DB?.prepare) return
    try {
        const placeholders = bookmarkIds.map(() => '?').join(',')
        const rows = await env.DB.prepare(`SELECT object_key FROM content_objects WHERE user_id = ? AND bookmark_id IN (${placeholders})`)
            .bind(userId, ...bookmarkIds).all()
        if (env.CONTENT_BUCKET?.delete)
            for (const row of rows.results || []) await env.CONTENT_BUCKET.delete(row.object_key)
        await env.DB.prepare(`DELETE FROM content_objects WHERE user_id = ? AND bookmark_id IN (${placeholders})`)
            .bind(userId, ...bookmarkIds).run()
    } catch {
        // Content cleanup must not make the Recycle Bin or account lifecycle unavailable.
    }
}

const retryDeadLetterTask = async (env, request, task, userId) => {
    const now = Date.now()
    const updated = await env.DB.prepare(`UPDATE background_tasks SET status = 'queued', progress = 0,
        retry_count = 0, result_metadata = '{}', error_code = NULL, error_message = NULL,
        next_retry_at = NULL, updated_at = ?, completed_at = NULL
        WHERE id = ? AND user_id = ? AND type = ? AND status = 'dead_letter'`).bind(
        now, task.id, userId, task.type).run()
    if (Number(updated?.meta?.changes || 0) !== 1)
        return { task, status: 409 }
    let next = await selectTask(env, task.id, userId)
    if (!next) return { task, status: 404 }
    if (!await enqueueTask(env, next)) next = await selectTask(env, task.id, userId) || next
    await recordAudit(env, request, { userId, action: 'task.retry', resourceType: 'background_task', resourceId: task.id, outcome: 'success' })
    return { task: next, status: 202 }
}

const ensureContentScanTask = async (env, { userId, bookmarkId, contentId, sourceUrl, kind }) => {
    return createContentTask(env, null, {
        userId,
        bookmarkId,
        type: attachmentTaskType,
        contentId,
        sourceUrl,
        payload: { kind }
    })
}

const migrationMaxBytes = env => Math.min(
    migrationDefaultMaxBytes,
    integerEnv(env, ['MIGRATION_MAX_BYTES', 'IMPORT_MAX_BYTES'], migrationDefaultMaxBytes)
)

const readMigrationArchive = async (request, env) => {
    const contentLength = Number(request.headers.get('Content-Length'))
    if (Number.isSafeInteger(contentLength) && contentLength > migrationMaxBytes(env))
        throw metadataFailure('migration_too_large', 'The migration archive is too large', true)
    const { data, form } = await readBody(request)
    let value = data?.archive ?? data?.payload ?? (form && data?.file ? data.file : data)
    if (value && typeof value.text === 'function') value = await value.text()
    if (typeof value === 'string') {
        if (encoder.encode(value).byteLength > migrationMaxBytes(env))
            throw metadataFailure('migration_too_large', 'The migration archive is too large', true)
        try { value = JSON.parse(value) } catch { throw metadataFailure('migration_invalid', 'The migration archive is not valid JSON', true) }
    }
    let encoded
    try { encoded = encoder.encode(JSON.stringify(value ?? {})) } catch { encoded = new Uint8Array(migrationMaxBytes(env) + 1) }
    if (encoded.byteLength > migrationMaxBytes(env))
        throw metadataFailure('migration_too_large', 'The migration archive is too large', true)
    return normalizeMigrationArchive(value)
}

const migrationDuplicateItems = async (env, userId, archive) => {
    const rows = await env.DB.prepare('SELECT id, url, title, collection_id FROM bookmarks WHERE user_id = ? AND removed_at IS NULL')
        .bind(userId).all()
    const existing = new Map()
    for (const row of rows.results || [])
        if (!existing.has(String(row.url))) existing.set(String(row.url), row)

    const seen = new Map()
    const duplicates = []
    for (const item of archive.bookmarks) {
        const prior = seen.get(item.url)
        const match = existing.get(item.url)
        if (match || prior)
            duplicates.push({
                sourceId: item.sourceId,
                sourceType: 'bookmark',
                url: item.url,
                title: item.title,
                existingResourceId: match ? Number(match.id) : null,
                duplicateOfSourceId: prior?.sourceId || null
            })
        if (!prior) seen.set(item.url, item)
    }
    return duplicates
}

const migrationDecision = value => {
    if (value === true || ['keep', 'import', 'create'].includes(String(value || '').toLowerCase())) return 'keep'
    if (value === false || ['skip', 'ignore'].includes(String(value || '').toLowerCase())) return 'skip'
    return null
}

const parseMigrationDecisions = value => {
    try {
        const parsed = JSON.parse(value || '{}')
        return parsed && typeof parsed === 'object' && parsed.decisions && typeof parsed.decisions === 'object'
            ? parsed.decisions
            : {}
    } catch {
        return {}
    }
}

const migrationReviewItems = (archive, decisions) => (archive?.duplicates || []).map(item => ({
    ...item,
    decision: migrationDecision(decisions['bookmark:' + item.sourceId])
}))

const migrationScanTasks = async (env, archiveId, userId) => {
    const rows = await env.DB.prepare(`SELECT id, user_id, bookmark_id, type, status, progress, retry_count,
        idempotency_key, source_url, content_id, payload, result_metadata, error_code, error_message,
        next_retry_at, created_at, updated_at, completed_at
        FROM background_tasks WHERE user_id = ? AND type = 'attachment_scan' AND content_id IN (
            SELECT id FROM content_objects WHERE user_id = ? AND migration_key LIKE ?
        ) ORDER BY created_at`).bind(userId, userId, String(archiveId) + ':content:%').all()
    return rows.results || []
}

const migrationOutput = async (env, row, task = null) => {
    const archive = parseTaskMetadata(row.archive_json)
    const preflight = parseTaskMetadata(row.preflight_json)
    const decisions = parseMigrationDecisions(row.review_json)
    const duplicates = migrationReviewItems(preflight, decisions)
    const scanTasks = (await migrationScanTasks(env, row.id, row.user_id)).map(publicTask)
    const failedScans = scanTasks.filter(item => item.status === 'dead_letter')
    const pendingScans = scanTasks.filter(item => ['queued', 'processing', 'retrying'].includes(item.status))
    return {
        archiveId: String(row.id),
        source: row.source,
        status: row.status,
        counts: {
            collections: Number(row.collection_count || archive.collections?.length || 0),
            bookmarks: Number(row.bookmark_count || archive.bookmarks?.length || 0),
            assets: Number(row.asset_count || archive.assets?.length || 0),
            total: Number(row.total_items || (archive.collections?.length || 0) + (archive.bookmarks?.length || 0) + (archive.assets?.length || 0)),
            duplicates: duplicates.length,
            mapped: Number(row.completed_items || 0)
        },
        duplicates,
        unresolvedDuplicates: duplicates.filter(item => !item.decision).length,
        taskId: row.task_id ? String(row.task_id) : null,
        task: task ? publicTask(task) : null,
        scanStatus: failedScans.length ? 'failed' : pendingScans.length ? 'processing' : 'succeeded',
        scanTasks,
        scanError: failedScans[0]?.failure || null,
        error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
        createdAt: taskDate(row.created_at),
        updatedAt: taskDate(row.updated_at)
    }
}

const selectMigrationArchive = async (env, archiveId, userId = null) => {
    const where = userId === null ? 'id = ?' : 'id = ? AND user_id = ?'
    const values = userId === null ? [archiveId] : [archiveId, userId]
    return env.DB.prepare(`SELECT id, user_id, source, archive_json, preflight_json, review_json, status,
        collection_count, bookmark_count, asset_count, total_items, completed_items, task_id, error_code, error_message,
        created_at, updated_at FROM migration_archives WHERE ${where}`).bind(...values).first()
}

const createMigrationTask = async (env, request, userId, archiveId) => {
    const idempotencyKey = migrationTaskType + ':' + archiveId
    const now = Date.now()
    const id = randomToken(18)
    const inserted = await env.DB.prepare(`INSERT INTO background_tasks
        (id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key,
         source_url, content_id, payload, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 'queued', 0, 0, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING`).bind(
        id, userId, migrationTaskType, idempotencyKey, 'migration://' + archiveId,
        JSON.stringify({ archiveId: String(archiveId) }), now, now).run()
    let task = await selectTask(env, id, userId)
    if (!task)
        task = await env.DB.prepare(`SELECT id, user_id, bookmark_id, type, status, progress, retry_count,
            idempotency_key, source_url, content_id, payload, result_metadata, error_code, error_message,
            next_retry_at, created_at, updated_at, completed_at FROM background_tasks
            WHERE idempotency_key = ? AND user_id = ?`).bind(idempotencyKey, userId).first()
    if (!task) return null
    if (Number(inserted?.meta?.changes || 0) === 1) {
        await enqueueTask(env, task)
        task = await selectTask(env, task.id, userId) || task
        if (request) await recordAudit(env, request, { userId, action: 'migration.task.created', resourceType: 'background_task', resourceId: task.id, outcome: 'success' })
    }
    return task
}

const migrationMappingKey = (sourceType, sourceId) => sourceType + ':' + String(sourceId)

const migrationResourceKey = (archiveId, sourceType, sourceId) =>
    String(archiveId) + ':' + sourceType + ':' + String(sourceId)

const migrationMappings = async (env, archiveId, userId) => {
    const rows = await env.DB.prepare(`SELECT source_type, source_id, resource_type, resource_id, decision
        FROM migration_mappings WHERE archive_id = ? AND user_id = ?`).bind(archiveId, userId).all()
    return new Map((rows.results || []).map(row => [migrationMappingKey(row.source_type, row.source_id), {
        sourceType: row.source_type,
        sourceId: String(row.source_id),
        resourceType: row.resource_type,
        resourceId: row.resource_type === 'content' ? String(row.resource_id) : Number(row.resource_id),
        decision: row.decision || 'keep'
    }]))
}

const addMigrationMapping = async (env, { archiveId, userId, sourceType, sourceId, resourceType, resourceId, decision = 'keep' }) => {
    await env.DB.prepare(`INSERT OR IGNORE INTO migration_mappings
        (archive_id, user_id, source_type, source_id, resource_type, resource_id, decision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        archiveId, userId, sourceType, String(sourceId), resourceType, String(resourceId), decision, Date.now()).run()
}

const migrationAssetBytes = value => {
    try {
        const bytes = base64ToBytes(value)
        if (!bytes.length) throw new Error('empty content')
        return bytes
    } catch {
        throw metadataFailure('migration_invalid', 'The migration archive contains invalid Protected Content', true)
    }
}

const selectMigrationContent = async (env, userId, migrationKey) => env.DB.prepare(`SELECT id, user_id, bookmark_id, kind, status, object_key,
    filename, content_type, size_bytes, created_at, updated_at, cleared_at, migration_key
    FROM content_objects WHERE user_id = ? AND migration_key = ?`).bind(userId, migrationKey).first()

const updateMigrationProgress = async (env, task, archiveId, completed, total, status = 'processing') => {
    const progress = total ? Math.min(99, Math.floor(completed * 100 / total)) : 99
    const now = Date.now()
    await env.DB.prepare('UPDATE background_tasks SET status = ?, progress = ?, result_metadata = ?, updated_at = ? WHERE id = ?')
        .bind(status, progress, JSON.stringify({ archiveId: String(archiveId), completed, total }), now, task.id).run()
    await env.DB.prepare('UPDATE migration_archives SET status = ?, completed_items = ?, updated_at = ? WHERE id = ?')
        .bind(status, completed, now, archiveId).run()
}

const processMigrationTask = async (env, taskId) => {
    const claimed = await claimTask(env, taskId)
    if (claimed.action !== 'process') return claimed

    const task = claimed.task
    let archiveId = null
    try {
        const payload = parseTaskMetadata(task.payload)
        archiveId = String(payload.archiveId || '')
        if (!archiveId) throw metadataFailure('migration_archive_missing', 'The migration archive is no longer available', true)
        const archiveRow = await selectMigrationArchive(env, archiveId, task.user_id)
        if (!archiveRow) throw metadataFailure('migration_archive_missing', 'The migration archive is no longer available', true)
        const archive = parseTaskMetadata(archiveRow.archive_json)
        const decisions = parseMigrationDecisions(archiveRow.review_json)
        const mappings = await migrationMappings(env, archiveId, task.user_id)
        const total = Number(archiveRow.total_items || (archive.collections?.length || 0) + (archive.bookmarks?.length || 0) + (archive.assets?.length || 0))
        let completed = mappings.size
        await updateMigrationProgress(env, task, archiveId, completed, total)

        const collectionsBySource = new Map((archive.collections || []).map(item => [item.sourceId, item]))
        const orderedCollections = []
        const visiting = new Set()
        const visited = new Set()
        const visit = item => {
            if (visited.has(item.sourceId)) return
            if (visiting.has(item.sourceId)) return
            visiting.add(item.sourceId)
            const parent = item.parentSourceId && collectionsBySource.get(item.parentSourceId)
            if (parent) visit(parent)
            visiting.delete(item.sourceId)
            visited.add(item.sourceId)
            orderedCollections.push(item)
        }
        for (const item of archive.collections || []) visit(item)

        for (const item of orderedCollections) {
            const key = migrationMappingKey('collection', item.sourceId)
            if (mappings.has(key)) continue
            const parent = item.parentSourceId && mappings.get(migrationMappingKey('collection', item.parentSourceId))
            const migrationKey = migrationResourceKey(archiveId, 'collection', item.sourceId)
            const now = Date.now()
            const inserted = await env.DB.prepare(`INSERT INTO collections
                (user_id, title, parent_id, created_at, updated_at, slug, is_public, migration_key)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT DO NOTHING`).bind(
                task.user_id, item.title, parent?.resourceId || null, now, now, item.slug || slugify(item.title), migrationKey).run()
            const existing = await env.DB.prepare('SELECT id FROM collections WHERE user_id = ? AND migration_key = ?')
                .bind(task.user_id, migrationKey).first()
            const resourceId = Number(existing?.id || inserted?.meta?.last_row_id)
            if (!Number.isSafeInteger(resourceId) || resourceId <= 0)
                throw metadataFailure('migration_write_failed', 'The migration could not create a Collection', true)
            await env.DB.prepare(`INSERT INTO collection_collaborators (collection_id, user_id, role)
                VALUES (?, ?, 'owner') ON CONFLICT(collection_id, user_id) DO UPDATE SET role = 'owner'`)
                .bind(resourceId, task.user_id).run()
            await addMigrationMapping(env, { archiveId, userId: task.user_id, sourceType: 'collection', sourceId: item.sourceId, resourceType: 'collection', resourceId })
            mappings.set(key, { resourceId, resourceType: 'collection', decision: 'keep' })
            completed++
            await updateMigrationProgress(env, task, archiveId, completed, total)
        }

        const duplicateBySource = new Map((archiveRow.preflight_json ? parseTaskMetadata(archiveRow.preflight_json).duplicates || [] : []).map(item => [item.sourceId, item]))
        for (const item of archive.bookmarks || []) {
            const key = migrationMappingKey('bookmark', item.sourceId)
            if (mappings.has(key)) continue
            const duplicate = duplicateBySource.get(item.sourceId)
            const decision = migrationDecision(decisions['bookmark:' + item.sourceId]) || (duplicate ? null : 'keep')
            if (!decision) throw metadataFailure('duplicate_review_required', 'Duplicate review is incomplete', true)
            if (decision === 'skip') {
                const duplicateTarget = duplicate?.existingResourceId || mappings.get(migrationMappingKey('bookmark', duplicate?.duplicateOfSourceId))?.resourceId
                if (!duplicateTarget) throw metadataFailure('migration_duplicate_target_missing', 'The duplicate target is no longer available', true)
                await addMigrationMapping(env, { archiveId, userId: task.user_id, sourceType: 'bookmark', sourceId: item.sourceId, resourceType: 'bookmark', resourceId: duplicateTarget, decision })
                mappings.set(key, { resourceId: duplicateTarget, resourceType: 'bookmark', decision })
                completed++
                await updateMigrationProgress(env, task, archiveId, completed, total)
                continue
            }
            const collection = item.collectionSourceId && mappings.get(migrationMappingKey('collection', item.collectionSourceId))
            const migrationKey = migrationResourceKey(archiveId, 'bookmark', item.sourceId)
            const now = Date.now()
            const inserted = await env.DB.prepare(`INSERT INTO bookmarks
                (user_id, url, title, description, note, highlights, created_at, updated_at, collection_id, tags, migration_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(
                task.user_id, item.url, item.title, item.description, item.note, JSON.stringify(applyHighlightChanges('[]', item.highlights)),
                now, now, collection?.resourceId || -1, JSON.stringify(item.tags), migrationKey).run()
            const existing = await env.DB.prepare('SELECT id FROM bookmarks WHERE user_id = ? AND migration_key = ?')
                .bind(task.user_id, migrationKey).first()
            const resourceId = Number(existing?.id || inserted?.meta?.last_row_id)
            if (!Number.isSafeInteger(resourceId) || resourceId <= 0)
                throw metadataFailure('migration_write_failed', 'The migration could not create a Bookmark', true)
            await addMigrationMapping(env, { archiveId, userId: task.user_id, sourceType: 'bookmark', sourceId: item.sourceId, resourceType: 'bookmark', resourceId })
            mappings.set(key, { resourceId, resourceType: 'bookmark', decision })
            completed++
            await updateMigrationProgress(env, task, archiveId, completed, total)
        }

        for (const asset of archive.assets || []) {
            const key = migrationMappingKey('content', asset.sourceId)
            if (mappings.has(key)) continue
            const bookmark = mappings.get(migrationMappingKey('bookmark', asset.bookmarkSourceId))
            if (!bookmark) throw metadataFailure('migration_invalid', 'Protected Content refers to an unknown Bookmark', true)
            const migrationKey = migrationResourceKey(archiveId, 'content', asset.sourceId)
            const bytes = migrationAssetBytes(asset.data)
            if (bytes.byteLength > contentBodyLimit)
                throw metadataFailure('content_too_large', 'The content exceeds the size limit', true)
            const kind = asset.assetType === 'snapshot' ? 'snapshot' : asset.assetType === 'cover' ? 'screenshot' : 'attachment'
            let content = await selectMigrationContent(env, task.user_id, migrationKey)
            if (!content) {
                content = await createContentRecord(env, {
                    userId: task.user_id,
                    bookmarkId: bookmark.resourceId,
                    kind,
                    filename: asset.filename,
                    contentType: asset.contentType,
                    size: bytes.byteLength,
                    status: attachmentScanEnabled(env) ? 'quarantined' : 'cleared',
                    migrationKey
                })
            }
            if (!content) throw metadataFailure('content_storage_unavailable', 'Protected Content could not be stored', true)
            await putContentObject(env, content, bytes, asset)
            if (asset.assetType === 'cover') {
                const cover = String(env.API_ORIGIN || '').replace(/\/+$/, '') + '/v1/content/' + encodeURIComponent(String(content.id)) + '/download'
                await env.DB.prepare('UPDATE bookmarks SET cover = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                    .bind(cover, Date.now(), bookmark.resourceId, task.user_id).run()
            }
            if (attachmentScanEnabled(env)) {
                const scanTask = await ensureContentScanTask(env, {
                    userId: task.user_id,
                    bookmarkId: bookmark.resourceId,
                    contentId: content.id,
                    sourceUrl: 'content://' + content.id,
                    kind
                })
                if (!scanTask || scanTask.status === 'dead_letter')
                    throw metadataFailure('content_task_unavailable', 'The content safety check could not be queued', true)
            }
            await addMigrationMapping(env, {
                archiveId,
                userId: task.user_id,
                sourceType: 'content',
                sourceId: asset.sourceId,
                resourceType: 'content',
                resourceId: content.id
            })
            mappings.set(key, { resourceId: content.id, resourceType: 'content', decision: 'keep' })
            completed++
            await updateMigrationProgress(env, task, archiveId, completed, total)
        }

        const now = Date.now()
        await env.DB.prepare(`UPDATE background_tasks SET status = 'succeeded', progress = 100,
            result_metadata = ?, error_code = NULL, error_message = NULL, next_retry_at = NULL,
            updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`).bind(
            JSON.stringify({ archiveId, completed, total, mappings: mappings.size }), now, now, taskId).run()
        await env.DB.prepare(`UPDATE migration_archives SET status = 'succeeded', completed_items = ?, error_code = NULL,
            error_message = NULL, updated_at = ? WHERE id = ?`).bind(completed, now, archiveId).run()
        return { action: 'ack' }
    } catch (failure) {
        const result = await markTaskFailure(env, task, failure)
        if (archiveId) {
            const status = result.action === 'retry' ? 'retrying' : 'dead_letter'
            const details = result.failure || taskFailureDetails(failure)
            try { await env.DB.prepare('UPDATE migration_archives SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
                .bind(status, details.code, details.message, Date.now(), archiveId).run() } catch {}
        }
        return result
    }
}

const collectionItem = item => ({
    _id: Number(item.id),
    title: item.title,
    parentId: item.parent_id,
    count: Number(item.count || 0),
    removed: Boolean(item.removed_at),
    public: Boolean(item.is_public),
    slug: item.slug || slugify(item.title) || String(item.id),
    publicLink: item.public_link,
    access: {
        level: roleLevel(item.role || 'owner'),
        role: item.role || 'owner',
        draggable: roleLevel(item.role || 'owner') >= roleLevel('editor')
    }
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

const normalizeRole = value => {
    const role = String(value || '').toLowerCase()
    return role === 'member' ? 'editor' : collectionRoles.has(role) ? role : null
}

const roleLevel = role => ({ owner: 4, editor: 3, viewer: 2 }[normalizeRole(role)] || 0)

const slugify = value => String(value || '').trim().toLowerCase()
    .normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

const persistedSlug = async (env, item) => {
    const current = String(item?.slug || '').trim().toLowerCase()
    if (current) return current
    const slug = slugify(item?.title) || String(item?.id)
    try {
        await env.DB.prepare('UPDATE collections SET slug = ? WHERE id = ? AND (slug IS NULL OR slug = \'\')')
            .bind(slug, item.id).run()
    } catch {}
    return slug
}

const publicOrigin = env => String(env.PUBLIC_ORIGIN || env.APP_ORIGIN || env.API_ORIGIN || '').replace(/\/+$/, '')

const publicCollectionLink = async (env, item) => {
    const slug = await persistedSlug(env, item)
    const base = publicOrigin(env)
    return base ? base + '/public/' + encodeURIComponent(slug) + '-' + Number(item.id) : ''
}

const collectionRole = async (env, userId, collectionId) => {
    let current = Number(collectionId)
    const visited = new Set()
    let bestRole = null
    while (Number.isSafeInteger(current) && current > 0 && !visited.has(current)) {
        visited.add(current)
        const collection = await env.DB.prepare('SELECT id, user_id, parent_id, removed_at FROM collections WHERE id = ?').bind(current).first()
        if (!collection || collection.removed_at) return null
        if (Number(collection.user_id) === Number(userId)) bestRole = 'owner'
        const member = await env.DB.prepare('SELECT role FROM collection_collaborators WHERE collection_id = ? AND user_id = ?')
            .bind(current, userId).first()
        const role = normalizeRole(member?.role)
        if (role && roleLevel(role) > roleLevel(bestRole)) bestRole = role
        current = Number(collection.parent_id || 0)
    }
    return bestRole
}

const collectionCanWrite = async (env, userId, collectionId) =>
    roleLevel(await collectionRole(env, userId, collectionId)) >= roleLevel('editor')

const collectionDescendants = async (env, collectionId) => {
    const rows = await env.DB.prepare('SELECT id, parent_id FROM collections WHERE removed_at IS NULL').bind().all()
    return descendantCollectionIds(rows.results || [], [Number(collectionId)])
}

const selectCollection = async (env, collectionId, userId = null) => {
    const item = await env.DB.prepare(`SELECT c.*, COUNT(b.id) AS count
        FROM collections c LEFT JOIN bookmarks b ON b.collection_id = c.id AND b.removed_at IS NULL
        WHERE c.id = ? GROUP BY c.id`).bind(Number(collectionId)).first()
    if (!item || item.removed_at) return null
    if (userId === null) return item
    const role = await collectionRole(env, userId, collectionId)
    return role ? { ...item, role } : null
}

const collaboratorItem = item => {
    const role = normalizeRole(item.role) || 'viewer'
    return {
        _id: Number(item.user_id),
        name: item.name || item.email || '',
        email: item.email || '',
        role,
        canonicalRole: role,
        inherited: Boolean(item.inherited)
    }
}

const publicSnapshotItem = (item, env) => ({
    id: String(item.content_id || item.id),
    contentId: String(item.content_id || item.id),
    bookmarkId: Number(item.bookmark_id),
    kind: item.kind,
    filename: item.filename || 'snapshot.html',
    contentType: item.content_type || 'text/html',
    size: Number(item.size_bytes || 0),
    publishedAt: item.published_at ? new Date(item.published_at).toISOString() : null,
    downloadUrl: String(env.API_ORIGIN || publicOrigin(env)).replace(/\/+$/, '') + '/public/content/' + encodeURIComponent(String(item.content_id || item.id))
})

const publicBookmarkItem = item => ({
    _id: Number(item.id),
    id: Number(item.id),
    link: item.url,
    title: item.title,
    description: item.description || '',
    excerpt: item.description || '',
    tags: bookmarkTags(item.tags),
    created: item.created_at ? new Date(item.created_at).toISOString() : null,
    lastUpdate: item.updated_at ? new Date(item.updated_at).toISOString() : null
})

const publishedSnapshotsFor = async (env, collectionId) => {
    const rows = await env.DB.prepare(`SELECT ps.content_id, ps.bookmark_id, ps.published_at,
        co.kind, co.filename, co.content_type, co.size_bytes
        FROM published_snapshots ps JOIN content_objects co ON co.id = ps.content_id
        WHERE ps.collection_id = ? AND ps.revoked_at IS NULL AND co.status = 'cleared'
        ORDER BY ps.published_at DESC`).bind(collectionId).all()
    return rows.results || []
}

const publicCollectionPayload = async (env, collectionId, suppliedSlug = '') => {
    const collection = await env.DB.prepare(`SELECT id, user_id, title, parent_id, slug, is_public, removed_at, created_at, updated_at
        FROM collections WHERE id = ?`).bind(Number(collectionId)).first()
    if (!collection || collection.removed_at || !Number(collection.is_public)) return null

    const slug = await persistedSlug(env, collection)
    const descendants = await collectionDescendants(env, collectionId)
    const placeholders = descendants.map(() => '?').join(',') || '?'
    const rows = await env.DB.prepare(`SELECT id, url, title, description, tags, created_at, updated_at
        FROM bookmarks WHERE removed_at IS NULL AND collection_id IN (${placeholders}) ORDER BY updated_at DESC`).bind(...descendants).all()
    const visibleBookmarkIds = new Set((rows.results || []).map(item => Number(item.id)))
    const snapshots = (await publishedSnapshotsFor(env, collectionId)).filter(item => visibleBookmarkIds.has(Number(item.bookmark_id)))
    const byBookmark = new Map()
    for (const snapshot of snapshots) {
        const item = publicSnapshotItem(snapshot, env)
        const list = byBookmark.get(Number(snapshot.bookmark_id)) || []
        list.push(item)
        byBookmark.set(Number(snapshot.bookmark_id), list)
    }
    const items = (rows.results || []).map(item => ({
        ...publicBookmarkItem(item),
        publishedSnapshots: byBookmark.get(Number(item.id)) || []
    }))
    const result = {
        id: Number(collection.id),
        _id: Number(collection.id),
        title: collection.title,
        slug,
        public: true,
        publicLink: await publicCollectionLink(env, collection),
        parentId: collection.parent_id,
        created: collection.created_at ? new Date(collection.created_at).toISOString() : null,
        lastUpdate: collection.updated_at ? new Date(collection.updated_at).toISOString() : null
    }
    return {
        result: true,
        collection: result,
        item: result,
        items,
        bookmarks: items,
        publishedSnapshots: snapshots.map(snapshot => publicSnapshotItem(snapshot, env)),
        ...(suppliedSlug && suppliedSlug !== slug ? { canonicalSlug: slug } : {})
    }
}

const selectPublishedContent = async (env, contentId) => {
    const item = await env.DB.prepare(`SELECT co.id, co.bookmark_id, co.kind, co.status, co.object_key, co.filename,
        co.content_type, co.size_bytes, ps.published_at, ps.collection_id, b.collection_id AS bookmark_collection_id
        FROM published_snapshots ps JOIN content_objects co ON co.id = ps.content_id
        JOIN bookmarks b ON b.id = co.bookmark_id AND b.removed_at IS NULL
        JOIN collections c ON c.id = ps.collection_id
        WHERE ps.content_id = ? AND ps.revoked_at IS NULL AND c.is_public = 1
        AND c.removed_at IS NULL AND co.status = 'cleared'`).bind(contentId).first()
    if (!item) return null
    const descendants = await collectionDescendants(env, item.collection_id)
    return descendants.includes(Number(item.bookmark_collection_id)) ? item : null
}

const inviteLink = (env, token) => {
    const base = publicOrigin(env)
    return base ? base + '/join/' + encodeURIComponent(token) : ''
}

const createCollectionInvitation = async (env, collectionId, userId, role) => {
    const token = randomToken(32)
    const now = Date.now()
    await env.DB.prepare(`INSERT INTO collection_invitations
        (token_hash, collection_id, invited_by, role, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(
        await hmac(token, env.SESSION_SECRET), collectionId, userId, role,
        now + invitationDays * 86400 * 1000, now).run()
    return { token, expiresAt: now + invitationDays * 86400 * 1000 }
}

const collectionCollaborators = async (env, collectionId) => {
    const rows = await env.DB.prepare(`SELECT cc.collection_id, cc.user_id, cc.role, u.name, u.email
        FROM collection_collaborators cc JOIN users u ON u.id = cc.user_id
        WHERE cc.collection_id = ? ORDER BY CASE cc.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.id`).bind(collectionId).all()
    return rows.results || []
}

const setPublishedSnapshots = async (env, collectionId, userId, contentIds, published) => {
    const ids = [...new Set((contentIds || []).map(String).filter(Boolean))]
    if (!ids.length) return { error: 'validation_failed' }
    const descendants = await collectionDescendants(env, collectionId)
    const placeholders = descendants.map(() => '?').join(',') || '?'
    const records = []
    for (const contentId of ids) {
        const content = await env.DB.prepare(`SELECT co.id, co.bookmark_id, co.kind, co.status
            FROM content_objects co JOIN bookmarks b ON b.id = co.bookmark_id
            WHERE co.id = ? AND b.removed_at IS NULL AND b.collection_id IN (${placeholders})`).bind(contentId, ...descendants).first()
        if (!content) return { error: 'content_not_found', contentId }
        if (!['snapshot', 'screenshot'].includes(content.kind)) return { error: 'snapshot_required', contentId }
        if (published && content.status !== 'cleared') return { error: 'content_quarantined', contentId }
        const now = Date.now()
        if (published) {
            await env.DB.prepare(`INSERT INTO published_snapshots
                (content_id, collection_id, bookmark_id, published_by, published_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, NULL)
                ON CONFLICT(content_id) DO UPDATE SET collection_id = excluded.collection_id,
                    bookmark_id = excluded.bookmark_id, published_by = excluded.published_by,
                    published_at = excluded.published_at, revoked_at = NULL`)
                .bind(content.id, collectionId, content.bookmark_id, userId, now).run()
        } else {
            await env.DB.prepare('UPDATE published_snapshots SET revoked_at = ? WHERE content_id = ? AND collection_id = ? AND revoked_at IS NULL')
                .bind(now, content.id, collectionId).run()
        }
        records.push(content)
    }
    return { items: records }
}


const collectionOwned = async (env, userId, collectionId) =>
    collectionId <= 0 || Boolean(await env.DB.prepare('SELECT id FROM collections WHERE id = ? AND user_id = ? AND removed_at IS NULL').bind(collectionId, userId).first())

const userCollections = async (env, userId) => {
    const rows = await env.DB.prepare('SELECT id, parent_id, removed_at, removed_batch FROM collections WHERE user_id = ?').bind(userId).all()
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

const auditRequestId = () => randomToken(16)

const auditRoute = request => {
    const pathname = new URL(request.url).pathname
    const patterns = [
        [/^\/v1\/collection\/-?\d+\/lastAction$/, '/v1/collection/:id/lastAction'],
        [/^\/v1\/collection\/-?\d+$/, '/v1/collection/:id'],
        [/^\/v1\/raindrop\/\d+\/highlights\.(txt|csv)$/, '/v1/raindrop/:id/highlights.$1'],
        [/^\/v1\/raindrop\/\d+$/, '/v1/raindrop/:id'],
        [/^\/v1\/raindrops\/-?\d+\/export\.(html|csv|txt|zip)$/, '/v1/raindrops/:collectionId/export'],
        [/^\/v1\/raindrops\/-?\d+$/, '/v1/raindrops/:collectionId'],
        [/^\/v1\/backup\/connections\/gdrive\/authorize$/, '/v1/backup/connections/gdrive/authorize'],
        [/^\/v1\/backup\/connections\/[^/]+(?:\/default)?$/, '/v1/backup/connections/:id'],
        [/^\/v1\/(?:backup|backups)\/[^/]+(?:\.(?:html|csv|txt|zip)|\/status)?$/, '/v1/backups/:id'],
        [/^\/v1\/tags\/-?\d+$/, '/v1/tags/:collectionId'],
        [/^\/v1\/filters\/-?\d+$/, '/v1/filters/:collectionId'],
        [/^\/v1\/sessions\/[^/]+$/, '/v1/sessions/:id'],
        [/^\/v1\/tasks\/[^/]+(?:\/(?:status|failure|retry))?$/, '/v1/tasks/:id'],
        [/^\/v1\/content\/[^/]+\/download$/, '/v1/content/:id/download'],
        [/^\/v1\/content\/[^/]+$/, '/v1/content/:id'],
        [/^\/v1\/raindrop\/\d+\/(?:content|capture)(?:\/status)?$/, '/v1/raindrop/:id/content'],
        [/^\/v1\/raindrop\/\d+\/attachments?$/, '/v1/raindrop/:id/attachments'],
        [/^\/v1\/collection\/\d+\/sharing(?:\/\d+)?$/, '/v1/collection/:id/sharing'],
        [/^\/v1\/collection\/\d+\/(?:transfer|ownership|published-snapshots|snapshots)(?:\/[^/]+)?$/, '/v1/collection/:id/sharing'],
        [/^\/v1\/content\/[^/]+\/publish$/, '/v1/content/:id/publish'],
        [/^\/v1\/import\/[^/]+(?:\/(?:review|commit|status|retry|mappings))?$/, '/v1/import/:id'],
        [/^\/v1\/raindrop\/\d+\/suggest$/, '/v1/raindrop/:id/suggest'],
        [/^\/v2\/ai\/(?:chats|history)\/[^/]+$/, '/v2/ai/chats/:id']
    ]
    const match = patterns.find(([pattern]) => pattern.test(pathname))
    if (match) return pathname.replace(match[0], match[1])

    const known = new Set([
        '/v1/auth/email/signup', '/v1/auth/email/login', '/v1/auth/email/confirm',
        '/v1/auth/google', '/v1/auth/google/callback', '/v1/auth/logout',
        '/v1/sessions', '/v1/collections/all', '/v1/collections', '/v1/collections/clean',
        '/v1/collection', '/v1/tags/recent', '/v1/tags/0', '/v1/tag',
        '/v1/raindrops', '/v1/raindrops/changes', '/v1/raindrop', '/v1/user', '/v1/user/quota',
        '/v1/backup', '/v1/backups', '/v1/backup/connections',
        '/v1/user/connect/google', '/v1/user/connect/google/revoke', '/v1/user/deletion',
        '/v1/tasks',
        '/v1/import', '/v1/import/preflight',
        '/v1/user/remove', '/v1/user/send_email_confirm', '/v1/user/stats',
        '/v1/raindrop/file', '/v1/raindrop/suggest', '/v1/content/upload', '/v1/collaborators/join',
        '/v2/ai/config', '/v2/ai/quota', '/v2/ai/chat', '/v2/ai/history', '/v2/ai/chats',
        '/v2/ai/context', '/v2/ai/suggestions', '/v2/ai/description-draft'
    ])
    return known.has(pathname) ? pathname : '/v1/unknown'
}

const recordAudit = async (env, request, { userId = null, action, resourceType = 'api', resourceId = null, outcome }) => {
    if (!env.DB?.prepare) return
    try {
        await env.DB.prepare(`INSERT INTO audit_records
            (user_id, request_id, action, resource_type, resource_id, outcome, created_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
                userId || null,
                auditRequestId(request),
                action,
                resourceType,
                resourceId === null || resourceId === undefined ? null : String(resourceId),
                outcome,
                Date.now(),
                JSON.stringify({ method: request.method, route: auditRoute(request) })
            ).run()
    } catch {
        // Audit failures must not turn an otherwise valid API request into an error.
    }
}

const recordAlert = async (env, request, { userId = null, kind, severity = 'warning', metadata = {} }) => {
    if (!env.DB?.prepare) return
    try {
        await env.DB.prepare(`INSERT INTO alerts
            (user_id, request_id, kind, severity, route, created_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(
                userId || null,
                auditRequestId(request),
                kind,
                severity,
                auditRoute(request),
                Date.now(),
                JSON.stringify(metadata)
            ).run()
    } catch {
        // Alert failures must not change the API result.
    }
}

const rateLimitScope = async (request, env, userId) => {
    if (userId) return 'user:' + userId
    const address = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'anonymous'
    return 'ip:' + await hmac(address, env.SESSION_SECRET || 'rate-limit')
}

const rateLimit = async (request, env, url, userId = null) => {
    if (!url.pathname.startsWith('/v1/') || !env.DB?.prepare) return null
    const limit = integerEnv(env, url.pathname.startsWith('/v1/auth/')
        ? ['AUTH_RATE_LIMIT_PER_MINUTE', 'RATE_LIMIT_PER_MINUTE']
        : ['RATE_LIMIT_PER_MINUTE'], 60)
    const now = Date.now()
    const windowStart = Math.floor(now / rateWindowMs) * rateWindowMs
    try {
        const scopeKey = await rateLimitScope(request, env, userId)
        const routeKey = request.method + ' ' + auditRoute(request)
        const result = await env.DB.prepare(`INSERT INTO rate_limits (scope_key, route_key, window_start, request_count, updated_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(scope_key, route_key, window_start) DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
            WHERE rate_limits.request_count < ?`).bind(scopeKey, routeKey, windowStart, now, limit).run()
        if (Number(result?.meta?.changes || 0) === 1) return null

        const retryAfterMs = windowStart + rateWindowMs - now
        await recordAudit(env, request, { userId, action: 'rate.limit_exceeded', resourceType: 'route', resourceId: routeKey, outcome: 'blocked' })
        await recordAlert(env, request, { userId, kind: 'rate_limit_exceeded', metadata: { limit, retryAfter: Math.ceil(retryAfterMs / 1000) } })
        return retryableError('rate_limited', request, env, 'Too many requests. Retry after the indicated time.', retryAfterMs, {
            limit,
            remaining: 0
        })
    } catch {
        return null
    }
}

const usageWindow = now => {
    const windowStart = Math.floor(now / usageWindowMs) * usageWindowMs
    return { windowStart, resetAt: windowStart + usageWindowMs }
}

const usageLimit = env => integerEnv(env, ['USAGE_QUOTA_DAILY', 'USAGE_QUOTA', 'DAILY_USAGE_QUOTA'], 1000)

const aiDefaultModel = '@cf/meta/llama-3.1-8b-instruct-fp8'
const aiMessageLimit = 8000
const aiHistoryLimit = 50
const aiDailyLimit = env => integerEnv(env, ['AI_DAILY_QUOTA'], 20)
const aiGlobalDailyLimit = env => integerEnv(env, ['AI_GLOBAL_DAILY_QUOTA'], 10000)
const aiModel = env => String(env.AI_MODEL || aiDefaultModel)

const aiWindow = now => {
    const windowStart = Math.floor(now / usageWindowMs) * usageWindowMs
    return { windowStart, resetAt: windowStart + usageWindowMs }
}

const readAiQuota = async (env, userId) => {
    const limit = aiDailyLimit(env)
    const globalLimit = aiGlobalDailyLimit(env)
    const { windowStart, resetAt } = aiWindow(Date.now())
    try {
        const [row, global] = await Promise.all([
            env.DB.prepare('SELECT units FROM ai_usage_counters WHERE user_id = ? AND window_start = ?').bind(userId, windowStart).first(),
            env.DB.prepare('SELECT units FROM ai_global_usage_counters WHERE window_start = ?').bind(windowStart).first()
        ])
        const used = Number(row?.units || 0)
        const globalUsed = Number(global?.units || 0)
        return {
            used,
            limit,
            remaining: Math.max(0, limit - used),
            resetAt,
            global: {
                used: globalUsed,
                limit: globalLimit,
                remaining: Math.max(0, globalLimit - globalUsed)
            }
        }
    } catch {
        return { error: 'ai_quota_unavailable', resetAt }
    }
}

const consumeAiQuota = async (env, request, userId) => {
    const limit = aiDailyLimit(env)
    const globalLimit = aiGlobalDailyLimit(env)
    const now = Date.now()
    const { windowStart, resetAt } = aiWindow(now)
    try {
        const [current, globalCurrent] = await Promise.all([
            env.DB.prepare('SELECT units FROM ai_usage_counters WHERE user_id = ? AND window_start = ?').bind(userId, windowStart).first(),
            env.DB.prepare('SELECT units FROM ai_global_usage_counters WHERE window_start = ?').bind(windowStart).first()
        ])
        const previous = Number(current?.units || 0)
        const globalPrevious = Number(globalCurrent?.units || 0)
        const blockedScope = previous >= limit ? 'user' : globalPrevious >= globalLimit ? 'global' : null
        if (blockedScope) {
            const retryAfterMs = resetAt - now
            await recordAudit(env, request, { userId, action: 'ai.quota_exceeded', resourceType: 'ai_quota', outcome: 'blocked' })
            await recordAlert(env, request, {
                userId,
                kind: 'ai_quota_exceeded',
                severity: 'warning',
                metadata: { scope: blockedScope, limit: blockedScope === 'user' ? limit : globalLimit, used: blockedScope === 'user' ? previous : globalPrevious, retryAfter: Math.ceil(retryAfterMs / 1000) }
            })
            return {
                allowed: false,
                scope: blockedScope,
                used: previous,
                limit,
                remaining: 0,
                resetAt,
                retryAfterMs,
                global: { used: globalPrevious, limit: globalLimit, remaining: 0 }
            }
        }

        const userStatement = env.DB.prepare(`INSERT INTO ai_usage_counters (user_id, window_start, units, updated_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(user_id, window_start) DO UPDATE SET units = units + 1, updated_at = excluded.updated_at
            WHERE ai_usage_counters.units + 1 <= ?`).bind(userId, windowStart, now, limit)
        const globalStatement = env.DB.prepare(`INSERT INTO ai_global_usage_counters (window_start, units, updated_at)
            VALUES (?, 1, ?)
            ON CONFLICT(window_start) DO UPDATE SET units = units + 1, updated_at = excluded.updated_at
            WHERE ai_global_usage_counters.units + 1 <= ?`).bind(windowStart, now, globalLimit)
        const results = env.DB.batch
            ? await env.DB.batch([userStatement, globalStatement])
            : [await userStatement.run(), await globalStatement.run()]
        const userChanged = Number(results[0]?.meta?.changes || 0) === 1
        const globalChanged = Number(results[1]?.meta?.changes || 0) === 1
        if (!userChanged || !globalChanged) {
            if (userChanged)
                await env.DB.prepare(`UPDATE ai_usage_counters SET units = units - 1, updated_at = ?
                    WHERE user_id = ? AND window_start = ? AND units > 0`).bind(now, userId, windowStart).run()
            if (globalChanged)
                await env.DB.prepare(`UPDATE ai_global_usage_counters SET units = units - 1, updated_at = ?
                    WHERE window_start = ? AND units > 0`).bind(now, windowStart).run()
            const retryAfterMs = resetAt - now
            await recordAudit(env, request, { userId, action: 'ai.quota_exceeded', resourceType: 'ai_quota', outcome: 'blocked' })
            await recordAlert(env, request, {
                userId,
                kind: 'ai_quota_exceeded',
                severity: 'warning',
                metadata: { scope: !globalChanged ? 'global' : 'user', limit, used: previous, retryAfter: Math.ceil(retryAfterMs / 1000) }
            })
            return { allowed: false, scope: !globalChanged ? 'global' : 'user', used: previous, limit, remaining: 0, resetAt, retryAfterMs, global: { used: globalPrevious, limit: globalLimit, remaining: 0 } }
        }

        return {
            allowed: true,
            used: previous + 1,
            limit,
            remaining: Math.max(0, limit - previous - 1),
            resetAt,
            global: { used: globalPrevious + 1, limit: globalLimit, remaining: Math.max(0, globalLimit - globalPrevious - 1) }
        }
    } catch {
        return { error: 'ai_quota_unavailable', resetAt }
    }
}

const aiChatId = () => randomToken(18)

const selectAiChat = async (env, userId, chatId) => env.DB.prepare(`SELECT id, user_id, title, created_at, updated_at
    FROM ai_chats WHERE id = ? AND user_id = ?`).bind(chatId, userId).first()

const aiPublicChat = (chat, messages = []) => ({
    id: String(chat.id),
    title: String(chat.title || ''),
    created_at: Number(chat.created_at || 0),
    updated_at: Number(chat.updated_at || 0),
    messages: messages.map(message => ({
        id: Number(message.id),
        role: message.role,
        content: String(message.content || ''),
        created_at: Number(message.created_at || 0)
    }))
})

const listAiHistory = async (env, userId, chatId = null) => {
    const chats = chatId
        ? [await selectAiChat(env, userId, chatId)].filter(Boolean)
        : (await env.DB.prepare(`SELECT id, user_id, title, created_at, updated_at FROM ai_chats
            WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`).bind(userId, aiHistoryLimit).all()).results || []
    if (!chats.length) return []

    const rows = (await env.DB.prepare(`SELECT id, chat_id, role, content, created_at FROM ai_messages
        WHERE user_id = ? ORDER BY created_at ASC LIMIT ?`).bind(userId, aiHistoryLimit * 40).all()).results || []
    const chatIds = new Set(chats.map(chat => String(chat.id)))
    const messages = new Map(chats.map(chat => [String(chat.id), []]))
    for (const row of rows) {
        const id = String(row.chat_id)
        if (chatIds.has(id)) messages.get(id).push(row)
    }
    return chats.map(chat => aiPublicChat(chat, messages.get(String(chat.id)) || []))
}

const deleteAiChat = async (env, userId, chatId) => {
    const chat = await selectAiChat(env, userId, chatId)
    if (!chat) return false
    const statements = [
        env.DB.prepare('DELETE FROM ai_messages WHERE chat_id = ? AND user_id = ?').bind(chatId, userId),
        env.DB.prepare('DELETE FROM ai_chats WHERE id = ? AND user_id = ?').bind(chatId, userId)
    ]
    if (env.DB.batch) await env.DB.batch(statements)
    else for (const statement of statements) await statement.run()
    return true
}

const deleteAiHistory = async (env, userId) => {
    const chats = (await env.DB.prepare('SELECT id FROM ai_chats WHERE user_id = ?').bind(userId).all()).results || []
    if (!chats.length) return 0
    const statements = [
        env.DB.prepare('DELETE FROM ai_messages WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM ai_chats WHERE user_id = ?').bind(userId)
    ]
    if (env.DB.batch) await env.DB.batch(statements)
    else for (const statement of statements) await statement.run()
    return chats.length
}

const aiContextItem = bookmark => {
    const highlights = arrayValue(bookmark.highlights)
    return {
        id: Number(bookmark.id),
        title: String(bookmark.title || ''),
        url: String(bookmark.url || ''),
        description: String(bookmark.description || ''),
        note: String(bookmark.note || ''),
        tags: bookmarkTags(bookmark.tags),
        highlights: highlights.map(item => String(item?.text || item || '')).filter(Boolean)
    }
}

const aiContextText = (bookmarks, contextLimit) => {
    let used = 0
    const parts = []
    const items = []
    for (const bookmark of bookmarks) {
        const item = aiContextItem(bookmark)
        const part = [
            'Authorized Bookmark context:',
            'Title: ' + item.title,
            'URL: ' + item.url,
            'Description: ' + item.description,
            'Notes: ' + item.note,
            'Tags: ' + item.tags.join(', '),
            'Highlights: ' + item.highlights.join(' | ')
        ].join('\n')
        if (used + part.length > contextLimit) break
        parts.push(part)
        items.push(item)
        used += part.length
    }
    return { text: parts.join('\n\n'), items }
}

const aiBookmarkContext = async (env, userId, value, query = '') => {
    try {
        let bookmarks
        if (value !== undefined && value !== null && value !== '') {
            const bookmarkId = Number(value)
            if (!Number.isSafeInteger(bookmarkId) || bookmarkId <= 0) return { error: 'bookmark_not_found' }
            const bookmark = await bookmarkAccessible(env, bookmarkId, userId)
            bookmarks = bookmark && !bookmark.removed_at ? [bookmark] : []
            if (!bookmarks.length) return { error: 'bookmark_not_found' }
        } else if (query.trim()) {
            const ignoredTerms = new Set(['find', 'show', 'search', 'my', 'bookmarks', 'bookmark', 'about', 'what', 'is', 'the', 'for', 'with', 'please'])
            const terms = query.trim().split(/\s+/)
                .map(term => term.replace(/[.,!?;:()[\]{}"'`]/g, '').slice(0, 80))
                .filter(term => term.length > 1 && !ignoredTerms.has(term.toLowerCase()))
                .slice(0, 5)
            if (!terms.length) return { text: '', sources: [] }
            const fields = ['title', 'url', 'description', 'note', 'tags', 'highlights']
            const clauses = terms.map(() => fields.map(field => `b.${field} LIKE ?`).join(' OR ')).join(' OR ')
            const values = terms.flatMap(term => Array(fields.length).fill(`%${term}%`))
            bookmarks = (await env.DB.prepare(`WITH RECURSIVE accessible(id) AS (
                    SELECT c.id FROM collections c
                    LEFT JOIN collection_collaborators cc ON cc.collection_id = c.id AND cc.user_id = ?
                    WHERE c.removed_at IS NULL AND (c.user_id = ? OR cc.user_id IS NOT NULL)
                    UNION
                    SELECT c.id FROM collections c JOIN accessible parent ON c.parent_id = parent.id
                    WHERE c.removed_at IS NULL
                )
                SELECT b.id, b.user_id, b.url, b.title, b.description, b.note, b.tags, b.highlights
                FROM bookmarks b
                WHERE b.removed_at IS NULL AND (b.user_id = ? OR b.collection_id IN (SELECT id FROM accessible))
                    AND (${clauses})
                ORDER BY b.updated_at DESC LIMIT 5`).bind(userId, userId, userId, ...values).all()).results || []
        } else return { text: '', items: [], sources: [] }

        const contextLimit = Number(env.AI_CONTEXT_MAX_CHARS) || 12000
        const context = aiContextText(bookmarks, contextLimit)
        const sources = []
        for (const bookmark of bookmarks) {
            if (!context.items.some(item => item.id === Number(bookmark.id))) continue
            sources.push({ raindropId: bookmark.id, title: String(bookmark.title || bookmark.url || ''), url: String(bookmark.url || '') })
        }
        return { ...context, sources }
    } catch {
        return { text: '', items: [], sources: [] }
    }
}

const aiLanguage = (value, request) => String(value || request.headers.get('Accept-Language') || 'en')
    .split(',')[0].trim().slice(0, 32) || 'en'

const aiSuggestionCandidates = async (env, userId) => {
    const collections = (await env.DB.prepare('SELECT id, title, parent_id FROM collections WHERE user_id = ? AND removed_at IS NULL ORDER BY title LIMIT 100').bind(userId).all()).results || []
    const tags = await tagItems(env, userId, 0, '', '-count')
    return {
        collections: collections.map(item => ({ id: Number(item.id), title: String(item.title || '') })).filter(item => item.id > 0 && item.title),
        tags: tags.map(item => String(item._id || '')).filter(Boolean).slice(0, 100)
    }
}

const aiJson = value => {
    const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

const aiSuggestionResult = (value, candidates, bookmark) => {
    const parsed = aiJson(value) || {}
    const collectionsById = new Map(candidates.collections.map(item => [String(item.id), item]))
    const collectionsByTitle = new Map(candidates.collections.map(item => [item.title.toLowerCase(), item]))
    const selectedCollections = []
    for (const item of Array.isArray(parsed.collections) ? parsed.collections : []) {
        const key = typeof item === 'object' ? item.id ?? item._id ?? item.$id ?? item.collectionId : item
        const title = typeof item === 'object' ? item.title : ''
        const candidate = collectionsById.get(String(key)) || collectionsByTitle.get(String(title || '').toLowerCase())
        if (candidate && !selectedCollections.some(current => current.id === candidate.id)) selectedCollections.push(candidate)
    }
    const existingTags = new Set(candidates.tags.map(tag => tag.toLowerCase()))
    const currentTags = new Set((bookmark.tags || []).map(tag => String(tag).toLowerCase()))
    const normalizeTags = value => [...new Set((Array.isArray(value) ? value : []).map(tagValue).filter(Boolean))]
        .filter(tag => !currentTags.has(tag.toLowerCase())).slice(0, 10)
    const tags = normalizeTags(parsed.tags).filter(tag => existingTags.has(tag.toLowerCase()))
    const newTags = normalizeTags(parsed.new_tags ?? parsed.newTags).filter(tag => !existingTags.has(tag.toLowerCase()))
    return {
        collections: selectedCollections.slice(0, 5),
        tags,
        newTags
    }
}

const aiFallbackSuggestions = (candidates, bookmark) => {
    const haystack = [bookmark.title, bookmark.description, bookmark.url].join(' ').toLowerCase()
    const collections = candidates.collections.filter(item => item.title.toLowerCase().split(/\s+/).some(term => term.length > 2 && haystack.includes(term)))
    const currentTags = new Set((bookmark.tags || []).map(tag => String(tag).toLowerCase()))
    const tags = candidates.tags.filter(tag => !currentTags.has(tag.toLowerCase())).slice(0, 5)
    const newTags = String(bookmark.title || '').split(/\s+/).map(tagValue)
        .filter(tag => tag && tag.length > 2 && !currentTags.has(tag.toLowerCase()) && !candidates.tags.some(item => item.toLowerCase() === tag.toLowerCase()))
        .slice(0, 5)
    return { collections: collections.slice(0, 5), tags, newTags }
}

const aiQuota = async (request, env, userId) => {
    const quota = await consumeAiQuota(env, request, userId)
    if (quota.error)
        return { response: error(quota.error, 503, request, env, 'AI quota is temporarily unavailable. Retry the request.') }
    if (!quota.allowed)
        return { response: retryableError('ai_quota_exceeded', request, env, 'Daily AI quota reached. Retry after the quota resets.', quota.retryAfterMs, {
            quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining, resetAt: new Date(quota.resetAt).toISOString(), global: quota.global, scope: quota.scope },
            resetAt: new Date(quota.resetAt).toISOString(),
            retryAt: new Date(quota.resetAt).toISOString()
        }) }
    return { quota }
}

const aiCollectText = async result => {
    let text = ''
    for await (const event of aiResultChunks(result)) text += event.delta || ''
    return text.trim()
}

const aiSuggestions = async (request, env, userId, { legacy = false, bookmarkId } = {}) => {
    const { data: rawData } = await readBody(request)
    const data = rawData && typeof rawData === 'object' ? rawData : {}
    const value = bookmarkId ?? (legacy ? data.raindropId ?? data.bookmarkId ?? data._id : data.raindropId)
    let context
    let bookmark
    if (value !== undefined && value !== null && value !== '') {
        context = await aiBookmarkContext(env, userId, value)
        if (context.error) return error(context.error, 404, request, env, 'Bookmark was not found')
        bookmark = context.items[0]
        bookmark.tags = context.items[0].tags || []
    } else {
        const link = String(data.link || data.url || '').trim()
        const title = String(data.title || '').trim()
        if (!link || !title) return error('validation_failed', 400, request, env, 'Provide a Bookmark URL and title')
        bookmark = { id: 0, title, url: link, description: String(data.description || data.excerpt || ''), note: String(data.note || ''), highlights: [], tags: Array.isArray(data.tags) ? data.tags : [] }
        const contextText = aiContextText([bookmark], Number(env.AI_CONTEXT_MAX_CHARS) || 12000)
        context = { ...contextText, sources: [] }
    }
    let candidates
    try { candidates = await aiSuggestionCandidates(env, userId) } catch {
        return error('ai_context_unavailable', 503, request, env, 'AI context is temporarily unavailable')
    }
    const language = aiLanguage(data.language || data.lang, request)
    let output = ''
    let quota
    if (env.AI?.run) {
        const charged = await aiQuota(request, env, userId)
        if (charged.response) return charged.response
        quota = charged.quota
        try {
            const result = await runWorkersAi(env, [
                { role: 'system', content: `Return JSON only in ${language}. Use only the supplied authorized Bookmark and candidate IDs/tags.` },
                { role: 'user', content: JSON.stringify({ task: 'suggest_collection_and_tags', bookmark: context.items?.[0] || bookmark, candidates }) }
            ])
            output = await aiCollectText(result)
        } catch {
            if (!legacy) return error('ai_provider_unavailable', 503, request, env, 'Workers AI is temporarily unavailable. Retry the request.')
        }
    } else if (!legacy) {
        return error('ai_provider_unavailable', 503, request, env, 'Workers AI is temporarily unavailable. Retry the request.')
    }
    const suggestions = output ? aiSuggestionResult(output, candidates, bookmark) : aiFallbackSuggestions(candidates, bookmark)
    const item = {
        collections: suggestions.collections.map(collection => ({ $id: collection.id })),
        tags: suggestions.tags,
        new_tags: suggestions.newTags
    }
    return json({
        result: true,
        language,
        suggestions,
        ...(legacy ? { item } : {}),
        sources: context.sources || [],
        ...(quota ? { quota: { ...quota, resetAt: new Date(quota.resetAt).toISOString() } } : {})
    }, 200, request, env)
}

const aiDescriptionDraft = async (request, env, userId) => {
    const { data: rawData } = await readBody(request)
    const data = rawData && typeof rawData === 'object' ? rawData : {}
    const value = data.raindropId
    const context = await aiBookmarkContext(env, userId, value)
    if (context.error || !context.items.length) return error('bookmark_not_found', 404, request, env, 'Bookmark was not found')
    if (!env.AI?.run) return error('ai_provider_unavailable', 503, request, env, 'Workers AI is temporarily unavailable. Retry the request.')
    const charged = await aiQuota(request, env, userId)
    if (charged.response) return charged.response
    const language = aiLanguage(data.language || data.lang, request)
    try {
        const result = await runWorkersAi(env, [
            { role: 'system', content: `Write one concise Bookmark description in ${language}. Return only the proposed description text. Do not change any Bookmark.` },
            { role: 'user', content: context.text }
        ])
        const draft = (await aiCollectText(result)).slice(0, 10000).trim()
        if (!draft) return error('ai_provider_unavailable', 503, request, env, 'Workers AI returned an empty description')
        return json({ result: true, language, draft, sources: context.sources, quota: { ...charged.quota, resetAt: new Date(charged.quota.resetAt).toISOString() } }, 200, request, env)
    } catch {
        return error('ai_provider_unavailable', 503, request, env, 'Workers AI is temporarily unavailable. Retry the request.')
    }
}

const aiMessageText = value => {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (typeof value !== 'object') return ''
    const choice = value.choices?.[0]
    return aiMessageText(value.response ?? value.delta ?? value.text ?? value.token ?? value.content
        ?? choice?.delta?.content ?? choice?.message?.content ?? '')
}

const aiResultEvent = value => {
    if (typeof value === 'string' || typeof value === 'number') return { delta: String(value) }
    if (!value || typeof value !== 'object') return { delta: '' }
    const tool = value.toolCalled || value.tool_called
    return {
        delta: aiMessageText(value),
        ...(tool ? { toolCalled: tool } : {})
    }
}

const parseAiLine = line => {
    let value = String(line || '').trim()
    if (!value || value === '[DONE]' || value.startsWith(':') || value.startsWith('event:')) return null
    if (value.startsWith('data:')) value = value.slice(5).trim()
    if (!value || value === '[DONE]') return null
    try { return aiResultEvent(JSON.parse(value)) } catch { return { delta: value } }
}

async function* aiResultChunks(result) {
    if (result?.body?.getReader || result?.getReader) {
        const reader = (result.body || result).getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let next = await reader.read()
        while (!next.done) {
            buffer += decoder.decode(next.value, { stream: true })
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() || ''
            for (const line of lines) {
                const event = parseAiLine(line)
                if (event?.delta || event?.toolCalled) yield event
            }
            next = await reader.read()
        }
        buffer += decoder.decode()
        const event = parseAiLine(buffer)
        if (event?.delta || event?.toolCalled) yield event
        return
    }
    if (result && typeof result[Symbol.asyncIterator] === 'function') {
        for await (const chunk of result) {
            const event = aiResultEvent(chunk)
            if (event.delta || event.toolCalled) yield event
        }
        return
    }
    const event = aiResultEvent(result)
    if (event.delta || event.toolCalled) yield event
}

const runWorkersAi = async (env, messages) => {
    if (!env.AI || typeof env.AI.run !== 'function') throw new Error('Workers AI binding is unavailable')
    const result = await env.AI.run(aiModel(env), { messages, stream: true })
    if (!result || result.ok === false || result.error || result.errors?.length) throw new Error('Workers AI provider failed')
    return result
}

const aiEvent = value => 'data: ' + JSON.stringify(value) + '\n\n'

const confirmedAiTool = (value, context) => {
    if (!value || typeof value !== 'object' || value.name !== 'bookmark_refresh') return null
    const raindropId = Number(value.raindropId)
    return context.sources.some(source => Number(source.raindropId) === raindropId)
        ? { name: value.name, raindropId }
        : null
}

const aiAuth = async (request, env) => {
    if (!authReady(env)) return { response: configurationError(request, env) }
    const session = await getSession(request, env)
    if (session) return { session }
    return {
        response: json({
            result: false,
            auth: false,
            error: 'auth_required',
            errorMessage: 'Login is required',
            login: new URL('/account/login', env.APP_ORIGIN || request.url).toString()
        }, 401, request, env)
    }
}

const aiRoute = async (request, env, url) => {
    const auth = await aiAuth(request, env)
    if (auth.response) return auth.response
    const { user_id: userId } = auth.session

    if (url.pathname === '/v2/ai/config' && request.method === 'GET') {
        const quota = await readAiQuota(env, userId)
        if (quota.error)
            return error(quota.error, 503, request, env, 'AI quota is temporarily unavailable. Retry the request.')
        return json({
            result: true,
            provider: 'workers_ai',
            model: aiModel(env),
            available: Boolean(env.AI?.run),
            aiPageOrigin: env.AI_PAGE_ORIGIN || null,
            quota: { ...quota, resetAt: new Date(quota.resetAt).toISOString() }
        }, 200, request, env)
    }

    if (url.pathname === '/v2/ai/quota' && request.method === 'GET') {
        const quota = await readAiQuota(env, userId)
        if (quota.error)
            return error(quota.error, 503, request, env, 'AI quota is temporarily unavailable. Retry the request.')
        return json({ result: true, quota: { ...quota, resetAt: new Date(quota.resetAt).toISOString() } }, 200, request, env)
    }

    if (url.pathname === '/v2/ai/context' && request.method === 'GET') {
        const value = url.searchParams.get('raindropId')
        const context = await aiBookmarkContext(env, userId, value)
        if (context.error || !context.items.length) return error('bookmark_not_found', 404, request, env, 'Bookmark was not found')
        const aiPackage = { bookmarks: context.items, sources: context.sources }
        return json({ result: true, package: aiPackage, sources: context.sources }, 200, request, env)
    }

    if (url.pathname === '/v2/ai/suggestions' && request.method === 'POST')
        return aiSuggestions(request, env, userId)

    if (url.pathname === '/v2/ai/description-draft' && request.method === 'POST')
        return aiDescriptionDraft(request, env, userId)

    const chatMatch = url.pathname.match(/^\/v2\/ai\/(?:chats|history)\/([^/]+)$/)
    if (chatMatch && request.method === 'GET') {
        try {
            const items = await listAiHistory(env, userId, decodeURIComponent(chatMatch[1]))
            if (!items.length) return error('ai_chat_not_found', 404, request, env, 'AI chat was not found')
            return json({ result: true, chat: items[0], item: items[0] }, 200, request, env)
        } catch {
            return error('ai_history_unavailable', 503, request, env, 'AI history is temporarily unavailable')
        }
    }

    if (chatMatch && request.method === 'DELETE') {
        try {
            const deleted = await deleteAiChat(env, userId, decodeURIComponent(chatMatch[1]))
            if (!deleted) return error('ai_chat_not_found', 404, request, env, 'AI chat was not found')
            await recordAudit(env, request, { userId, action: 'ai.history_deleted', resourceType: 'ai_chat', resourceId: decodeURIComponent(chatMatch[1]), outcome: 'success' })
            return json({ result: true, deleted: 1 }, 200, request, env)
        } catch {
            return error('ai_history_unavailable', 503, request, env, 'AI history is temporarily unavailable')
        }
    }

    if ((url.pathname === '/v2/ai/history' || url.pathname === '/v2/ai/chats') && request.method === 'GET') {
        try {
            const chatId = url.searchParams.get('chatId')
            const items = await listAiHistory(env, userId, chatId)
            return json({ result: true, items }, 200, request, env)
        } catch {
            return error('ai_history_unavailable', 503, request, env, 'AI history is temporarily unavailable')
        }
    }

    if (url.pathname === '/v2/ai/history' || url.pathname === '/v2/ai/chats') {
        if (request.method === 'DELETE') {
            try {
                const chatId = url.searchParams.get('chatId')
                const deleted = chatId ? Number(await deleteAiChat(env, userId, chatId)) : await deleteAiHistory(env, userId)
                if (chatId && !deleted) return error('ai_chat_not_found', 404, request, env, 'AI chat was not found')
                await recordAudit(env, request, { userId, action: 'ai.history_deleted', resourceType: 'ai_chat', outcome: 'success' })
                return json({ result: true, deleted: chatId ? 1 : deleted }, 200, request, env)
            } catch {
                return error('ai_history_unavailable', 503, request, env, 'AI history is temporarily unavailable')
            }
        }
        if (url.pathname === '/v2/ai/chats' && request.method === 'POST') return aiChat(request, env, userId)
    }

    if (url.pathname === '/v2/ai/chat' && request.method === 'POST')
        return aiChat(request, env, userId)

    return error('route_not_implemented', 404, request, env)
}

const aiChat = async (request, env, userId) => {
    const { data: rawData } = await readBody(request)
    const data = rawData && typeof rawData === 'object' ? rawData : {}
    const suppliedMessages = Array.isArray(data.messages) ? data.messages : []
    const lastSuppliedMessage = suppliedMessages.filter(item => item?.role === 'user').at(-1)?.content
    const message = String(data.message || data.prompt || lastSuppliedMessage || '').trim()
    if (!message || message.length > aiMessageLimit)
        return error('validation_failed', 400, request, env, 'Enter a message up to 8,000 characters')

    const requestedChatId = String(data.chatId || '').trim()
    const now = Date.now()
    let chat
    try {
        chat = requestedChatId ? await selectAiChat(env, userId, requestedChatId) : null
        if (requestedChatId && !chat)
            return error('ai_chat_not_found', 404, request, env, 'AI chat was not found')
        const context = await aiBookmarkContext(env, userId, data.raindropId ?? data.bookmarkId, message)
        if (context.error)
            return error(context.error, 404, request, env, 'Bookmark was not found')
        if (!env.AI || typeof env.AI.run !== 'function')
            return error('ai_provider_unavailable', 503, request, env, 'Workers AI is temporarily unavailable. Retry the request.')
        const quota = await consumeAiQuota(env, request, userId)
        if (quota.error)
            return error(quota.error, 503, request, env, 'AI quota is temporarily unavailable. Retry the request.')
        if (!quota.allowed)
            return retryableError('ai_quota_exceeded', request, env, 'Daily AI quota reached. Retry after the quota resets.', quota.retryAfterMs, {
                quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining, resetAt: new Date(quota.resetAt).toISOString(), global: quota.global, scope: quota.scope },
                resetAt: new Date(quota.resetAt).toISOString(),
                retryAt: new Date(quota.resetAt).toISOString()
            })

        if (!chat) {
            chat = { id: aiChatId(), user_id: userId, title: message.slice(0, 120), created_at: now, updated_at: now }
            await env.DB.prepare('INSERT INTO ai_chats (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
                .bind(chat.id, userId, chat.title, now, now).run()
        }
        const prior = (await env.DB.prepare(`SELECT role, content FROM ai_messages WHERE chat_id = ? AND user_id = ?
            ORDER BY created_at DESC LIMIT ?`).bind(chat.id, userId, aiHistoryLimit * 2).all()).results || []
        const history = []
        let historyChars = 0
        const contextLimit = Number(env.AI_CONTEXT_MAX_CHARS) || 12000
        for (const item of prior) {
            const content = String(item.content || '')
            if (historyChars + content.length > contextLimit) break
            history.unshift({ role: item.role, content })
            historyChars += content.length
        }
        const language = aiLanguage(data.language || data.lang, request)
        const prompt = context.text ? message + '\n\n' + context.text : message
        const messages = [{ role: 'system', content: `You are Raindrop AI. Answer in ${language}. Use only the authorized context provided. When context supports an answer, cite the matching Bookmark as [Title](URL).` }, ...history, { role: 'user', content: prompt }]
        await env.DB.prepare('INSERT INTO ai_messages (chat_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(chat.id, userId, 'user', message, now).run()
        const result = await runWorkersAi(env, messages)
        const encoderStream = new TextEncoder()
        const stream = new ReadableStream({
            start(controller) {
                const enqueue = value => {
                    try { controller.enqueue(encoderStream.encode(value)) } catch {}
                }
                enqueue(aiEvent({ chatId: chat.id, sources: context.sources, citations: context.sources }))
                ;(async () => {
                    let assistant = ''
                    try {
                        for await (const event of aiResultChunks(result)) {
                            const toolCalled = confirmedAiTool(event.toolCalled, context)
                            if (toolCalled)
                                enqueue(aiEvent({ chatId: chat.id, toolCalled }))
                            if (event.delta) {
                                assistant += event.delta
                                enqueue(aiEvent({ chatId: chat.id, delta: event.delta }))
                            }
                        }
                        if (assistant)
                            await env.DB.prepare('INSERT INTO ai_messages (chat_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
                                .bind(chat.id, userId, 'assistant', assistant, Date.now()).run()
                        await env.DB.prepare('UPDATE ai_chats SET updated_at = ? WHERE id = ? AND user_id = ?')
                            .bind(Date.now(), chat.id, userId).run()
                        await recordAudit(env, request, { userId, action: 'ai.chat', resourceType: 'ai_chat', resourceId: chat.id, outcome: 'success' })
                        enqueue(aiEvent({ chatId: chat.id, done: true, sources: context.sources, citations: context.sources, quota: { ...quota, resetAt: new Date(quota.resetAt).toISOString() } }))
                    } catch {
                        await recordAudit(env, request, { userId, action: 'ai.chat', resourceType: 'ai_chat', resourceId: chat.id, outcome: 'failed' })
                        enqueue(aiEvent({ chatId: chat.id, error: 'ai_provider_unavailable', errorMessage: 'Workers AI is temporarily unavailable. Retry the request.' }))
                    } finally {
                        try { controller.close() } catch {}
                    }
                })()
            }
        })
        const headers = addCorsHeaders(new Headers({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'X-AI-Chat-ID': chat.id,
            'X-Request-ID': requestId(request)
        }), request, env)
        return new Response(stream, { status: 200, headers })
    } catch {
        await recordAudit(env, request, { userId, action: 'ai.chat', resourceType: 'ai_chat', outcome: 'failed' })
        return error('ai_provider_unavailable', 503, request, env, 'Workers AI is temporarily unavailable. Retry the request.')
    }
}

const readUsage = async (env, userId) => {
    const limit = usageLimit(env)
    const { windowStart, resetAt } = usageWindow(Date.now())
    try {
        const row = await env.DB.prepare('SELECT units FROM usage_counters WHERE user_id = ? AND window_start = ?').bind(userId, windowStart).first()
        const used = Number(row?.units || 0)
        return { used, limit, remaining: Math.max(0, limit - used), resetAt }
    } catch {
        return { used: 0, limit, remaining: limit, resetAt }
    }
}

const consumeUsage = async (env, request, userId) => {
    const limit = usageLimit(env)
    const now = Date.now()
    const { windowStart, resetAt } = usageWindow(now)
    const units = 1
    try {
        const current = await env.DB.prepare('SELECT units FROM usage_counters WHERE user_id = ? AND window_start = ?').bind(userId, windowStart).first()
        const previous = Number(current?.units || 0)
        const result = await env.DB.prepare(`INSERT INTO usage_counters (user_id, window_start, units, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, window_start) DO UPDATE SET units = units + excluded.units, updated_at = excluded.updated_at
            WHERE usage_counters.units + excluded.units <= ?`).bind(userId, windowStart, units, now, limit).run()
        if (Number(result?.meta?.changes || 0) !== 1) {
            const retryAfterMs = resetAt - now
            await recordAudit(env, request, { userId, action: 'usage.quota_exceeded', resourceType: 'quota', outcome: 'blocked' })
            await recordAlert(env, request, { userId, kind: 'usage_quota_exceeded', severity: 'warning', metadata: { limit, used: previous, retryAfter: Math.ceil(retryAfterMs / 1000) } })
            return { allowed: false, used: previous, limit, remaining: 0, resetAt, retryAfterMs }
        }

        const used = previous + units
        const threshold = Math.max(1, Math.ceil(limit * 0.8))
        if (previous < threshold && used >= threshold)
            await recordAlert(env, request, { userId, kind: 'usage_quota_threshold', metadata: { limit, used, remaining: Math.max(0, limit - used) } })
        return { allowed: true, used, limit, remaining: Math.max(0, limit - used), resetAt }
    } catch {
        return { allowed: true, used: 0, limit, remaining: limit, resetAt }
    }
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
    pathname.startsWith('/v1/collaborators/') ||
    pathname.includes('/sharing') ||
    pathname.startsWith('/v1/backup') ||
    pathname.includes('/export.') ||
    pathname === '/v1/import' || pathname.startsWith('/v1/import/') ||
    pathname.includes('/capture') ||
    pathname.includes('/content') ||
    pathname.endsWith('/raindrop/file')

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

const googleAuthorization = (env, state, drive = false) => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: googleCallbackUrl(env),
        response_type: 'code',
        scope: 'openid email profile' + (drive ? ' https://www.googleapis.com/auth/drive.file' : ''),
        state,
        prompt: drive ? 'consent select_account' : 'select_account',
        ...(drive ? { access_type: 'offline', include_granted_scopes: 'true' } : {})
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
        return {
            subject: String(data.sub),
            email: String(data.email).toLowerCase(),
            name: String(data.name || data.email).slice(0, 100),
            accessToken: String(token.access_token),
            refreshToken: token.refresh_token ? String(token.refresh_token) : null,
            expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
        }
    } catch {
        return null
    }
}

const hasSharedCollections = (env, userId) => env.DB.prepare(`SELECT 1 FROM collection_collaborators cc
    JOIN collections c ON c.id = cc.collection_id
    WHERE c.user_id = ? AND cc.user_id != ? LIMIT 1`).bind(userId, userId).first()

const deleteBackups = async (env, userId) => {
    try {
        const rows = await env.DB.prepare('SELECT object_key FROM backups WHERE user_id = ?').bind(userId).all()
        if (env.BACKUP_BUCKET?.delete)
            for (const row of rows.results || []) {
                try { await env.BACKUP_BUCKET.delete(row.object_key) } catch {}
            }
        await env.DB.prepare('DELETE FROM backups WHERE user_id = ?').bind(userId).run()
    } catch {}
}

const deleteUserData = async (env, userId) => {
    let bookmarkIds = []
    try {
        const rows = await env.DB.prepare('SELECT id FROM bookmarks WHERE user_id = ?').bind(userId).all()
        bookmarkIds = (rows.results || []).map(item => Number(item.id)).filter(Number.isSafeInteger)
    } catch {}
    await deleteContentObjects(env, userId, bookmarkIds)
    await deleteBackups(env, userId)
    const statements = [
        env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM connected_identities WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM oauth_states WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM published_snapshots WHERE published_by = ? OR bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)').bind(userId, userId),
        env.DB.prepare('DELETE FROM collection_invitations WHERE invited_by = ? OR collection_id IN (SELECT id FROM collections WHERE user_id = ?)').bind(userId, userId),
        env.DB.prepare('DELETE FROM collection_collaborators WHERE collection_id IN (SELECT id FROM collections WHERE user_id = ?) OR user_id = ?').bind(userId, userId),
        env.DB.prepare('DELETE FROM migration_mappings WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM migration_archives WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM background_tasks WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM content_objects WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM bookmark_changes WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM collections WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM account_deletions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM usage_counters WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM ai_messages WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM ai_chats WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM ai_usage_counters WHERE user_id = ?').bind(userId),
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

const purgeAccounting = async env => {
    if (!env.DB?.prepare) return
    const now = Date.now()
    try {
        await env.DB.prepare('DELETE FROM usage_counters WHERE window_start < ?').bind(now - usageWindowMs * 2).run()
        await env.DB.prepare('DELETE FROM ai_usage_counters WHERE window_start < ?').bind(now - usageWindowMs * 2).run()
        await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - rateWindowMs * 2).run()
        await env.DB.prepare('DELETE FROM audit_records WHERE created_at < ?').bind(now - 365 * usageWindowMs).run()
        await env.DB.prepare('DELETE FROM alerts WHERE created_at < ?').bind(now - 365 * usageWindowMs).run()
    } catch {
        // Accounting tables may not exist while an environment is migrating.
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

        const publicContentMatch = url.pathname.match(/^\/(?:v1\/)?public\/content\/([^/]+)$/)
        if (publicContentMatch && ['GET', 'HEAD'].includes(request.method)) {
            const content = await selectPublishedContent(env, decodeURIComponent(publicContentMatch[1]))
            if (!content || !env.CONTENT_BUCKET?.get)
                return error('content_not_found', 404, request, env)
            const object = await env.CONTENT_BUCKET.get(content.object_key)
            if (!object) return error('content_not_found', 404, request, env)
            const headers = addCorsHeaders(new Headers({
                'Content-Type': content.content_type || object.httpMetadata?.contentType || 'application/octet-stream',
                'Content-Length': String(content.size_bytes || object.size || 0),
                'Content-Disposition': 'inline; filename="' + safeFilename(content.filename) + '"',
                'Cache-Control': 'no-store',
                'X-Request-ID': requestId(request)
            }), request, env)
            return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
        }

        const publicCollectionMatch = url.pathname.match(/^\/(?:v1\/)?public\/collections?\/(\d+)(?:\/([^/]+))?$/)
        const publicLegacyMatch = url.pathname.match(/^\/public\/([^/]+)-(\d+)$/)
        if ((publicCollectionMatch || publicLegacyMatch) && request.method === 'GET') {
            const collectionId = Number(publicCollectionMatch?.[1] || publicLegacyMatch?.[2])
            const suppliedSlug = decodeURIComponent(publicCollectionMatch?.[2] || publicLegacyMatch?.[1] || '')
            const payload = await publicCollectionPayload(env, collectionId, suppliedSlug)
            return payload ? json(payload, 200, request, env) : error('collection_not_found', 404, request, env)
        }

        if (url.pathname.startsWith('/v2/ai/'))
            return aiRoute(request, env, url)

        if (url.pathname.startsWith('/v1/')) {
            const rateSession = authReady(env) ? await getSession(request, env) : null
            const limited = await rateLimit(request, env, url, rateSession?.user_id)
            if (limited) return limited
        }

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
                return appRedirect(request, env, state.purpose === 'backup_gdrive'
                    ? '/settings/backups?connect_error=google_drive_authorization_failed'
                    : state.purpose === 'connect' ? '/settings/account?connect_error=google_sign_in_failed' : '/account/login?error=google_sign_in_failed')

            if (state.purpose === 'backup_gdrive') {
                if (!state.user_id || !profile.refreshToken)
                    return appRedirect(request, env, '/settings/backups?connect_error=google_drive_authorization_failed')
                const credentials = { accessToken: profile.accessToken, refreshToken: profile.refreshToken, expiresAt: profile.expiresAt }
                try {
                    await verifyBackupConnection(env, 'gdrive', credentials)
                    const currentDefault = await env.DB.prepare('SELECT id FROM backup_connections WHERE user_id = ? AND is_default = 1')
                        .bind(state.user_id).first()
                    await saveBackupConnection(env, state.user_id, 'gdrive', credentials, !currentDefault)
                } catch {
                    return appRedirect(request, env, '/settings/backups?connect_error=google_drive_authorization_failed')
                }
                return appRedirect(request, env, '/settings/backups?connected=gdrive')
            }

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

            await recordAudit(env, request, { userId, action: 'user.signup', resourceType: 'user', resourceId: userId, outcome: 'success' })
            return json({ result: true, email, verified: false }, 201, request, env)
        }

        if (url.pathname === '/v1/auth/email/login' && request.method === 'POST') {
            if (!authReady(env)) return configurationError(request, env)
            const { data, form } = await readBody(request)
            const email = String(data.email || '').trim().toLowerCase()
            const password = String(data.password || '')
            const user = await env.DB.prepare('SELECT id, email, name, password_hash, password_salt, email_verified_at FROM users WHERE email = ?').bind(email).first()

            const validPassword = user && equal(await passwordHash(password, base64urlToBytes(user.password_salt)), user.password_hash)
            if (!validPassword) {
                await recordAudit(env, request, { userId: user?.id || null, action: 'auth.login', resourceType: 'session', outcome: 'failed' })
                await recordAlert(env, request, { userId: user?.id || null, kind: 'login_anomaly', metadata: { reason: 'invalid_credentials' } })
                return form ? loginErrorPage(request, env, 'Email or password is invalid') : error('invalid_credentials', 401, request, env, 'Email or password is invalid')
            }

            const session = await createSession(request, env, user.id)
            await recordAudit(env, request, { userId: user.id, action: 'auth.login', resourceType: 'session', outcome: 'success' })
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
                await recordAudit(env, request, { userId: session.user_id, action: all ? 'auth.logout_all' : 'auth.logout', resourceType: 'session', outcome: 'success' })
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

            if (!['GET', 'HEAD'].includes(request.method)) {
                const usage = await consumeUsage(env, request, session.user_id)
                if (!usage.allowed)
                    return retryableError('usage_quota_exceeded', request, env, 'Daily usage quota reached. Retry after the quota resets.', usage.retryAfterMs, {
                        quota: {
                            used: usage.used,
                            limit: usage.limit,
                            remaining: usage.remaining,
                            resetAt: new Date(usage.resetAt).toISOString()
                        },
                        retryAt: new Date(usage.resetAt).toISOString()
                    })
            }

            const legacySuggestions = url.pathname.match(/^\/v1\/raindrop(?:\/(\d+))?\/suggest$/)
            if (legacySuggestions && ['GET', 'POST'].includes(request.method))
                return aiSuggestions(request, env, session.user_id, { legacy: true, bookmarkId: legacySuggestions[1] })

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
                    await recordAudit(env, request, { userId: session.user_id, action: 'account.deletion_scheduled', resourceType: 'account', outcome: 'success' })
                    return json({ result: true, purge_after: purgeAfter }, 202, request, env)
                }
                if (request.method === 'DELETE') {
                    const result = await env.DB.prepare('DELETE FROM account_deletions WHERE user_id = ?').bind(session.user_id).run()
                    await recordAudit(env, request, { userId: session.user_id, action: 'account.deletion_cancelled', resourceType: 'account', outcome: result.meta.changes ? 'success' : 'not_found' })
                    return json({ result: true, cancelled: Boolean(result.meta.changes) }, 200, request, env)
                }
            }

            if (url.pathname === '/v1/user' && request.method === 'GET')
                return json({ result: true, user: publicUser(session) }, 200, request, env)

            if (url.pathname === '/v1/user/quota' && request.method === 'GET') {
                const usage = await readUsage(env, session.user_id)
                return json({ result: true, quota: {
                    used: usage.used,
                    limit: usage.limit,
                    remaining: usage.remaining,
                    resetAt: new Date(usage.resetAt).toISOString()
                } }, 200, request, env)
            }

            const exportMatch = url.pathname.match(/^\/v1\/raindrops\/(-?\d+)\/export\.(html|csv|txt|zip)$/)
            if (exportMatch && request.method === 'GET') {
                const spaceId = Number(exportMatch[1])
                if (spaceId < -1)
                    return error('validation_failed', 400, request, env, 'Export supports active Bookmarks only')
                if (spaceId > 0 && !await collectionRole(env, session.user_id, spaceId))
                    return error('collection_not_found', 404, request, env)
                const format = exportMatch[2]
                let data
                try {
                    data = await exportData(env, session.user_id, {
                        spaceId,
                        url,
                        includeContent: format === 'zip'
                    })
                } catch (failure) {
                    const status = failure?.status === 413 ? 413 : 503
                    return error(failure?.code || 'export_unavailable', status, request, env,
                        status === 413 ? failure.message : 'The export could not be created')
                }
                await recordAudit(env, request, { userId: session.user_id, action: 'export.download', resourceType: 'export', resourceId: format, outcome: 'success' })
                return exportResponse(request, env, format, data)
            }

            if (url.pathname === '/v1/backup' && ['GET', 'POST'].includes(request.method)) {
                let backup
                try { backup = await createBackup(env, session.user_id, 'manual', null, request) } catch {}
                if (!backup)
                    return error('backup_unavailable', 503, request, env, 'The backup could not be queued')
                const status = backup.status === 'failed' ? 503 : 202
                return json({
                    result: status === 202,
                    id: String(backup.id),
                    status: backup.status,
                    backup: publicBackup(backup),
                    backupId: String(backup.id),
                    taskId: String(backup.id)
                }, status, request, env)
            }

            if (url.pathname === '/v1/backup/connections') {
                if (request.method === 'GET') {
                    const rows = await env.DB.prepare(`SELECT id, provider, is_default, verified_at
                        FROM backup_connections WHERE user_id = ? ORDER BY provider`).bind(session.user_id).all()
                    return json({ result: true, connections: (rows.results || []).map(publicBackupConnection) }, 200, request, env)
                }
                if (request.method === 'POST') {
                    const { data } = await readBody(request)
                    const provider = String(data.provider || '')
                    if (!backupProviders.has(provider))
                        return error('validation_failed', 400, request, env, 'Choose Google Drive, OneDrive, or WebDAV')
                    let credentials
                    try {
                        credentials = backupConnectionCredentials(provider, data.credentials)
                        await verifyBackupConnection(env, provider, credentials)
                    } catch (failure) {
                        return error('backup_connection_failed', 400, request, env, failure.message)
                    }
                    const saved = await saveBackupConnection(env, session.user_id, provider, credentials, data.default === true)
                    return json({ result: true, connection: publicBackupConnection(saved) }, 201, request, env)
                }
            }

            if (url.pathname === '/v1/backup/connections/gdrive/authorize' && request.method === 'GET') {
                if (!googleReady(env)) return configurationError(request, env)
                const state = await createGoogleState(env, 'backup_gdrive', session.user_id, '/settings/backups')
                return new Response(null, { status: 302, headers: {
                    Location: googleAuthorization(env, state, true),
                    'X-Request-ID': requestId(request)
                } })
            }

            const connectionMatch = url.pathname.match(/^\/v1\/backup\/connections\/([^/]+)(?:\/(default))?$/)
            if (connectionMatch) {
                const id = decodeURIComponent(connectionMatch[1])
                if (request.method === 'POST' && connectionMatch[2]) {
                    const connection = await env.DB.prepare('SELECT id FROM backup_connections WHERE id = ? AND user_id = ?')
                        .bind(id, session.user_id).first()
                    if (!connection) return error('backup_connection_not_found', 404, request, env)
                    await env.DB.prepare('UPDATE backup_connections SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?')
                        .bind(id, session.user_id).run()
                    return json({ result: true }, 200, request, env)
                }
            }

            if (url.pathname === '/v1/backups' && request.method === 'GET') {
                const rows = await env.DB.prepare(`SELECT id, user_id, kind, period_key, status, object_key, size_bytes,
                    error_code, error_message, created_at, updated_at, completed_at
                    FROM backups WHERE user_id = ? AND status = 'succeeded' ORDER BY created_at DESC`).bind(session.user_id).all()
                return json({ result: true, items: (rows.results || []).map(publicBackup) }, 200, request, env)
            }

            const backupStatusMatch = url.pathname.match(/^\/v1\/(?:backups|backup)\/([^/.]+)(?:\/status)?$/)
            if (backupStatusMatch && request.method === 'GET') {
                const backup = await selectBackup(env, decodeURIComponent(backupStatusMatch[1]), session.user_id)
                if (!backup) return error('backup_not_found', 404, request, env)
                return json({ result: true, backup: publicBackup(backup) }, 200, request, env)
            }

            const backupDownloadMatch = url.pathname.match(/^\/v1\/(?:backups|backup)\/([^/]+)\.(html|csv|txt|zip)$/)
            if (backupDownloadMatch && request.method === 'GET') {
                const backupId = decodeURIComponent(backupDownloadMatch[1])
                const backup = await selectBackup(env, backupId, session.user_id)
                if (!backup) return error('backup_not_found', 404, request, env)
                if (backup.status !== 'succeeded')
                    return error('backup_pending', 409, request, env, 'The backup is not ready for download')
                let snapshot
                try { snapshot = await readBackupSnapshot(env, backup) } catch {
                    return error('backup_unavailable', 503, request, env, 'The backup could not be read')
                }
                if (!snapshot) return error('backup_not_found', 404, request, env)
                return exportResponse(request, env, backupDownloadMatch[2], snapshot, 'raindrop-backup-' + backupId)
            }

            if (url.pathname === '/v1/import/preflight' && request.method === 'POST') {
                let archive
                try { archive = await readMigrationArchive(request, env) } catch (failure) {
                    const details = taskFailureDetails(failure)
                    const status = failure?.code === 'migration_too_large' ? 413 : 400
                    return error(details.code, status, request, env, details.message)
                }
                let duplicates
                try { duplicates = await migrationDuplicateItems(env, session.user_id, archive) } catch {
                    return error('migration_preflight_failed', 503, request, env, 'The migration archive could not be reviewed')
                }
                const archiveId = randomToken(18)
                const now = Date.now()
                const total = archive.collections.length + archive.bookmarks.length + archive.assets.length
                await env.DB.prepare(`INSERT INTO migration_archives
                    (id, user_id, source, archive_json, preflight_json, review_json, status,
                     collection_count, bookmark_count, asset_count, total_items, completed_items, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, '{}', 'review', ?, ?, ?, ?, 0, ?, ?)`)
                    .bind(archiveId, session.user_id, archive.source, JSON.stringify(archive), JSON.stringify({ duplicates }),
                        archive.collections.length, archive.bookmarks.length, archive.assets.length, total, now, now).run()
                await recordAudit(env, request, { userId: session.user_id, action: 'migration.preflight', resourceType: 'migration_archive', resourceId: archiveId, outcome: 'success' })
                const review = migrationReviewItems({ duplicates }, {})
                const preflight = {
                    archiveId,
                    source: archive.source,
                    counts: { collections: archive.collections.length, bookmarks: archive.bookmarks.length, assets: archive.assets.length, total, duplicates: review.length },
                    duplicates: review,
                    unresolvedDuplicates: review.length
                }
                return json({ result: true, archiveId, status: 'review', preflight, duplicates: review }, 201, request, env)
            }

            if (url.pathname === '/v1/import' && request.method === 'GET') {
                const rows = await env.DB.prepare(`SELECT id, user_id, source, archive_json, preflight_json, review_json, status,
                    collection_count, bookmark_count, asset_count, total_items, completed_items, task_id, error_code, error_message,
                    created_at, updated_at FROM migration_archives WHERE user_id = ? ORDER BY created_at DESC`).bind(session.user_id).all()
                const items = []
                for (const row of rows.results || []) items.push(await migrationOutput(env, row))
                return json({ result: true, items }, 200, request, env)
            }

            const importMatch = url.pathname.match(/^\/v1\/import\/([^/]+)(?:\/(review|commit|status|retry|mappings))?$/)
            if (importMatch) {
                const archiveId = decodeURIComponent(importMatch[1])
                const action = importMatch[2] || 'status'
                const archiveRow = await selectMigrationArchive(env, archiveId, session.user_id)
                if (!archiveRow) return error('migration_not_found', 404, request, env, 'Migration archive was not found')

                if (action === 'status' && request.method === 'GET') {
                    const task = archiveRow.task_id ? await selectTask(env, archiveRow.task_id, session.user_id) : null
                    const output = await migrationOutput(env, archiveRow, task)
                    return json({ result: true, ...output, migration: output }, 200, request, env)
                }

                if (action === 'mappings' && request.method === 'GET') {
                    const rows = await env.DB.prepare(`SELECT source_type, source_id, resource_type, resource_id, decision, created_at
                        FROM migration_mappings WHERE archive_id = ? AND user_id = ? ORDER BY id`).bind(archiveId, session.user_id).all()
                    const items = (rows.results || []).map(item => ({
                        sourceType: item.source_type,
                        sourceId: String(item.source_id),
                        resourceType: item.resource_type,
                        resourceId: item.resource_type === 'content' ? String(item.resource_id) : Number(item.resource_id),
                        decision: item.decision || 'keep',
                        createdAt: taskDate(item.created_at)
                    }))
                    return json({ result: true, archiveId, items, mappings: items }, 200, request, env)
                }

                if (action === 'review' && request.method === 'POST') {
                    if (archiveRow.status !== 'review')
                        return error('migration_not_reviewable', 409, request, env, 'The migration archive is no longer awaiting review')
                    const { data } = await readBody(request)
                    const supplied = data.decisions ?? data.review ?? data.duplicates ?? {}
                    const entries = Array.isArray(supplied)
                        ? supplied.map(item => [item?.sourceId ?? item?.source_id ?? item?.id, item?.decision ?? item?.action ?? item?.keep])
                        : Object.entries(supplied || {}).map(([key, value]) => [key.replace(/^bookmark:/, ''), value])
                    const allowed = new Set((parseTaskMetadata(archiveRow.preflight_json).duplicates || []).map(item => item.sourceId))
                    const decisions = parseMigrationDecisions(archiveRow.review_json)
                    for (const [sourceId, value] of entries) {
                        const id = String(sourceId || '').trim()
                        const decision = migrationDecision(value)
                        if (!id || !allowed.has(id) || !decision)
                            return error('validation_failed', 400, request, env, 'Provide keep or skip for every duplicate source')
                        decisions['bookmark:' + id] = decision
                    }
                    await env.DB.prepare('UPDATE migration_archives SET review_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = \'review\'')
                        .bind(JSON.stringify({ decisions }), Date.now(), archiveId, session.user_id).run()
                    const duplicates = migrationReviewItems(parseTaskMetadata(archiveRow.preflight_json), decisions)
                    await recordAudit(env, request, { userId: session.user_id, action: 'migration.review', resourceType: 'migration_archive', resourceId: archiveId, outcome: 'success' })
                    return json({ result: true, archiveId, status: 'review', duplicates, unresolvedDuplicates: duplicates.filter(item => !item.decision).length }, 200, request, env)
                }

                if (action === 'commit' && request.method === 'POST') {
                    const decisions = parseMigrationDecisions(archiveRow.review_json)
                    const duplicates = migrationReviewItems(parseTaskMetadata(archiveRow.preflight_json), decisions)
                    if (duplicates.some(item => !item.decision))
                        return error('duplicate_review_required', 409, request, env, 'Review every duplicate before importing')
                    if (['queued', 'processing', 'retrying'].includes(archiveRow.status) && archiveRow.task_id) {
                        const task = await selectTask(env, archiveRow.task_id, session.user_id)
                        if (task && task.status !== 'dead_letter')
                            return json({ result: true, archiveId, status: task.status, task: publicTask(task), taskId: String(task.id) }, 202, request, env)
                    }
                    if (archiveRow.status === 'succeeded') {
                        const task = archiveRow.task_id ? await selectTask(env, archiveRow.task_id, session.user_id) : null
                        const output = await migrationOutput(env, archiveRow, task)
                        return json({ result: true, archiveId, status: output.status, task: output.task, taskId: output.taskId }, 200, request, env)
                    }
                    const task = await createMigrationTask(env, request, session.user_id, archiveId)
                    if (!task || task.status === 'dead_letter')
                        return error('migration_task_unavailable', 503, request, env, 'The migration task could not be queued')
                    await env.DB.prepare('UPDATE migration_archives SET status = \'queued\', task_id = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(task.id, Date.now(), archiveId, session.user_id).run()
                    await recordAudit(env, request, { userId: session.user_id, action: 'migration.commit', resourceType: 'migration_archive', resourceId: archiveId, outcome: 'success' })
                    return json({ result: true, archiveId, status: 'queued', task: publicTask(task), taskId: String(task.id) }, 202, request, env)
                }

                if (action === 'retry' && request.method === 'POST') {
                    const task = archiveRow.task_id ? await selectTask(env, archiveRow.task_id, session.user_id) : null
                    if (archiveRow.task_id && !task)
                        return error('task_not_found', 404, request, env, 'Migration task was not found')
                    if (task && task.type !== migrationTaskType)
                        return error('task_not_retryable', 400, request, env, 'This migration cannot be retried')
                    let retriedTask = null
                    if (task?.status === 'dead_letter') {
                        const retried = await retryDeadLetterTask(env, request, task, session.user_id)
                        if (retried.status === 404)
                            return error('task_not_found', 404, request, env, 'Migration task was not found')
                        if (retried.status === 202 && retried.task?.status !== 'dead_letter') retriedTask = retried.task
                    }
                    const scanTasks = await migrationScanTasks(env, archiveId, session.user_id)
                    for (const scanTask of scanTasks.filter(item => item.status === 'dead_letter')) {
                        const retried = await retryDeadLetterTask(env, request, scanTask, session.user_id)
                        if (!retriedTask && retried.status === 202 && retried.task?.status !== 'dead_letter') retriedTask = retried.task
                    }
                    if (!retriedTask)
                        return error('task_not_retryable', 409, request, env, 'No failed migration task is available to retry')
                    const status = retriedTask.type === migrationTaskType ? 'queued' : archiveRow.status
                    await env.DB.prepare('UPDATE migration_archives SET status = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(status, Date.now(), archiveId, session.user_id).run()
                    return json({ result: true, archiveId, status, task: publicTask(retriedTask), taskId: String(retriedTask.id) }, 202, request, env)
                }
            }

            const sharingMatch = url.pathname.match(/^\/v1\/collection\/(\d+)\/sharing(?:\/(\d+))?$/)
            if (sharingMatch) {
                const collectionId = Number(sharingMatch[1])
                const memberId = sharingMatch[2] ? Number(sharingMatch[2]) : null
                const collection = await env.DB.prepare('SELECT id, user_id, title, parent_id, slug, is_public, removed_at FROM collections WHERE id = ?')
                    .bind(collectionId).first()
                const role = collection && !collection.removed_at ? await collectionRole(env, session.user_id, collectionId) : null
                if (!collection || !role) return error('collection_not_found', 404, request, env)

                if (!memberId && request.method === 'GET') {
                    let rows = await collectionCollaborators(env, collectionId)
                    if (!rows.some(item => Number(item.user_id) === Number(collection.user_id)))
                        rows = [{ collection_id: collectionId, user_id: collection.user_id, role: 'owner', name: '', email: '' }, ...rows]
                    return json({ result: true, items: rows.map(collaboratorItem) }, 200, request, env)
                }

                if (!memberId && request.method === 'POST') {
                    if (roleLevel(role) < roleLevel('editor'))
                        return error('permission_denied', 403, request, env, 'Only Collection Owners and Editors can invite Collaborators')
                    const { data } = await readBody(request)
                    const inviteRole = normalizeRole(data.role || data.access || 'editor')
                    if (!['editor', 'viewer'].includes(inviteRole))
                        return error('validation_failed', 400, request, env, 'Invitation role must be editor or viewer')
                    const invitation = await createCollectionInvitation(env, collectionId, session.user_id, inviteRole)
                    await recordAudit(env, request, { userId: session.user_id, action: 'collection.invitation.create', resourceType: 'collection', resourceId: collectionId, outcome: 'success' })
                    return json({ result: true, role: inviteRole, token: invitation.token, expiresAt: new Date(invitation.expiresAt).toISOString(), link: inviteLink(env, invitation.token) }, 201, request, env)
                }

                if (!memberId) {
                    if (request.method === 'DELETE') {
                        if (role !== 'owner') return error('permission_denied', 403, request, env, 'Only the Collection Owner can remove sharing')
                        const ids = await collectionDescendants(env, collectionId)
                        if (!ids.includes(collectionId)) ids.unshift(collectionId)
                        const placeholders = ids.map(() => '?').join(',')
                        await env.DB.prepare(`DELETE FROM collection_collaborators WHERE collection_id IN (${placeholders}) AND user_id != ?`).bind(...ids, collection.user_id).run()
                        await env.DB.prepare(`DELETE FROM collection_invitations WHERE collection_id IN (${placeholders})`).bind(...ids).run()
                        await recordAudit(env, request, { userId: session.user_id, action: 'collection.unshare', resourceType: 'collection', resourceId: collectionId, outcome: 'success' })
                        return json({ result: true }, 200, request, env)
                    }
                } else if (['PUT', 'PATCH', 'DELETE'].includes(request.method)) {
                    if (role !== 'owner') return error('permission_denied', 403, request, env, 'Only the Collection Owner can manage Collaborators')
                    const target = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(memberId).first()
                    if (!target) return error('user_not_found', 404, request, env)
                    if (memberId === Number(collection.user_id))
                        return error('owner_required', 409, request, env, 'The Collection Owner cannot be removed')
                    if (request.method === 'DELETE') {
                        await env.DB.prepare('DELETE FROM collection_collaborators WHERE collection_id = ? AND user_id = ?').bind(collectionId, memberId).run()
                        await recordAudit(env, request, { userId: session.user_id, action: 'collection.collaborator.remove', resourceType: 'collection', resourceId: memberId, outcome: 'success' })
                        return json({ result: true }, 200, request, env)
                    }
                    const { data } = await readBody(request)
                    const updatedRole = normalizeRole(data.role || data.access)
                    if (!['editor', 'viewer'].includes(updatedRole))
                        return error('validation_failed', 400, request, env, 'Collaborator role must be editor or viewer')
                    await env.DB.prepare(`INSERT INTO collection_collaborators (collection_id, user_id, role)
                        VALUES (?, ?, ?) ON CONFLICT(collection_id, user_id) DO UPDATE SET role = excluded.role`)
                        .bind(collectionId, memberId, updatedRole).run()
                    await recordAudit(env, request, { userId: session.user_id, action: 'collection.collaborator.update', resourceType: 'collection', resourceId: memberId, outcome: 'success' })
                    return json({ result: true, item: collaboratorItem({ collection_id: collectionId, user_id: memberId, role: updatedRole, ...target }) }, 200, request, env)
                }
            }

            if (url.pathname === '/v1/collaborators/join' && ['GET', 'POST'].includes(request.method)) {
                const { data } = request.method === 'POST' ? await readBody(request) : { data: {} }
                const tokenValue = String(url.searchParams.get('token') || data.token || '').trim()
                if (!tokenValue || tokenValue.length > 512)
                    return error('invitation_invalid', 400, request, env, 'The invitation link is invalid or expired')
                const invitation = await env.DB.prepare(`SELECT token_hash, collection_id, role, expires_at, used_at
                    FROM collection_invitations WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
                    .bind(await hmac(tokenValue, env.SESSION_SECRET), Date.now()).first()
                if (!invitation) return error('invitation_invalid', 400, request, env, 'The invitation link is invalid or expired')
                const collection = await env.DB.prepare('SELECT id, user_id, removed_at FROM collections WHERE id = ?').bind(invitation.collection_id).first()
                if (!collection || collection.removed_at) return error('collection_not_found', 404, request, env)
                if (Number(collection.user_id) === Number(session.user_id)) {
                    await env.DB.prepare('UPDATE collection_invitations SET used_at = ? WHERE token_hash = ?').bind(Date.now(), invitation.token_hash).run()
                    return json({ result: true, cId: Number(collection.id), role: 'owner' }, 200, request, env)
                }
                await env.DB.prepare(`INSERT INTO collection_collaborators (collection_id, user_id, role)
                    VALUES (?, ?, ?) ON CONFLICT(collection_id, user_id) DO UPDATE SET role = excluded.role`)
                    .bind(collection.id, session.user_id, normalizeRole(invitation.role)).run()
                await env.DB.prepare('UPDATE collection_invitations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(Date.now(), invitation.token_hash).run()
                await recordAudit(env, request, { userId: session.user_id, action: 'collection.invitation.accept', resourceType: 'collection', resourceId: collection.id, outcome: 'success' })
                return json({ result: true, cId: Number(collection.id), role: normalizeRole(invitation.role) }, 200, request, env)
            }

            const transferMatch = url.pathname.match(/^\/v1\/collection\/(\d+)\/(?:transfer|ownership)$/)
            if (transferMatch && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
                const collectionId = Number(transferMatch[1])
                const collection = await env.DB.prepare('SELECT id, user_id, removed_at FROM collections WHERE id = ?').bind(collectionId).first()
                if (!collection || collection.removed_at) return error('collection_not_found', 404, request, env)
                if (Number(collection.user_id) !== Number(session.user_id))
                    return error('permission_denied', 403, request, env, 'Only the Collection Owner can transfer ownership')
                const { data } = await readBody(request)
                const targetId = Number(data.userId || data.ownerId || data.toUserId)
                if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === Number(session.user_id))
                    return error('validation_failed', 400, request, env, 'Provide another User ID as the new Owner')
                const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetId).first()
                if (!target) return error('user_not_found', 404, request, env)
                const ids = await collectionDescendants(env, collectionId)
                if (!ids.includes(collectionId)) ids.unshift(collectionId)
                for (const id of ids) {
                    await env.DB.prepare('UPDATE collections SET user_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(targetId, Date.now(), id, session.user_id).run()
                    await env.DB.prepare(`INSERT INTO collection_collaborators (collection_id, user_id, role)
                        VALUES (?, ?, 'owner') ON CONFLICT(collection_id, user_id) DO UPDATE SET role = 'owner'`).bind(id, targetId).run()
                    await env.DB.prepare(`INSERT INTO collection_collaborators (collection_id, user_id, role)
                        VALUES (?, ?, 'editor') ON CONFLICT(collection_id, user_id) DO UPDATE SET role = 'editor'`).bind(id, session.user_id).run()
                }
                await recordAudit(env, request, { userId: session.user_id, action: 'collection.ownership.transfer', resourceType: 'collection', resourceId: collectionId, outcome: 'success' })
                return json({ result: true, collectionId, ownerId: targetId }, 200, request, env)
            }

            const publishedMatch = url.pathname.match(/^\/v1\/collection\/(\d+)\/(?:published-snapshots|snapshots|publish)(?:\/([^/]+))?$/)
            if (publishedMatch) {
                const collectionId = Number(publishedMatch[1])
                const collection = await env.DB.prepare('SELECT id, user_id, is_public, removed_at FROM collections WHERE id = ?').bind(collectionId).first()
                if (!collection || collection.removed_at) return error('collection_not_found', 404, request, env)
                if (Number(collection.user_id) !== Number(session.user_id))
                    return error('permission_denied', 403, request, env, 'Only the Collection Owner can publish snapshots')
                if (request.method === 'GET') {
                    const items = (await publishedSnapshotsFor(env, collectionId)).map(item => publicSnapshotItem(item, env))
                    return json({ result: true, items, publishedSnapshots: items }, 200, request, env)
                }
                const body = request.method === 'DELETE' && publishedMatch[2]
                    ? { data: { contentId: decodeURIComponent(publishedMatch[2]) } }
                    : await readBody(request)
                const ids = publishedMatch[2]
                    ? [decodeURIComponent(publishedMatch[2])]
                    : body.data.contentIds || body.data.snapshotIds || [body.data.contentId || body.data.snapshotId].filter(Boolean)
                const publish = request.method !== 'DELETE'
                const changed = await setPublishedSnapshots(env, collectionId, session.user_id, ids, publish)
                if (changed.error === 'validation_failed') return error(changed.error, 400, request, env, 'Provide one or more snapshot Content IDs')
                if (changed.error === 'content_not_found') return error(changed.error, 404, request, env)
                if (changed.error === 'snapshot_required') return error(changed.error, 400, request, env, 'Only saved-page snapshots can be published')
                if (changed.error === 'content_quarantined') return error(changed.error, 409, request, env, 'The snapshot must be Cleared Content before publishing')
                const items = (await publishedSnapshotsFor(env, collectionId)).map(item => publicSnapshotItem(item, env))
                await recordAudit(env, request, { userId: session.user_id, action: publish ? 'collection.snapshot.publish' : 'collection.snapshot.revoke', resourceType: 'collection', resourceId: collectionId, outcome: 'success' })
                return json({ result: true, items, publishedSnapshots: items }, 200, request, env)
            }

            const contentPublishMatch = url.pathname.match(/^\/v1\/content\/([^/]+)\/publish$/)
            if (contentPublishMatch && ['POST', 'DELETE'].includes(request.method)) {
                const contentId = decodeURIComponent(contentPublishMatch[1])
                const content = await env.DB.prepare(`SELECT co.id, co.bookmark_id, b.collection_id
                    FROM content_objects co JOIN bookmarks b ON b.id = co.bookmark_id WHERE co.id = ?`).bind(contentId).first()
                if (!content) return error('content_not_found', 404, request, env)
                const collection = await env.DB.prepare('SELECT id, user_id, removed_at FROM collections WHERE id = ?').bind(content.collection_id).first()
                if (!collection || collection.removed_at) return error('collection_not_found', 404, request, env)
                if (Number(collection.user_id) !== Number(session.user_id))
                    return error('permission_denied', 403, request, env, 'Only the Collection Owner can publish snapshots')
                const changed = await setPublishedSnapshots(env, collection.id, session.user_id, [contentId], request.method === 'POST')
                if (changed.error === 'snapshot_required') return error(changed.error, 400, request, env, 'Only saved-page snapshots can be published')
                if (changed.error === 'content_quarantined') return error(changed.error, 409, request, env, 'The snapshot must be Cleared Content before publishing')
                if (changed.error) return error(changed.error, 404, request, env)
                return json({ result: true, published: request.method === 'POST' }, 200, request, env)
            }

            const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(status|failure|retry))?$/)
            if (taskMatch) {
                const task = await selectTask(env, decodeURIComponent(taskMatch[1]), session.user_id)
                if (!task) return error('task_not_found', 404, request, env, 'Background task was not found')
                const action = taskMatch[2]
                if (request.method === 'GET' && action !== 'retry') {
                    const item = publicTask(task)
                    return action === 'failure'
                        ? json({ result: true, taskId: item.id, status: item.status, failure: item.failure }, 200, request, env)
                        : json({ result: true, task: item }, 200, request, env)
                }
                if (request.method === 'POST' && action === 'retry') {
                    if (!backgroundTaskTypes.has(task.type) || task.type !== migrationTaskType && task.type !== metadataTaskType && !task.content_id)
                        return error('task_not_retryable', 400, request, env, 'This background task cannot be retried')
                    const retried = await retryDeadLetterTask(env, request, task, session.user_id)
                    if (retried.status === 409)
                        return error('task_not_retryable', 409, request, env, 'Only failed background tasks can be retried')
                    if (retried.status === 404)
                        return error('task_not_found', 404, request, env, 'Background task was not found')
                    return json({ result: true, task: publicTask(retried.task) }, 202, request, env)
                }
            }

            const attachmentMatch = url.pathname.match(/^\/v1\/raindrop\/(\d+)\/attachments?$/)
            const uploadBookmarkFile = url.pathname === '/v1/raindrop/file' && request.method === 'PUT'
            const uploadContentFile = (url.pathname === '/v1/content/upload' || attachmentMatch) && ['POST', 'PUT'].includes(request.method)
            if (uploadBookmarkFile || uploadContentFile) {
                const upload = await readUpload(request, attachmentMaxBytes(env))
                const scanEnabled = attachmentScanEnabled(env)
                if (upload.error === 'content_too_large')
                    return error('content_too_large', 413, request, env, 'The uploaded file exceeds the 50 MB limit')
                if (upload.error)
                    return error('validation_failed', 400, request, env, 'Provide one file to upload')

                const fields = upload.fields || {}
                const suppliedBookmarkId = attachmentMatch
                    ? Number(attachmentMatch[1])
                    : Number(fields.bookmarkId || fields.raindropId || fields.bookmark_id || 0)
                let bookmark = null
                let createdBookmark = false
                if (uploadContentFile) {
                    if (!Number.isSafeInteger(suppliedBookmarkId) || suppliedBookmarkId <= 0)
                        return error('validation_failed', 400, request, env, 'Provide a Bookmark ID for this attachment')
                    bookmark = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
                        .bind(suppliedBookmarkId, session.user_id).first()
                    if (!bookmark) bookmark = await bookmarkAccessible(env, suppliedBookmarkId, session.user_id)
                    if (!bookmark) return error('bookmark_not_found', 404, request, env)
                    if (roleLevel(bookmark.user_id === session.user_id ? 'owner' : await collectionRole(env, session.user_id, bookmark.collection_id)) < roleLevel('editor'))
                        return error('permission_denied', 403, request, env, 'Editor access is required to add Protected Content')
                } else {
                    const collectionId = fields.collectionId === undefined ? -1 : parseBookmarkCollectionId(fields.collectionId)
                    if (!Number.isSafeInteger(collectionId) || collectionId < -1 || collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId) && !await collectionCanWrite(env, session.user_id, collectionId))
                        return error('collection_not_found', 404, request, env)
                    const title = String(fields.title || upload.filename || '').trim()
                    const description = String(fields.description || fields.excerpt || '').trim()
                    const note = String(fields.note || '').trim()
                    const tags = bookmarkTags(fields.tags)
                    if (!title || title.length > 500 || description.length > 10000 || note.length > 10000 || fields.tags && !validTagList(arrayValue(fields.tags)))
                        return error('validation_failed', 400, request, env, 'File metadata is invalid')
                    const now = Date.now()
                    const link = String(fields.link || '').trim() || 'attachment://' + randomToken(12)
                    const inserted = await env.DB.prepare(`INSERT INTO bookmarks
                        (user_id, url, title, description, note, highlights, created_at, updated_at, collection_id, tags)
                        VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`)
                        .bind(session.user_id, link, title, description, note, now, now, collectionId, JSON.stringify(tags)).run()
                    bookmark = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
                        .bind(inserted.meta.last_row_id, session.user_id).first()
                    createdBookmark = true
                }

                let content
                try {
                    content = await createContentRecord(env, {
                        userId: session.user_id,
                        bookmarkId: Number(bookmark.id),
                        kind: 'attachment',
                        filename: upload.filename,
                        contentType: upload.contentType,
                        size: upload.size,
                        status: scanEnabled ? 'quarantined' : 'cleared'
                    })
                    await putContentObject(env, content, upload.body, upload)
                } catch {
                    try { await removeContentRecord(env, content) } catch {}
                    if (createdBookmark) await env.DB.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').bind(bookmark.id, session.user_id).run()
                    return error('content_upload_failed', 503, request, env, 'The file could not be stored')
                }

                if (!scanEnabled) {
                    await recordAudit(env, request, { userId: session.user_id, action: 'content.upload', resourceType: 'content', resourceId: content.id, outcome: 'scan_skipped' })
                    return json({ result: true, item: bookmarkItem(bookmark), content: publicContent(content) }, 201, request, env)
                }

                const task = await createContentTask(env, request, {
                    userId: session.user_id,
                    bookmarkId: Number(bookmark.id),
                    type: attachmentTaskType,
                    contentId: content.id,
                    sourceUrl: bookmark.url,
                    payload: { kind: 'attachment' }
                })
                if (!task || task.status === 'dead_letter') {
                    await discardContentTask(env, task)
                    try { await removeContentRecord(env, content) } catch {}
                    if (createdBookmark) await env.DB.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').bind(bookmark.id, session.user_id).run()
                    return error('content_task_unavailable', 503, request, env, 'The file safety check could not be queued')
                }
                await recordAudit(env, request, { userId: session.user_id, action: 'content.upload', resourceType: 'content', resourceId: content.id, outcome: 'success' })
                return json({
                    result: true,
                    item: bookmarkItem(bookmark),
                    content: publicContent(content),
                    ...(task ? { task: publicTask(task), taskId: String(task.id) } : {})
                }, 201, request, env)
            }

            const captureMatch = url.pathname.match(/^\/v1\/raindrop\/(\d+)\/capture(?:\/status)?$/)
            if (captureMatch) {
                const bookmarkId = Number(captureMatch[1])
                let bookmark = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
                    .bind(bookmarkId, session.user_id).first()
                if (!bookmark) {
                    const shared = await bookmarkAccessible(env, bookmarkId, session.user_id)
                    if (shared && roleLevel(await collectionRole(env, session.user_id, shared.collection_id)) >= roleLevel('editor'))
                        bookmark = shared
                }
                if (!bookmark) return error('bookmark_not_found', 404, request, env)
                if (request.method === 'GET')
                    return json({ result: true, items: (await listContent(env, bookmarkId, session.user_id)).filter(item => ['snapshot', 'screenshot'].includes(item.kind)) }, 200, request, env)
                if (request.method === 'POST' && url.pathname.endsWith('/capture')) {
                    const urlCheck = validateFetchableUrl(bookmark.url)
                    if (!urlCheck.ok)
                        return error('url_not_public', 400, request, env, 'Only public HTTP(S) bookmarks can be captured')
                    const { data } = await readBody(request)
                    const kind = ['snapshot', 'screenshot'].includes(String(data.kind || data.type)) ? String(data.kind || data.type) : 'snapshot'
                    let content
                    try {
                        content = await createContentRecord(env, {
                            userId: session.user_id,
                            bookmarkId,
                            kind,
                            filename: kind === 'screenshot' ? 'capture.png' : 'snapshot.html',
                            contentType: kind === 'screenshot' ? 'image/png' : 'text/html',
                            size: 0
                        })
                    } catch {
                        return error('content_storage_unavailable', 503, request, env, 'Protected content storage is unavailable')
                    }
                    if (!content)
                        return error('content_storage_unavailable', 503, request, env, 'Protected content storage is unavailable')
                    const task = await createContentTask(env, request, {
                        userId: session.user_id,
                        bookmarkId,
                        type: captureTaskType,
                        contentId: content.id,
                        sourceUrl: bookmark.url,
                        payload: { kind, dynamic: true }
                    })
                    if (!task || task.status === 'dead_letter') {
                        await discardContentTask(env, task)
                        try { await removeContentRecord(env, content) } catch {}
                        return error('content_task_unavailable', 503, request, env, 'The capture could not be queued')
                    }
                    await recordAudit(env, request, { userId: session.user_id, action: 'capture.request', resourceType: 'content', resourceId: content.id, outcome: 'success' })
                    return json({ result: true, content: publicContent(content), task: publicTask(task), taskId: String(task.id) }, 202, request, env)
                }
            }

            const bookmarkContentMatch = url.pathname.match(/^\/v1\/raindrop\/(\d+)\/content$/)
            if (bookmarkContentMatch && request.method === 'GET') {
                const bookmark = await bookmarkAccessible(env, Number(bookmarkContentMatch[1]), session.user_id)
                if (!bookmark) return error('bookmark_not_found', 404, request, env)
                return json({ result: true, items: await listContent(env, Number(bookmarkContentMatch[1]), session.user_id) }, 200, request, env)
            }

            const contentDownloadMatch = url.pathname.match(/^\/v1\/content\/([^/]+)\/download$/)
            const contentMatch = url.pathname.match(/^\/v1\/content\/([^/]+)$/)
            if (contentDownloadMatch || contentMatch) {
                const contentId = decodeURIComponent((contentDownloadMatch || contentMatch)[1])
                const content = await selectContent(env, contentId)
                if (!content || !await contentAuthorized(env, content, session.user_id))
                    return error('content_not_found', 404, request, env)
                if (!contentDownloadMatch)
                    return json({ result: true, item: publicContent(content) }, 200, request, env)
                if (content.status !== 'cleared')
                    return error('content_quarantined', 409, request, env, 'Protected content is not available until it passes the safety check')
                if (!env.CONTENT_BUCKET?.get)
                    return error('content_storage_unavailable', 503, request, env, 'Content storage is not configured')
                const object = await env.CONTENT_BUCKET.get(content.object_key)
                if (!object) return error('content_not_found', 404, request, env)
                const headers = addCorsHeaders(new Headers({
                    'Content-Type': content.content_type || object.httpMetadata?.contentType || 'application/octet-stream',
                    'Content-Length': String(content.size_bytes || object.size || 0),
                    'Content-Disposition': 'attachment; filename="' + safeFilename(content.filename) + '"',
                    'Cache-Control': 'private, no-store',
                    'X-Request-ID': requestId(request)
                }), request, env)
                return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
            }

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
                const items = []
                const seen = new Set()
                for (const item of rows.results || [])
                    if (!seen.has(Number(item.id))) {
                        seen.add(Number(item.id))
                        items.push(collectionItem({ ...item, role: 'owner', public_link: await publicCollectionLink(env, item) }))
                    }
                if (!removed) {
                    const shared = await env.DB.prepare(`SELECT c.*, COUNT(b.id) AS count
                        FROM collections c
                        LEFT JOIN bookmarks b ON b.collection_id = c.id AND b.removed_at IS NULL
                        WHERE c.user_id != ? AND c.removed_at IS NULL GROUP BY c.id ORDER BY c.id`)
                        .bind(session.user_id).all()
                    for (const item of shared.results || []) {
                        if (seen.has(Number(item.id))) continue
                        const role = await collectionRole(env, session.user_id, item.id)
                        if (!role) continue
                        seen.add(Number(item.id))
                        items.push(collectionItem({ ...item, role, public_link: await publicCollectionLink(env, item) }))
                    }
                }
                return json({ result: true, items }, 200, request, env)
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
                const removedBatch = randomToken(16)
                const placeholders = ids.map(() => '?').join(',')
                await env.DB.prepare(`UPDATE bookmarks SET removed_at = ?, removed_batch = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND collection_id IN (${placeholders})`)
                    .bind(now, removedBatch, now, session.user_id, ...ids).run()
                await env.DB.prepare(`UPDATE collections SET removed_at = ?, removed_batch = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND id IN (${placeholders})`)
                    .bind(now, removedBatch, now, session.user_id, ...ids).run()
                await recordAudit(env, request, { userId: session.user_id, action: 'collection.remove_bulk', resourceType: 'collection', resourceId: ids.join(','), outcome: 'success' })
                return json({ result: true, count: ids.length, ...(await bookmarkSync(env, session.user_id)) }, 200, request, env)
            }

            if (url.pathname === '/v1/collection' && request.method === 'POST') {
                const { data } = await readBody(request)
                const title = String(data.title || '').trim()
                if (!title || title.length > 200)
                    return error('validation_failed', 400, request, env, 'Enter a collection title under 200 characters')
                const parentId = parseCollectionId(data.parentId)
                if (Number.isNaN(parentId) || parentId && !await collectionOwned(env, session.user_id, parentId) && !await collectionCanWrite(env, session.user_id, parentId))
                    return error('collection_not_found', 404, request, env)
                const now = Date.now()
                const slug = slugify(data.slug) || slugify(title) || String(now)
                const inserted = await env.DB.prepare('INSERT INTO collections (user_id, title, parent_id, created_at, updated_at, slug, is_public) VALUES (?, ?, ?, ?, ?, ?, 0)')
                    .bind(session.user_id, title, parentId || null, now, now, slug).run()
                await env.DB.prepare(`INSERT INTO collection_collaborators (collection_id, user_id, role)
                    VALUES (?, ?, 'owner') ON CONFLICT(collection_id, user_id) DO UPDATE SET role = 'owner'`)
                    .bind(inserted.meta.last_row_id, session.user_id).run()
                await recordAudit(env, request, { userId: session.user_id, action: 'collection.create', resourceType: 'collection', resourceId: inserted.meta.last_row_id, outcome: 'success' })
                const link = await publicCollectionLink(env, { id: inserted.meta.last_row_id, title, slug })
                return json({ result: true, item: collectionItem({ id: inserted.meta.last_row_id, title, parent_id: parentId || null, slug, is_public: 0, role: 'owner', public_link: link }) }, 201, request, env)
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
                    if (item) {
                        const link = await publicCollectionLink(env, item)
                        return json({ result: true, item: collectionItem({ ...item, role: 'owner', public_link: link }) }, 200, request, env)
                    }
                    const shared = await selectCollection(env, collectionId, session.user_id)
                    if (!shared) return error('collection_not_found', 404, request, env)
                    const link = await publicCollectionLink(env, shared)
                    return json({ result: true, item: collectionItem({ ...shared, public_link: link }) }, 200, request, env)
                }
                if (request.method === 'PUT') {
                    const { data } = await readBody(request)
                    const owned = await env.DB.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').bind(collectionId, session.user_id).first()
                    const existing = owned || await selectCollection(env, collectionId, session.user_id)
                    if (!existing) return error('collection_not_found', 404, request, env)
                    const role = existing.role || (owned ? 'owner' : await collectionRole(env, session.user_id, collectionId))

                    if (data.removed === false && existing.removed_at) {
                        if (role !== 'owner') return error('permission_denied', 403, request, env, 'Only the Collection Owner can restore a Collection')
                        const removedBatch = existing.removed_batch
                        const collections = await userCollections(env, session.user_id)
                        const ids = descendantCollectionIds(collections, [collectionId])
                        const now = Date.now()
                        const placeholders = ids.map(() => '?').join(',')
                        await env.DB.prepare(`UPDATE collections SET removed_at = NULL, removed_batch = NULL, updated_at = ? WHERE user_id = ? AND id IN (${placeholders}) AND removed_batch = ?`)
                            .bind(now, session.user_id, ...ids, removedBatch).run()
                        await env.DB.prepare(`UPDATE bookmarks SET removed_at = NULL, removed_batch = NULL, updated_at = ? WHERE user_id = ? AND collection_id IN (${placeholders}) AND removed_batch = ?`)
                            .bind(now, session.user_id, ...ids, removedBatch).run()
                        await recordAudit(env, request, { userId: session.user_id, action: 'collection.restore', resourceType: 'collection', resourceId: collectionId, outcome: 'success' })
                        const item = await env.DB.prepare(`SELECT c.*, COUNT(b.id) AS count FROM collections c
                            LEFT JOIN bookmarks b ON b.collection_id = c.id AND b.removed_at IS NULL
                            WHERE c.id = ? AND c.user_id = ? GROUP BY c.id`).bind(collectionId, session.user_id).first()
                        const link = await publicCollectionLink(env, item || { ...existing, removed_at: null })
                        return json({ result: true, item: collectionItem({ ...(item || { ...existing, removed_at: null }), role, public_link: link }) }, 200, request, env)
                    }

                    const title = data.title === undefined ? existing.title : String(data.title).trim()
                    if (!title || title.length > 200)
                        return error('validation_failed', 400, request, env, 'Enter a collection title under 200 characters')
                    const parentId = data.parentId === undefined ? existing.parent_id : parseCollectionId(data.parentId)
                    if (roleLevel(role) < roleLevel('editor'))
                        return error('permission_denied', 403, request, env, 'Editor access is required to update a Collection')
                    if (Number.isNaN(parentId) || parentId && !await collectionParentAllowed(env, session.user_id, collectionId, parentId) && !await collectionCanWrite(env, session.user_id, parentId))
                        return error('collection_not_found', 404, request, env)
                    const changesPublic = data.public !== undefined || data.isPublic !== undefined || data.slug !== undefined
                    if (changesPublic && role !== 'owner')
                        return error('permission_denied', 403, request, env, 'Only the Collection Owner can change public settings')
                    const isPublic = data.public === undefined && data.isPublic === undefined
                        ? Number(existing.is_public || 0) : (data.public === true || data.isPublic === true || String(data.public ?? data.isPublic).toLowerCase() === 'true' ? 1 : 0)
                    const nextSlug = data.slug === undefined ? await persistedSlug(env, existing) : slugify(data.slug)
                    if (data.slug !== undefined && !nextSlug)
                        return error('validation_failed', 400, request, env, 'Public Link slug must contain letters or numbers')
                    const ownerId = Number(existing.user_id || session.user_id)
                    await env.DB.prepare('UPDATE collections SET title = ?, parent_id = ?, slug = ?, is_public = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(title, parentId || null, nextSlug, isPublic, Date.now(), collectionId, ownerId).run()
                    await recordAudit(env, request, { userId: session.user_id, action: 'collection.update', resourceType: 'collection', resourceId: collectionId, outcome: 'success' })
                    const link = await publicCollectionLink(env, { ...existing, id: collectionId, title, slug: nextSlug, is_public: isPublic })
                    return json({ result: true, item: collectionItem({ ...existing, title, parent_id: parentId || null, slug: nextSlug, is_public: isPublic, role, public_link: link }) }, 200, request, env)
                }
                if (request.method === 'DELETE') {
                    if (collectionId === -99) {
                        const removed = await env.DB.prepare('SELECT id FROM bookmarks WHERE user_id = ? AND removed_at IS NOT NULL').bind(session.user_id).all()
                        const bookmarkIds = (removed.results || []).map(item => Number(item.id))
                        if (bookmarkIds.length) {
                            await deleteContentObjects(env, session.user_id, bookmarkIds)
                            const placeholders = bookmarkIds.map(() => '?').join(',')
                            await env.DB.prepare(`DELETE FROM published_snapshots WHERE bookmark_id IN (${placeholders})`).bind(...bookmarkIds).run()
                            await env.DB.prepare(`DELETE FROM background_tasks WHERE user_id = ? AND bookmark_id IN (${placeholders})`).bind(session.user_id, ...bookmarkIds).run()
                            await env.DB.prepare(`DELETE FROM bookmark_changes WHERE user_id = ? AND bookmark_id IN (${placeholders})`).bind(session.user_id, ...bookmarkIds).run()
                            await env.DB.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND id IN (${placeholders}) AND removed_at IS NOT NULL`).bind(session.user_id, ...bookmarkIds).run()
                        }
                        const collections = await env.DB.prepare('SELECT id FROM collections WHERE user_id = ? AND removed_at IS NOT NULL').bind(session.user_id).all()
                        const collectionIds = (collections.results || []).map(item => Number(item.id))
                        if (collectionIds.length) {
                            const placeholders = collectionIds.map(() => '?').join(',')
                            await env.DB.prepare(`DELETE FROM published_snapshots WHERE collection_id IN (${placeholders})`).bind(...collectionIds).run()
                            await env.DB.prepare(`DELETE FROM collection_invitations WHERE collection_id IN (${placeholders})`).bind(...collectionIds).run()
                            await env.DB.prepare(`DELETE FROM collection_collaborators WHERE collection_id IN (${placeholders})`).bind(...collectionIds).run()
                            await env.DB.prepare(`DELETE FROM collections WHERE user_id = ? AND id IN (${placeholders}) AND removed_at IS NOT NULL`).bind(session.user_id, ...collectionIds).run()
                        }
                        await recordAudit(env, request, { userId: session.user_id, action: 'collection.trash_clear', resourceType: 'recycle_bin', resourceId: -99, outcome: 'success' })
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
                    const removedBatch = randomToken(16)
                    await env.DB.prepare(`UPDATE bookmarks SET removed_at = ?, removed_batch = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND collection_id IN (${placeholders})`)
                        .bind(now, removedBatch, now, session.user_id, ...ids).run()
                    await env.DB.prepare(`UPDATE collections SET removed_at = ?, removed_batch = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL AND id IN (${placeholders})`)
                        .bind(now, removedBatch, now, session.user_id, ...ids).run()
                    await recordAudit(env, request, { userId: session.user_id, action: 'collection.remove', resourceType: 'collection', resourceId: collectionId, outcome: 'success' })
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
                    await env.DB.prepare('DELETE FROM published_snapshots WHERE collection_id = ?').bind(id).run()
                    await env.DB.prepare('DELETE FROM collection_invitations WHERE collection_id = ?').bind(id).run()
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
                const dangerAll = url.searchParams.get('dangerAll') === 'true'
                if (!ids.length && !dangerAll)
                    return error('validation_failed', 400, request, env, 'Provide Bookmark IDs or confirm dangerAll=true')
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
                        await deleteContentObjects(env, session.user_id, bookmarkIds)
                        const placeholders = bookmarkIds.map(() => '?').join(',')
                        await env.DB.prepare(`DELETE FROM published_snapshots WHERE bookmark_id IN (${placeholders})`).bind(...bookmarkIds).run()
                        await env.DB.prepare(`DELETE FROM background_tasks WHERE user_id = ? AND bookmark_id IN (${placeholders})`).bind(session.user_id, ...bookmarkIds).run()
                        await env.DB.prepare(`DELETE FROM bookmark_changes WHERE user_id = ? AND bookmark_id IN (${placeholders})`).bind(session.user_id, ...bookmarkIds).run()
                        await env.DB.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND id IN (${placeholders}) AND removed_at IS NOT NULL`).bind(session.user_id, ...bookmarkIds).run()
                    }
                    await recordAudit(env, request, { userId: session.user_id, action: 'bookmark.trash_clear', resourceType: 'recycle_bin', resourceId: -99, outcome: 'success' })
                    return json({ result: true, count: bookmarkIds.length }, 200, request, env)
                }
                const now = Date.now()
                const removedBatch = randomToken(16)
                let query = 'UPDATE bookmarks SET removed_at = ?, removed_batch = ?, updated_at = ? WHERE user_id = ? AND removed_at IS NULL'
                const values = [now, removedBatch, now, session.user_id]
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
                await recordAudit(env, request, { userId: session.user_id, action: 'bookmark.remove_bulk', resourceType: 'bookmark', resourceId: collectionId, outcome: 'success' })
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
                    if (spaceId !== 0) {
                        const owned = await collectionOwned(env, session.user_id, spaceId)
                        if (!owned) {
                            const role = await collectionRole(env, session.user_id, spaceId)
                            if (!role) return error('collection_not_found', 404, request, env)
                            where = 'removed_at IS NULL AND collection_id = ?'
                            values.splice(0, values.length, spaceId)
                        } else {
                            where += ' AND collection_id = ?'
                            values.push(spaceId)
                        }
                    }
                }
                if (search) {
                    where += ' AND (title LIKE ? OR url LIKE ? OR description LIKE ? OR tags LIKE ? OR note LIKE ? OR highlights LIKE ?)'
                    values.push(...Array(6).fill(`%${search}%`))
                }
                const rows = await env.DB.prepare(`SELECT id, user_id, url, title, description, note, cover, collection_id, tags, highlights, removed_at, created_at, updated_at, change_version FROM bookmarks WHERE ${where} ORDER BY updated_at DESC`).bind(...values).all()
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
                const tasks = []
                for (const input of data.items) {
                    const link = String(input.link || input.url || '').trim()
                    const title = String(input.title || '').trim()
                    const urlCheck = validateFetchableUrl(link)
                    if (!urlCheck.ok) return error(urlCheck.code, 400, request, env, urlCheck.message)
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
                    const task = await createMetadataTask(env, request, session.user_id, inserted.meta.last_row_id, link)
                    if (task) tasks.push(publicTask(task))
                    await recordAudit(env, request, { userId: session.user_id, action: 'bookmark.create_bulk', resourceType: 'bookmark', resourceId: inserted.meta.last_row_id, outcome: 'success' })
                }
                return json({ result: true, items, tasks, ...(await bookmarkSync(env, session.user_id)) }, 201, request, env)
            }

            if (url.pathname === '/v1/raindrop' && request.method === 'POST') {
                const { data } = await readBody(request)
                const bookmarkUrl = String(data.link || data.url || '').trim()
                const title = String(data.title || '').trim()
                const urlCheck = validateFetchableUrl(bookmarkUrl)
                if (!urlCheck.ok || title.length > 500)
                    return error(urlCheck.ok ? 'validation_failed' : urlCheck.code, 400, request, env, urlCheck.ok ? 'Enter an HTTP(S) bookmark URL and a title under 500 characters' : urlCheck.message)
                if (data.tags !== undefined && !validTagList(data.tags))
                    return error('validation_failed', 400, request, env, 'Bookmark tags must be 100 characters or fewer')
                const description = String(data.description ?? data.excerpt ?? '').trim()
                const note = String(data.note || '').trim()
                const highlights = data.highlights === undefined ? [] : data.highlights
                if (description.length > 10000 || note.length > 10000 || !validHighlightChanges(highlights))
                    return error('validation_failed', 400, request, env, 'Bookmark metadata is invalid')

                const now = Date.now()
                const collectionId = data.collectionId === undefined ? -1 : parseBookmarkCollectionId(data.collectionId)
                if (!Number.isSafeInteger(collectionId) || collectionId < -1 || collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId) && !await collectionCanWrite(env, session.user_id, collectionId))
                    return error('collection_not_found', 404, request, env)
                const tags = bookmarkTags(data.tags)
                const inserted = await env.DB.prepare('INSERT INTO bookmarks (user_id, url, title, description, note, highlights, created_at, updated_at, collection_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .bind(session.user_id, bookmarkUrl, title, description, note, JSON.stringify(applyHighlightChanges('[]', highlights)), now, now, collectionId, JSON.stringify(tags)).run()
                const item = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
                    .bind(inserted.meta.last_row_id, session.user_id).first()
                const task = await createMetadataTask(env, request, session.user_id, inserted.meta.last_row_id, bookmarkUrl)
                await recordAudit(env, request, { userId: session.user_id, action: 'bookmark.create', resourceType: 'bookmark', resourceId: inserted.meta.last_row_id, outcome: 'success' })
                return json({
                    result: true,
                    item: bookmarkItem(item || { id: inserted.meta.last_row_id, url: bookmarkUrl, title, description, note, highlights: JSON.stringify(highlights), created_at: now, updated_at: now, collection_id: collectionId, tags: JSON.stringify(tags), removed_at: null }),
                    ...(task ? { task: publicTask(task), taskId: String(task.id) } : {}),
                    ...(await bookmarkSync(env, session.user_id))
                }, 201, request, env)
            }

            const highlightExport = url.pathname.match(/^\/v1\/raindrop\/(\d+)\/highlights\.(txt|csv)$/)
            if (highlightExport && request.method === 'GET') {
                const bookmark = await bookmarkAccessible(env, Number(highlightExport[1]), session.user_id)
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
                const owned = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?').bind(bookmarkId, session.user_id).first()
                const existing = owned || await bookmarkAccessible(env, bookmarkId, session.user_id)
                if (!existing) return error('bookmark_not_found', 404, request, env)
                const accessRole = owned ? 'owner' : await collectionRole(env, session.user_id, existing.collection_id)
                if (request.method === 'GET')
                    return json({ result: true, item: bookmarkItem(existing) }, 200, request, env)
                if (request.method === 'PUT') {
                    if (roleLevel(accessRole) < roleLevel('editor'))
                        return error('permission_denied', 403, request, env, 'Editor access is required to update this Bookmark')
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
                    const removedBatch = data.removed === false ? null : existing.removed_batch
                    const highlights = data.highlights === undefined ? bookmarkHighlights(existing.highlights) : data.highlights
                    if (data.collectionId === undefined && data.removed === false && collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId) && !await collectionCanWrite(env, session.user_id, collectionId))
                        collectionId = -1
                    const urlCheck = validateFetchableUrl(link)
                    if (!urlCheck.ok || title.length > 500 || description.length > 10000 || note.length > 10000)
                        return error(urlCheck.ok ? 'validation_failed' : urlCheck.code, 400, request, env, urlCheck.ok ? 'Enter an HTTP(S) bookmark URL and a title under 500 characters' : urlCheck.message)
                    if (data.tags !== undefined && !validTagList(data.tags))
                        return error('validation_failed', 400, request, env, 'Bookmark tags must be 100 characters or fewer')
                    if (!Number.isSafeInteger(collectionId) || collectionId < -1 || collectionId > 0 && !await collectionOwned(env, session.user_id, collectionId) && !await collectionCanWrite(env, session.user_id, collectionId))
                        return error('collection_not_found', 404, request, env)
                    if (!validHighlightChanges(highlights))
                        return error('validation_failed', 400, request, env, 'Highlight text and note must be valid')
                    await env.DB.prepare('UPDATE bookmarks SET url = ?, title = ?, description = ?, note = ?, collection_id = ?, tags = ?, highlights = ?, removed_at = ?, removed_batch = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(link, title, description, note, collectionId, JSON.stringify(tags), JSON.stringify(applyHighlightChanges(existing.highlights, highlights)), removedAt, removedBatch, Date.now(), bookmarkId, existing.user_id).run()
                    const item = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?').bind(bookmarkId, existing.user_id).first()
                    const task = link !== existing.url
                        ? await createMetadataTask(env, request, session.user_id, bookmarkId, link)
                        : null
                    await recordAudit(env, request, { userId: session.user_id, action: data.removed === false ? 'bookmark.restore' : 'bookmark.update', resourceType: 'bookmark', resourceId: bookmarkId, outcome: 'success' })
                    return json({ result: true, item: bookmarkItem(item), ...(task ? { task: publicTask(task), taskId: String(task.id) } : {}), ...(await bookmarkSync(env, session.user_id)) }, 200, request, env)
                }
                if (request.method === 'DELETE') {
                    if (roleLevel(accessRole) < roleLevel('editor'))
                        return error('permission_denied', 403, request, env, 'Editor access is required to remove this Bookmark')
                    const now = Date.now()
                    const removedBatch = randomToken(16)
                    await env.DB.prepare('UPDATE bookmarks SET removed_at = ?, removed_batch = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                        .bind(now, removedBatch, now, bookmarkId, existing.user_id).run()
                    await recordAudit(env, request, { userId: session.user_id, action: 'bookmark.remove', resourceType: 'bookmark', resourceId: bookmarkId, outcome: 'success' })
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

    async queue(batch, env) {
        for (const message of batch.messages) {
            let body
            try {
                body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body
            } catch {
                message.ack?.()
                continue
            }
            const taskId = body?.taskId || body?.backupId
            if (!taskId) {
                message.ack?.()
                continue
            }
            try {
                const queuedTask = body.type ? null : await selectTask(env, taskId)
                const type = body.type || (body.backupId ? backupTaskType : queuedTask?.type)
                const result = await processTask(env, taskId, type)
                if (result.action === 'retry') message.retry?.({ delaySeconds: result.delaySeconds })
                else if (result.action === 'defer') message.retry?.({ delaySeconds: result.delaySeconds })
                else if (result.action === 'dead_letter') {
                    try {
                        await env.TASK_DLQ?.send({ taskId, type: type || metadataTaskType, failure: result.failure })
                    } catch {}
                    message.ack?.()
                } else message.ack?.()
            } catch {
                message.retry?.({ delaySeconds: metadataRetryDelays[0] })
            }
        }
    },

    async scheduled(controller, env, ctx) {
        ctx.waitUntil(Promise.all([
            purgeExpiredDeletions(env),
            purgeAccounting(env),
            scheduleBackups(env, controller?.scheduledTime)
        ]))
    }
}

export {
    createContentTask,
    createMetadataTask,
    createMigrationTask,
    fetchPageMetadata,
    normalizeMigrationArchive,
    processAttachmentScanTask,
    processCaptureTask,
    processMigrationTask,
    processMetadataTask,
    processBackupTask,
    purgeBackups,
    scheduleBackups,
    validateFetchableUrl
}
