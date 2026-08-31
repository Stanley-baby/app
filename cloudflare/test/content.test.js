import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import worker from '../src/index.js'

/* global Uint8Array, globalThis */

globalThis.crypto ||= webcrypto

class ContentDatabase {
    constructor() {
        this.users = [{ id: 1, email: 'owner@example.test', name: 'Owner', email_verified_at: 1, federated_only: 0 }]
        this.bookmarks = []
        this.contents = []
        this.tasks = []
        this.nextBookmarkId = 1
        this.audits = []
        this.sessionUserId = 1
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM sessions s'))
                return { session_id: 'session-1', user_id: this.sessionUserId, device_name: 'test', created_at: 1, last_seen_at: 1, expires_at: Date.now() + 86400000, id: this.sessionUserId, email: 'owner@example.test', name: 'Owner', email_verified_at: 1, federated_only: 0, google_enabled: false }
            if (sql.includes('FROM bookmarks WHERE id'))
                return this.bookmarks.find(item => item.id === Number(values[0]) && item.user_id === Number(values[1])) || null
            if (sql.includes('FROM content_objects')) {
                if (sql.includes('WHERE id = ? AND user_id = ?')) return this.contents.find(item => item.id === values[0] && item.user_id === values[1]) || null
                if (sql.includes('WHERE id = ?')) return this.contents.find(item => item.id === values[0]) || null
            }
            if (sql.includes('FROM background_tasks')) {
                if (sql.includes('WHERE idempotency_key')) return this.tasks.find(item => item.idempotency_key === values[0] && item.user_id === values[1]) || null
                return this.tasks.find(item => item.id === values[0] && (values.length < 2 || item.user_id === values[1])) || null
            }
            return null
        }
        const all = async () => {
            if (sql.includes('FROM content_objects')) {
                return { results: this.contents.filter(item => item.bookmark_id === Number(values[0])) }
            }
            return { results: [] }
        }
        const run = async () => {
            if (sql.includes('INSERT INTO rate_limits') || sql.includes('INSERT INTO usage_counters')) return { meta: { changes: 1 } }
            if (sql.includes('INSERT INTO audit_records')) {
                this.audits.push(values)
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE sessions SET last_seen_at')) return { meta: { changes: 1 } }
            if (sql.includes('INSERT INTO bookmarks')) {
                const upload = sql.includes('VALUES (?, ?, ?, ?, ?, \'[]\'')
                const item = {
                    id: this.nextBookmarkId++, user_id: values[0], url: values[1], title: values[2], description: values[3], note: values[4],
                    highlights: upload ? '[]' : values[5], created_at: upload ? values[5] : values[6], updated_at: upload ? values[6] : values[7], collection_id: upload ? values[7] : values[8], tags: upload ? values[8] : values[9], removed_at: null
                }
                this.bookmarks.push(item)
                return { meta: { last_row_id: item.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO content_objects')) {
                const [id, userId, bookmarkId, kind, status, objectKey, filename, contentType, size, createdAt, updatedAt, clearedAt] = values
                this.contents.push({ id, user_id: userId, bookmark_id: bookmarkId, kind, status, object_key: objectKey, filename, content_type: contentType, size_bytes: size, created_at: createdAt, updated_at: updatedAt, cleared_at: clearedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO background_tasks')) {
                const [id, userId, bookmarkId, type, idempotencyKey, sourceUrl, contentId, payload, createdAt, updatedAt] = values
                const task = { id, user_id: userId, bookmark_id: bookmarkId, type, status: 'queued', progress: 0, retry_count: 0, idempotency_key: idempotencyKey, source_url: sourceUrl, content_id: contentId, payload, result_metadata: '{}', error_code: null, error_message: null, next_retry_at: null, created_at: createdAt, updated_at: updatedAt, completed_at: null }
                this.tasks.push(task)
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'processing\'')) {
                const task = this.tasks.find(item => item.id === values[1] && (item.status === 'queued' || item.status === 'retrying'))
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'processing', progress: 10, updated_at: values[0], next_retry_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'succeeded\'')) {
                const task = this.tasks.find(item => item.id === values.at(-1) && item.status === 'processing')
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'succeeded', progress: 100, result_metadata: values[0], updated_at: values[1], completed_at: values[2] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'dead_letter\'')) {
                const task = this.tasks.find(item => item.id === values.at(-1))
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'dead_letter', progress: 0, retry_count: values[0], error_code: values[1], error_message: values[2], updated_at: values[3], completed_at: values[4] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE content_objects SET status')) {
                const item = this.contents.find(content => content.id === values[2])
                if (item) Object.assign(item, { status: 'cleared', updated_at: values[0], cleared_at: values[1] })
                return { meta: { changes: item ? 1 : 0 } }
            }
            if (sql.includes('UPDATE content_objects SET content_type')) {
                const item = this.contents.find(content => content.id === values[3])
                if (item) Object.assign(item, { content_type: values[0], size_bytes: values[1], updated_at: values[2] })
                return { meta: { changes: item ? 1 : 0 } }
            }
            if (sql.includes('DELETE FROM content_objects')) {
                const before = this.contents.length
                this.contents = this.contents.filter(item => item.id !== values[0])
                return { meta: { changes: before - this.contents.length } }
            }
            if (sql.includes('DELETE FROM bookmarks')) {
                const before = this.bookmarks.length
                this.bookmarks = this.bookmarks.filter(item => !(item.id === Number(values[0]) && item.user_id === Number(values[1])))
                return { meta: { changes: before - this.bookmarks.length } }
            }
            return { meta: { changes: 1 } }
        }
        return { bind: (...next) => { values = next; return { first, all, run } } }
    }
}

class MemoryBucket {
    constructor() { this.objects = new Map() }
    async put(key, body) {
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer())
        this.objects.set(key, bytes)
    }
    async get(key) {
        const bytes = this.objects.get(key)
        return bytes ? { body: new Blob([bytes]).stream(), size: bytes.byteLength } : null
    }
    async delete(key) { this.objects.delete(key) }
}

