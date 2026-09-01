import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import worker, { purgeBackups, scheduleBackups } from '../src/index.js'

/* global globalThis, Uint8Array, DataView */

globalThis.crypto ||= webcrypto
const encoder = new TextEncoder()

class BackupDatabase {
    constructor() {
        this.users = [
            { id: 1, email: 'one@example.test', name: 'One' },
            { id: 2, email: 'two@example.test', name: 'Two' },
            { id: 3, email: 'three@example.test', name: 'Three' }
        ]
        this.sessionUserId = 1
        this.collections = []
        this.collaborators = []
        this.bookmarks = []
        this.contents = []
        this.backups = []
        this.audits = []
    }

    session() {
        const user = this.users.find(item => item.id === this.sessionUserId)
        return user && {
            session_id: 'session-' + user.id,
            user_id: user.id,
            device_name: 'test',
            created_at: 1,
            last_seen_at: 1,
            expires_at: Date.now() + 86400000,
            ...user,
            email_verified_at: 1,
            federated_only: 0
        }
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM sessions s')) return this.session()
            if (sql.includes('FROM usage_counters')) return null
            if (sql.includes('FROM collection_collaborators') && sql.includes('SELECT role'))
                return this.collections.find(collection => collection.id === Number(values[0])) &&
                    this.collaborators.find(item => item.collection_id === Number(values[0]) && item.user_id === Number(values[1])) || null
            if (sql.includes('FROM collections WHERE id'))
                return this.collections.find(item => item.id === Number(values[0])) || null
            if (sql.includes('FROM bookmarks WHERE id')) {
                const bookmark = this.bookmarks.find(item => item.id === Number(values[0]))
                return bookmark && (!sql.includes('user_id = ?') || bookmark.user_id === Number(values[1])) ? bookmark : null
            }
            if (sql.includes('FROM backups WHERE')) {
                if (sql.includes('id = ? AND user_id = ?'))
                    return this.backups.find(item => item.id === values[0] && item.user_id === Number(values[1])) || null
                if (sql.includes('id = ?')) return this.backups.find(item => item.id === values[0]) || null
                return this.backups.find(item => item.user_id === Number(values[0]) && item.kind === values[1] && item.period_key === values[2]) || null
            }
            return null
        }
        const all = async () => {
            if (sql.includes('SELECT id FROM users'))
                return { results: this.users.filter(item => item.id > Number(values[0] || 0)).slice(0, Number(values[1] || 100)).map(item => ({ id: item.id })) }
            if (sql.includes('FROM bookmarks b')) {
                const userId = Number(values[0])
                const shared = new Set(this.collaborators.filter(item => item.user_id === userId).map(item => item.collection_id))
                return { results: this.bookmarks.filter(item => !item.removed_at && (item.user_id === userId || shared.has(item.collection_id))).map(item => ({ ...item })) }
            }
            if (sql.includes('FROM collections c')) {
                const userId = Number(values[0])
                const shared = new Set(this.collaborators.filter(item => item.user_id === userId).map(item => item.collection_id))
                return { results: this.collections.filter(item => !item.removed_at && (item.user_id === userId || shared.has(item.id))).map(item => ({ ...item })) }
            }
            if (sql.includes('FROM content_objects'))
                return { results: this.contents.filter(item => values.map(Number).includes(item.bookmark_id) && item.status === 'cleared').map(item => ({ ...item })) }
            if (sql.includes('FROM backups WHERE user_id'))
                return { results: this.backups.filter(item => item.user_id === Number(values[0]) && (!sql.includes('status = \'succeeded\'') || item.status === 'succeeded')).sort((a, b) => b.created_at - a.created_at).map(item => ({ ...item })) }
            if (sql.includes('FROM backups WHERE kind IN'))
                return { results: this.backups.filter(item => ['daily', 'monthly'].includes(item.kind) && item.status === 'succeeded').sort((a, b) => a.user_id - b.user_id || a.kind.localeCompare(b.kind) || b.created_at - a.created_at).map(item => ({ ...item })) }
            return { results: [] }
        }
        const run = async () => {
            if (sql.includes('INSERT INTO rate_limits') || sql.includes('INSERT INTO usage_counters')) return { meta: { changes: 1 } }
            if (sql.includes('INSERT INTO audit_records')) {
                this.audits.push(values)
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE sessions SET last_seen_at')) return { meta: { changes: 1 } }
            if (sql.includes('INSERT OR IGNORE INTO backups')) {
                if (this.backups.some(item => item.user_id === Number(values[1]) && item.kind === values[2] && item.period_key === values[3]))
                    return { meta: { changes: 0 } }
                this.backups.push({
                    id: values[0], user_id: Number(values[1]), kind: values[2], period_key: values[3], status: 'queued',
                    object_key: values[4], size_bytes: 0, error_code: null, error_message: null,
                    created_at: values[5], updated_at: values[6], completed_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE backups SET status = \'processing\'')) {
                const item = this.backups.find(backup => backup.id === values[1] && backup.status === 'queued')
                if (!item) return { meta: { changes: 0 } }
                item.status = 'processing'
                item.updated_at = values[0]
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE backups SET status = \'succeeded\'')) {
                const item = this.backups.find(backup => backup.id === values[3] && backup.status === 'processing')
                if (!item) return { meta: { changes: 0 } }
                Object.assign(item, { status: 'succeeded', size_bytes: values[0], updated_at: values[1], completed_at: values[2] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE backups SET status = \'failed\'')) {
                const item = this.backups.find(backup => backup.id === values[4] && ['queued', 'processing'].includes(backup.status))
                if (!item) return { meta: { changes: 0 } }
                Object.assign(item, { status: 'failed', error_code: values[0], error_message: values[1], updated_at: values[2], completed_at: values[3] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE backups SET status = \'queued\'')) {
                const id = sql.includes('error_code = ?') ? values[3] : values[1]
                const item = this.backups.find(backup => backup.id === id && ['failed', 'processing'].includes(backup.status))
                if (!item) return { meta: { changes: 0 } }
                Object.assign(item, {
                    status: 'queued',
                    error_code: sql.includes('error_code = ?') ? values[0] : null,
                    error_message: sql.includes('error_message = ?') ? values[1] : null,
                    updated_at: sql.includes('error_code = ?') ? values[2] : values[0],
                    completed_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('DELETE FROM backups')) {
                const before = this.backups.length
                this.backups = sql.includes('WHERE id = ?')
                    ? this.backups.filter(item => item.id !== values[0])
                    : this.backups.filter(item => item.user_id !== Number(values[0]))
                return { meta: { changes: before - this.backups.length } }
            }
            if (sql.includes('INSERT INTO alerts')) return { meta: { changes: 1 } }
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
        return bytes ? { body: new Blob([bytes]).stream(), size: bytes.length } : null
    }
    async delete(key) { this.objects.delete(key) }
}

const envFor = (db, bucket, queue) => ({
    DB: db,
    BACKUP_BUCKET: bucket,
    CONTENT_BUCKET: bucket,
    TASK_QUEUE: queue,
    SESSION_SECRET: 'backup-test-secret',
    API_ORIGIN: 'https://api.example.test',
    APP_ORIGIN: 'https://app.example.test',
    CORS_ORIGINS: 'https://app.example.test',
    ENVIRONMENT: 'local',
    VERSION: 'test'
})

const request = (path, options = {}) => new Request('https://api.example.test' + path, options)

const zipEntries = bytes => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const decoder = new TextDecoder()
    const entries = new Map()
    let offset = 0
    while (view.getUint32(offset, true) === 0x04034b50) {
        const size = view.getUint32(offset + 18, true)
        const nameSize = view.getUint16(offset + 26, true)
        const extraSize = view.getUint16(offset + 28, true)
        const bodyOffset = offset + 30 + nameSize + extraSize
        const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameSize))
        entries.set(name, bytes.subarray(bodyOffset, bodyOffset + size))
        offset = bodyOffset + size
    }
    assert.equal(view.getUint32(offset, true), 0x02014b50)
    return entries
}

test('exports include only authorized Bookmarks and Cleared Content', async () => {
    const db = new BackupDatabase()
    db.sessionUserId = 2
    db.collections = [
        { id: 10, user_id: 1, title: 'Shared', parent_id: null, removed_at: null },
        { id: 20, user_id: 3, title: 'Private', parent_id: null, removed_at: null }
    ]
    db.collaborators = [{ collection_id: 10, user_id: 2, role: 'viewer' }]
    db.bookmarks = [
        { id: 1, user_id: 1, collection_id: 10, url: 'https://shared.example.test', title: 'Authorized', description: '', note: '', tags: '[]', highlights: '[]', created_at: 1, updated_at: 1, removed_at: null },
        { id: 2, user_id: 2, collection_id: -1, url: 'https://own.example.test', title: 'Own', description: '', note: '', tags: '[]', highlights: '[]', created_at: 2, updated_at: 2, removed_at: null },
        { id: 3, user_id: 3, collection_id: 20, url: 'https://private.example.test', title: 'Unauthorized', description: 'secret', note: '', tags: '[]', highlights: '[]', created_at: 3, updated_at: 3, removed_at: null }
    ]
    db.contents = [
        { id: 'allowed', user_id: 1, bookmark_id: 1, kind: 'attachment', status: 'cleared', object_key: 'content/1/allowed', filename: 'allowed.txt', content_type: 'text/plain', size_bytes: 9 },
        { id: 'hidden', user_id: 3, bookmark_id: 3, kind: 'attachment', status: 'cleared', object_key: 'content/3/hidden', filename: 'hidden.txt', content_type: 'text/plain', size_bytes: 6 }
    ]
    const bucket = new MemoryBucket()
    await bucket.put('content/1/allowed', encoder.encode('authorized'))
    await bucket.put('content/3/hidden', encoder.encode('secret'))
    const env = envFor(db, bucket, { send: async () => {} })

    const response = await worker.fetch(request('/v1/raindrops/0/export.zip', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'application/zip')
    const entries = zipEntries(new Uint8Array(await response.arrayBuffer()))
    const body = [...entries.values()].map(bytes => new TextDecoder().decode(bytes)).join('\n')
    assert.deepEqual([...entries.keys()].filter(name => name.startsWith('attachments/')), ['attachments/1/allowed.txt'])
    assert.match(body, /Authorized/)
    assert.match(body, /authorized/)
    assert.doesNotMatch(body, /Unauthorized|secret|hidden\.txt/)

    env.BACKUP_MAX_BYTES = '8'
    const tooLarge = await worker.fetch(request('/v1/raindrops/0/export.zip', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(tooLarge.status, 413)
})

test('a transient backup storage failure retries and remains idempotent', async () => {
    const db = new BackupDatabase()
    const bucket = new MemoryBucket()
    let failed = false
    bucket.put = async (key, body) => {
        if (!failed) {
            failed = true
            throw new Error('temporary storage failure')
        }
        MemoryBucket.prototype.put.call(bucket, key, body)
    }
    const queue = { messages: [], send: async message => queue.messages.push(message) }
    const env = envFor(db, bucket, queue)
    await scheduleBackups(env, Date.parse('2026-09-02T00:00:00Z'))
    let retried = false
    await worker.queue({ messages: [{ body: queue.messages[0], ack: () => assert.fail('unexpected ack'), retry: () => { retried = true } }] }, env)
    assert.equal(retried, true)
    assert.equal(db.backups[0].status, 'queued')
    await worker.queue({ messages: [{ body: queue.messages[0], ack: () => {}, retry: () => assert.fail('unexpected retry') }] }, env)
    assert.equal(db.backups[0].status, 'succeeded')
    await scheduleBackups(env, Date.parse('2026-09-02T01:00:00Z'))
    assert.equal(db.backups.filter(item => item.user_id === 1 && item.kind === 'daily').length, 1)
})

test('manual and scheduled backups complete through the Queue and retain restore points', async () => {
    const db = new BackupDatabase()
    db.bookmarks = [{ id: 1, user_id: 1, collection_id: -1, url: 'https://example.test', title: 'Bookmark', description: '', note: '', tags: '[]', highlights: '[]', created_at: 1, updated_at: 1, removed_at: null }]
    const bucket = new MemoryBucket()
    const queue = { messages: [], send: async message => queue.messages.push(message) }
    const env = envFor(db, bucket, queue)
    const created = await worker.fetch(request('/v1/backup', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(created.status, 202)
    const createdBody = await created.json()
    assert.equal(queue.messages.length, 1)
    const pendingList = await worker.fetch(request('/v1/backups', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.deepEqual((await pendingList.json()).items, [])

    let acknowledged = false
    await worker.queue({ messages: [{ body: queue.messages[0], ack: () => { acknowledged = true }, retry: () => assert.fail('unexpected retry') }] }, env)
    assert.equal(acknowledged, true)
    assert.equal(db.backups[0].status, 'succeeded')
    assert.ok(bucket.objects.has(db.backups[0].object_key))

    const listed = await worker.fetch(request('/v1/backups', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal((await listed.json()).items[0].status, 'succeeded')
    const text = await worker.fetch(request('/v1/backup/' + createdBody.backupId + '.txt', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(text.status, 200)
    assert.match(await text.text(), /Bookmark/)
    const zip = await worker.fetch(request('/v1/backup/' + createdBody.backupId + '.zip', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(zip.status, 200)
    assert.ok(zipEntries(new Uint8Array(await zip.arrayBuffer())).has('bookmarks.json'))

    db.sessionUserId = 2
    const forbidden = await worker.fetch(request('/v1/backup/' + createdBody.backupId + '.zip', { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(forbidden.status, 404)
    db.sessionUserId = 1

    db.backups = []
    queue.messages = []
    await scheduleBackups(env, Date.parse('2026-09-01T00:00:00Z'))
    assert.equal(db.backups.filter(item => item.kind === 'daily').length, 3)
    assert.equal(db.backups.filter(item => item.kind === 'monthly').length, 3)
    assert.equal(queue.messages.length, 6)

    db.backups = [...Array(31)].map((_, index) => ({ id: 'd' + index, user_id: 1, kind: 'daily', status: 'succeeded', object_key: 'd' + index, size_bytes: 1, created_at: index, updated_at: index, completed_at: index }))
        .concat([...Array(13)].map((_, index) => ({ id: 'm' + index, user_id: 1, kind: 'monthly', status: 'succeeded', object_key: 'm' + index, size_bytes: 1, created_at: index, updated_at: index, completed_at: index })))
    for (const item of db.backups) await bucket.put(item.object_key, encoder.encode(item.id))
    await purgeBackups(env)
    assert.equal(db.backups.filter(item => item.kind === 'daily').length, 30)
    assert.equal(db.backups.filter(item => item.kind === 'monthly').length, 12)
    assert.equal(bucket.objects.has('d0'), false)
    assert.equal(bucket.objects.has('m0'), false)
})
