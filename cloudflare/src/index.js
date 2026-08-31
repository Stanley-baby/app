/* global Uint8Array */

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
const contentTaskTypes = new Set([attachmentTaskType, captureTaskType])
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

const publicTask = task => ({
    id: String(task.id),
    taskId: String(task.id),
    type: task.type,
    bookmarkId: Number(task.bookmark_id),
    ...(task.content_id ? { contentId: String(task.content_id) } : {}),
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
})

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
        filename, content_type, size_bytes, created_at, updated_at, cleared_at
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
        content_too_large: 'The content exceeds the size limit'
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
    if (!task || task.type !== metadataTaskType && !contentTaskTypes.has(task.type)) return { action: 'skip' }
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
    return { action: 'skip' }
}

const createContentRecord = async (env, { userId, bookmarkId, kind, filename, contentType, size, status = 'quarantined' }) => {
    const id = randomToken(18)
    const objectKey = 'content/' + userId + '/' + id
    const now = Date.now()
    await env.DB.prepare(`INSERT INTO content_objects
        (id, user_id, bookmark_id, kind, status, object_key, filename, content_type, size_bytes, created_at, updated_at, cleared_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, userId, bookmarkId, kind, status === 'cleared' ? 'cleared' : 'quarantined', objectKey,
            safeFilename(filename), safeContentType(contentType), size, now, now, status === 'cleared' ? now : null).run()
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
        [/^\/v1\/raindrops\/-?\d+$/, '/v1/raindrops/:collectionId'],
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
        [/^\/v1\/content\/[^/]+\/publish$/, '/v1/content/:id/publish']
    ]
    const match = patterns.find(([pattern]) => pattern.test(pathname))
    if (match) return pathname.replace(match[0], match[1])

    const known = new Set([
        '/v1/auth/email/signup', '/v1/auth/email/login', '/v1/auth/email/confirm',
        '/v1/auth/google', '/v1/auth/google/callback', '/v1/auth/logout',
        '/v1/sessions', '/v1/collections/all', '/v1/collections', '/v1/collections/clean',
        '/v1/collection', '/v1/tags/recent', '/v1/tags/0', '/v1/tag',
        '/v1/raindrops', '/v1/raindrops/changes', '/v1/raindrop', '/v1/user', '/v1/user/quota',
        '/v1/user/connect/google', '/v1/user/connect/google/revoke', '/v1/user/deletion',
        '/v1/tasks',
        '/v1/user/remove', '/v1/user/send_email_confirm', '/v1/user/stats',
        '/v1/raindrop/file', '/v1/content/upload', '/v1/collaborators/join'
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
    pathname.startsWith('/v1/backups') ||
    pathname.startsWith('/v1/import/') ||
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
    let bookmarkIds = []
    try {
        const rows = await env.DB.prepare('SELECT id FROM bookmarks WHERE user_id = ?').bind(userId).all()
        bookmarkIds = (rows.results || []).map(item => Number(item.id)).filter(Number.isSafeInteger)
    } catch {}
    await deleteContentObjects(env, userId, bookmarkIds)
    const statements = [
        env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM connected_identities WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM oauth_states WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM published_snapshots WHERE published_by = ? OR bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)').bind(userId, userId),
        env.DB.prepare('DELETE FROM collection_invitations WHERE invited_by = ? OR collection_id IN (SELECT id FROM collections WHERE user_id = ?)').bind(userId, userId),
        env.DB.prepare('DELETE FROM collection_collaborators WHERE collection_id IN (SELECT id FROM collections WHERE user_id = ?) OR user_id = ?').bind(userId, userId),
        env.DB.prepare('DELETE FROM background_tasks WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM content_objects WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM bookmark_changes WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM collections WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM account_deletions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM usage_counters WHERE user_id = ?').bind(userId),
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
                    if (task.type !== metadataTaskType && (!contentTaskTypes.has(task.type) || !task.content_id))
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
            if (!body?.taskId) {
                message.ack?.()
                continue
            }
            try {
                const queuedTask = body.type ? null : await selectTask(env, body.taskId)
                const result = await processTask(env, body.taskId, body.type || queuedTask?.type)
                if (result.action === 'retry') message.retry?.({ delaySeconds: result.delaySeconds })
                else if (result.action === 'defer') message.retry?.({ delaySeconds: result.delaySeconds })
                else if (result.action === 'dead_letter') {
                    try {
                        await env.TASK_DLQ?.send({ taskId: body.taskId, type: body.type || queuedTask?.type || metadataTaskType, failure: result.failure })
                    } catch {}
                    message.ack?.()
                } else message.ack?.()
            } catch {
                message.retry?.({ delaySeconds: metadataRetryDelays[0] })
            }
        }
    },

    async scheduled(controller, env, ctx) {
        ctx.waitUntil(Promise.all([purgeExpiredDeletions(env), purgeAccounting(env)]))
    }
}

export {
    createContentTask,
    createMetadataTask,
    fetchPageMetadata,
    processAttachmentScanTask,
    processCaptureTask,
    processMetadataTask,
    validateFetchableUrl
}