const envFor = (db, bucket, queue, scanner = true) => ({
    DB: db,
    CONTENT_BUCKET: bucket,
    TASK_QUEUE: queue,
    SESSION_SECRET: 'content-test-secret',
    API_ORIGIN: 'https://api.example.test',
    APP_ORIGIN: 'https://app.example.test',
    CORS_ORIGINS: 'https://app.example.test',
    ENVIRONMENT: 'local',
    VERSION: 'test',
    ATTACHMENT_MAX_BYTES: '52428800',
    ...(scanner ? { SCANNER_URL: 'https://scanner.example.test/scan', SCANNER_API_KEY: 'scanner-test-key' } : {})
})

const request = (path, options = {}) => new Request('https://api.example.test' + path, options)
const cookie = 'rd_session=test-session'

test('uploads stay quarantined until the scanner clears them and never expose an R2 URL', async t => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    const queue = { messages: [], send: async message => queue.messages.push(message) }
    const env = envFor(db, bucket, queue)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async url => {
        if (url === env.SCANNER_URL) return Response.json({ clean: true })
        return originalFetch(url)
    }
    t.after(() => { globalThis.fetch = originalFetch })

    const form = new FormData()
    form.append('file', new Blob(['private attachment'], { type: 'text/plain' }), 'private.txt')
    const uploaded = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie }, body: form }), env)
    assert.equal(uploaded.status, 201)
    const body = await uploaded.json()
    assert.equal(body.content.status, 'quarantined')
    assert.equal(body.content.downloadUrl, undefined)
    assert.equal(queue.messages.length, 1)

    const blocked = await worker.fetch(request('/v1/content/' + body.content.id + '/download', { headers: { Cookie: cookie } }), env)
    assert.equal(blocked.status, 409)

    let acknowledged = false
    await worker.queue({ messages: [{ body: queue.messages[0], ack: () => { acknowledged = true }, retry: () => assert.fail('unexpected retry') }] }, env)
    assert.equal(acknowledged, true)
    const cleared = await worker.fetch(request('/v1/content/' + body.content.id + '/download', { headers: { Cookie: cookie } }), env)
    assert.equal(cleared.status, 200)
    assert.equal(await cleared.text(), 'private attachment')
})

test('attachments can bypass scanning when the Beta switch is disabled', async () => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    const queue = { messages: [], send: async message => queue.messages.push(message) }
    const env = { ...envFor(db, bucket, queue), ATTACHMENT_SCAN_ENABLED: 'false' }
    const form = new FormData()
    form.append('file', new Blob(['unscanned attachment'], { type: 'text/plain' }), 'unscanned.txt')
    const uploaded = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie }, body: form }), env)
    assert.equal(uploaded.status, 201)
    const body = await uploaded.json()
    assert.equal(body.content.status, 'cleared')
    assert.equal(queue.messages.length, 0)
    const downloaded = await worker.fetch(request('/v1/content/' + body.content.id + '/download', { headers: { Cookie: cookie } }), env)
    assert.equal(downloaded.status, 200)
    assert.equal(await downloaded.text(), 'unscanned attachment')
})

test('capture tasks are created only by an explicit request and are safety checked', async t => {
    const db = new ContentDatabase()
    db.bookmarks.push({ id: 1, user_id: 1, url: 'https://public.example.test/page', title: 'Page', description: '', note: '', highlights: '[]', collection_id: -1, tags: '[]', removed_at: null })
    db.nextBookmarkId = 2
    const bucket = new MemoryBucket()
    const queue = { messages: [], send: async message => queue.messages.push(message) }
    let renders = 0
    const env = { ...envFor(db, bucket, queue), BROWSER_RENDERING: { quickAction: async action => {
        renders++
        return action === 'screenshot'
            ? new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
            : Response.json({ success: true, result: '<html>captured</html>' })
    } } }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async url => url === env.SCANNER_URL ? Response.json({ status: 'cleared' }) : originalFetch(url)
    t.after(() => { globalThis.fetch = originalFetch })

    const created = await worker.fetch(request('/v1/raindrop', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ link: 'https://public.example.test/page', title: 'Page' }) }), env)
    assert.equal(created.status, 201)
    assert.equal(renders, 0)

    const capture = await worker.fetch(request('/v1/raindrop/1/capture', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'snapshot' }) }), env)
    assert.equal(capture.status, 202)
    const captureBody = await capture.json()
    assert.equal(captureBody.content.status, 'quarantined')
    assert.equal(queue.messages.length, 2)
    await worker.queue({ messages: [{ body: queue.messages[1], ack: () => {}, retry: () => assert.fail('unexpected retry') }] }, env)
    assert.equal(renders, 1)
    const screenshot = await worker.fetch(request('/v1/raindrop/1/capture', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'screenshot' }) }), env)
    assert.equal(screenshot.status, 202)
    await worker.queue({ messages: [{ body: queue.messages[2], ack: () => {}, retry: () => assert.fail('unexpected retry') }] }, env)
    assert.equal(renders, 2)
    const status = await worker.fetch(request('/v1/raindrop/1/capture', { headers: { Cookie: cookie } }), env)
    const captures = (await status.json()).items
    assert.equal(captures.every(item => item.status === 'cleared'), true)
    const snapshot = db.contents.find(item => item.kind === 'snapshot')
    assert.equal(new TextDecoder().decode(bucket.objects.get(snapshot.object_key)), '<html>captured</html>')
    assert.equal(captures.find(item => item.kind === 'screenshot').contentType, 'image/png')
    const storedPng = bucket.objects.get(db.contents.find(item => item.kind === 'screenshot').object_key)
    assert.deepEqual([...storedPng.slice(0, 4)], [137, 80, 78, 71])
})

test('scanner rejection keeps content quarantined and hides it from other users', async t => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    const queue = { messages: [], send: async message => queue.messages.push(message) }
    const env = envFor(db, bucket, queue)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async url => url === env.SCANNER_URL ? Response.json({ clean: false, status: 'malicious' }) : originalFetch(url)
    t.after(() => { globalThis.fetch = originalFetch })

    const form = new FormData()
    form.append('file', new Blob(['bad attachment'], { type: 'text/plain' }), 'bad.txt')
    const uploaded = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie }, body: form }), env)
    const contentId = (await uploaded.json()).content.id
    await worker.queue({ messages: [{ body: queue.messages[0], ack: () => {}, retry: () => assert.fail('unexpected retry') }] }, env)
    assert.equal(db.contents[0].status, 'quarantined')
    assert.equal(db.tasks[0].status, 'dead_letter')
    assert.match(db.tasks[0].error_code, /content_quarantined/)

    db.sessionUserId = 2
    const otherUser = await worker.fetch(request('/v1/content/' + contentId, { headers: { Cookie: cookie } }), env)
    assert.equal(otherUser.status, 404)
})

test('scanner credentials are never sent to an HTTP endpoint', async t => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    const queue = { messages: [], send: async message => queue.messages.push(message) }
    const env = envFor(db, bucket, queue)
    env.SCANNER_URL = 'http://scanner.example.test/scan'
    const originalFetch = globalThis.fetch
    let scannerCalls = 0
    globalThis.fetch = async url => {
        if (String(url) === env.SCANNER_URL) scannerCalls++
        return Response.json({ clean: true })
    }
    t.after(() => { globalThis.fetch = originalFetch })

    const form = new FormData()
    form.append('file', new Blob(['private'], { type: 'text/plain' }), 'http-scanner.txt')
    const uploaded = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie }, body: form }), env)
    await worker.queue({ messages: [{ body: queue.messages[0], ack: () => {}, retry: () => assert.fail('unexpected retry') }] }, env)
    assert.equal(scannerCalls, 0)
    assert.equal(db.contents[0].status, 'quarantined')
    assert.equal(db.tasks[0].error_code, 'scanner_not_configured')
    assert.equal(uploaded.status, 201)
})

test('the 50 MiB upload limit rejects oversized files before storage', async () => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    const queue = { send: async () => assert.fail('oversized file was queued') }
    const env = envFor(db, bucket, queue)
    const response = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'Content-Length': '52428801' }, body: 'x' }), env)
    assert.equal(response.status, 413)
    assert.equal(db.contents.length, 0)
})

test('a chunked upload without Content-Length is still bounded at 50 MiB', async () => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    const queue = { send: async () => assert.fail('oversized file was queued') }
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(52428801))
            controller.close()
        }
    })
    const env = envFor(db, bucket, queue)
    const response = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: stream, duplex: 'half' }), env)
    assert.equal(response.status, 413)
    assert.equal(db.contents.length, 0)
})

test('content upload does not report success when its safety task cannot be queued', async () => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    const queue = { send: async () => { throw new Error('queue unavailable') } }
    const env = envFor(db, bucket, queue)
    const form = new FormData()
    form.append('file', new Blob(['queued failure'], { type: 'text/plain' }), 'queue-failure.txt')
    const response = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie }, body: form }), env)
    assert.equal(response.status, 503)
    assert.equal(db.contents.length, 0)
    assert.equal(bucket.objects.size, 0)
})

test('content storage failures remove the provisional content record', async () => {
    const db = new ContentDatabase()
    const bucket = new MemoryBucket()
    bucket.put = async () => { throw new Error('storage unavailable') }
    const queue = { send: async () => assert.fail('storage failure was queued') }
    const env = envFor(db, bucket, queue)
    const form = new FormData()
    form.append('file', new Blob(['storage failure'], { type: 'text/plain' }), 'storage-failure.txt')
    const response = await worker.fetch(request('/v1/raindrop/file', { method: 'PUT', headers: { Cookie: cookie }, body: form }), env)
    assert.equal(response.status, 503)
    assert.equal(db.contents.length, 0)
})
