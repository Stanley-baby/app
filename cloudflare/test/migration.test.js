import assert from 'node:assert/strict'
import test from 'node:test'
import worker, { normalizeMigrationArchive } from '../src/index.js'

/* global globalThis */

globalThis.crypto ||= (await import('node:crypto')).webcrypto

class MigrationDatabase {
    constructor() {
        this.users = [{ id: 1, email: 'migrator@example.test', name: 'Migrator' }]
        this.sessions = [{ id: 'session-1', user_id: 1, token_hash: 'session-hash', expires_at: Date.now() + 86400000 }]
        this.bookmarks = []
        this.collections = []
        this.archives = []
        this.mappings = []
        this.tasks = []
        this.changes = []
        this.nextBookmarkId = 1
        this.nextCollectionId = 1
        this.nextMappingId = 1
        this.nextChangeVersion = 1
    }

    session() {
        return {
            session_id: 'session-1', user_id: 1, device_name: 'test', created_at: 1,
            last_seen_at: 1, expires_at: Date.now() + 86400000, id: 1,
            email: 'migrator@example.test', name: 'Migrator', email_verified_at: 1,
            federated_only: 0, google_enabled: false
        }
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM sessions s')) return this.session()
            if (sql.includes('FROM usage_counters')) return null
            if (sql.includes('FROM bookmarks WHERE user_id')) {
                return this.bookmarks.find(item => item.user_id === Number(values[0]) && item.id === Number(values[1])) || null
            }
            if (sql.includes('FROM migration_archives')) {
                const row = this.archives.find(item => item.id === String(values[0]) && (values.length < 2 || item.user_id === Number(values[1])))
                return row ? { ...row } : null
            }
            if (sql.includes('FROM background_tasks')) {
                const row = this.tasks.find(item => item.id === String(values[0]) && (values.length < 2 || item.user_id === Number(values[1])))
                return row ? { ...row } : null
            }
            if (sql.includes('FROM bookmark_changes')) return this.changes.at(-1) || null
            return null
        }
        const all = async () => {
            if (sql.includes('FROM bookmarks WHERE user_id'))
                return { results: this.bookmarks.filter(item => item.user_id === Number(values[0]) && !item.removed_at).map(item => ({ id: item.id, url: item.url, title: item.title, collection_id: item.collection_id })) }
            if (sql.includes('FROM migration_archives'))
                return { results: this.archives.filter(item => item.user_id === Number(values[0])).map(item => ({ ...item })) }
            if (sql.includes('FROM migration_mappings'))
                return { results: this.mappings.filter(item => item.archive_id === String(values[0]) && item.user_id === Number(values[1])).map(item => ({ ...item })) }
            return { results: [] }
        }
        const run = async () => {
            if (sql.includes('INSERT INTO rate_limits') || sql.includes('INSERT INTO usage_counters') || sql.includes('INSERT INTO audit_records'))
                return { meta: { changes: 1 } }
            if (sql.includes('UPDATE sessions SET last_seen_at')) return { meta: { changes: 1 } }
            if (sql.includes('INSERT INTO migration_archives')) {
                const [id, userId, source, archiveJson, preflightJson, collectionCount, bookmarkCount, totalItems, createdAt, updatedAt] = values
                this.archives.push({ id, user_id: userId, source, archive_json: archiveJson, preflight_json: preflightJson, review_json: '{}', status: 'review', collection_count: collectionCount, bookmark_count: bookmarkCount, total_items: totalItems, completed_items: 0, task_id: null, error_code: null, error_message: null, created_at: createdAt, updated_at: updatedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE migration_archives SET review_json')) {
                const row = this.archives.find(item => item.id === values[2] && item.user_id === Number(values[3]))
                if (row) Object.assign(row, { review_json: values[0], updated_at: values[1] })
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE migration_archives SET status = \'queued\', task_id')) {
                const row = this.archives.find(item => item.id === values[2] && item.user_id === Number(values[3]))
                if (row) Object.assign(row, { status: 'queued', task_id: values[0], updated_at: values[1] })
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE migration_archives SET status = ?, completed_items')) {
                const row = this.archives.find(item => item.id === values[3])
                if (row) Object.assign(row, { status: values[0], completed_items: values[1], updated_at: values[2] })
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE migration_archives SET status = \'succeeded\'')) {
                const row = this.archives.find(item => item.id === values[2])
                if (row) Object.assign(row, { status: 'succeeded', completed_items: values[0], error_code: null, error_message: null, updated_at: values[1] })
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE migration_archives SET status = ?, error_code')) {
                const row = this.archives.find(item => item.id === values[4])
                if (row) Object.assign(row, { status: values[0], error_code: values[1], error_message: values[2], updated_at: values[3] })
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE migration_archives SET status = \'queued\', error_code')) {
                const row = this.archives.find(item => item.id === values[1] && item.user_id === Number(values[2]))
                if (row) Object.assign(row, { status: 'queued', error_code: null, error_message: null, updated_at: values[0] })
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('migration_mappings')) {
                const [archiveId, userId, sourceType, sourceId, resourceType, resourceId, decision, createdAt] = values
                if (!this.mappings.some(item => item.archive_id === archiveId && item.source_type === sourceType && item.source_id === String(sourceId))) {
                    this.mappings.push({ id: this.nextMappingId++, archive_id: archiveId, user_id: userId, source_type: sourceType, source_id: String(sourceId), resource_type: resourceType, resource_id: resourceId, decision, created_at: createdAt })
                    return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
            }
            if (sql.includes('INSERT INTO background_tasks')) {
                const [id, userId, type, idempotencyKey, sourceUrl, payload, createdAt, updatedAt] = values
                const existing = this.tasks.find(item => item.idempotency_key === idempotencyKey)
                if (existing) return { meta: { changes: 0 } }
                this.tasks.push({ id, user_id: userId, bookmark_id: null, type, status: 'queued', progress: 0, retry_count: 0, idempotency_key: idempotencyKey, source_url: sourceUrl, content_id: null, payload, result_metadata: '{}', error_code: null, error_message: null, next_retry_at: null, created_at: createdAt, updated_at: updatedAt, completed_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'processing\'')) {
                const [updatedAt, id, retryAt, staleAt] = values
                const task = this.tasks.find(item => item.id === id && ((['queued', 'retrying'].includes(item.status) && (!item.next_retry_at || item.next_retry_at <= retryAt)) || (item.status === 'processing' && item.updated_at <= staleAt)))
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'processing', progress: 10, next_retry_at: null, updated_at: updatedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = ?, progress')) {
                const task = this.tasks.find(item => item.id === values[4])
                if (task) Object.assign(task, { status: values[0], progress: values[1], result_metadata: values[2], updated_at: values[3] })
                return { meta: { changes: task ? 1 : 0 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'succeeded\'')) {
                const task = this.tasks.find(item => item.id === values[3])
                if (task) Object.assign(task, { status: 'succeeded', progress: 100, result_metadata: values[0], updated_at: values[1], completed_at: values[2], error_code: null, error_message: null })
                return { meta: { changes: task ? 1 : 0 } }
            }
            if (sql.includes('INSERT INTO collections')) {
                const [userId, title, parentId, createdAt, updatedAt, slug] = values
                const item = { id: this.nextCollectionId++, user_id: Number(userId), title, parent_id: parentId, created_at: createdAt, updated_at: updatedAt, slug, is_public: 0, removed_at: null }
                this.collections.push(item)
                return { meta: { last_row_id: item.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO collection_collaborators')) return { meta: { changes: 1 } }
            if (sql.includes('INSERT INTO bookmarks')) {
                const [userId, url, title, description, note, highlights, createdAt, updatedAt, collectionId, tags] = values
                const item = { id: this.nextBookmarkId++, user_id: Number(userId), url, title, description, note, highlights, created_at: createdAt, updated_at: updatedAt, collection_id: collectionId, tags, removed_at: null, change_version: this.nextChangeVersion }
                this.bookmarks.push(item)
                this.changes.push({ version: this.nextChangeVersion++, changed_at: updatedAt })
                return { meta: { last_row_id: item.id, changes: 1 } }
            }
            return { meta: { changes: 1 } }
        }
        return { bind: (...next) => { values = next; return { first, all, run } } }
    }
}

const envFor = db => ({
    DB: db,
    SESSION_SECRET: 'migration-secret',
    API_ORIGIN: 'https://api.example.test',
    APP_ORIGIN: 'https://app.example.test',
    CORS_ORIGINS: 'https://app.example.test',
    ENVIRONMENT: 'local',
    VERSION: 'test',
    TASK_QUEUE: { send: async () => {} }
})

const request = (path, options = {}) => new Request('https://api.example.test' + path, {
    headers: { Cookie: 'rd_session=test-session', 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
})

const body = value => ({ body: JSON.stringify(value) })

test('migration preflight normalizes source IDs and preserves duplicate-review inputs', () => {
    const archive = normalizeMigrationArchive({
        source: 'synthetic',
        collections: [{ id: 'collection-1', title: 'Imported' }],
        bookmarks: [{
            id: 'bookmark-1',
            url: 'https://example.com/imported',
            title: 'Imported bookmark',
            collectionId: 'collection-1',
            tags: ['migrated'],
            highlights: [{ text: 'keep this' }]
        }]
    })

    assert.equal(archive.source, 'synthetic')
    assert.deepEqual(archive.collections[0], {
        sourceId: 'collection-1',
        title: 'Imported',
        parentSourceId: null,
        slug: ''
    })
    assert.deepEqual(archive.bookmarks[0], {
        sourceId: 'bookmark-1',
        url: 'https://example.com/imported',
        title: 'Imported bookmark',
        description: '',
        note: '',
        tags: ['migrated'],
        highlights: [{ text: 'keep this' }],
        collectionSourceId: 'collection-1'
    })
})

test('migration preflight requires duplicate decisions and imports with resumable mappings', async () => {
    const db = new MigrationDatabase()
    db.bookmarks.push({ id: 9, user_id: 1, url: 'https://example.com/existing', title: 'Existing', collection_id: -1, removed_at: null })
    const env = envFor(db)
    const archive = {
        source: 'synthetic',
        collections: [{ id: 'c1', title: 'Imported collection' }],
        bookmarks: [
            { id: 'b1', url: 'https://example.com/existing', title: 'Keep duplicate' },
            { id: 'b2', url: 'https://example.com/new', title: 'New bookmark', collectionId: 'c1', tags: ['imported'] }
        ]
    }

    const preflight = await worker.fetch(request('/v1/import/preflight', { method: 'POST', ...body(archive) }), env)
    assert.equal(preflight.status, 201)
    const preflightBody = await preflight.json()
    assert.equal(preflightBody.preflight.counts.duplicates, 1)
    assert.equal(preflightBody.preflight.duplicates[0].decision, null)
    const archiveId = preflightBody.archiveId

    const blocked = await worker.fetch(request(`/v1/import/${archiveId}/commit`, { method: 'POST' }), env)
    assert.equal(blocked.status, 409)
    assert.equal((await blocked.json()).error, 'duplicate_review_required')

    const review = await worker.fetch(request(`/v1/import/${archiveId}/review`, { method: 'POST', ...body({ decisions: [{ sourceId: 'b1', decision: 'skip' }] }) }), env)
    assert.equal(review.status, 200)
    assert.equal((await review.json()).unresolvedDuplicates, 0)

    const committed = await worker.fetch(request(`/v1/import/${archiveId}/commit`, { method: 'POST' }), env)
    assert.equal(committed.status, 202)
    const taskId = (await committed.json()).taskId
    assert.ok(taskId)

    const queued = await worker.fetch(request(`/v1/import/${archiveId}/status`), env)
    assert.equal((await queued.json()).task.status, 'queued')

    await worker.queue({ messages: [{ body: { taskId }, ack() {}, retry() { assert.fail('unexpected retry') } }] }, env)
    const status = await worker.fetch(request(`/v1/import/${archiveId}/status`), env)
    const statusBody = await status.json()
    assert.equal(statusBody.status, 'succeeded')
    assert.equal(statusBody.task.status, 'succeeded')
    assert.equal(statusBody.task.progress, 100)

    const mappings = await worker.fetch(request(`/v1/import/${archiveId}/mappings`), env)
    const mappingBody = await mappings.json()
    assert.equal(mappingBody.items.length, 3)
    assert.deepEqual(mappingBody.items.map(item => item.sourceId).sort(), ['b1', 'b2', 'c1'])
    assert.equal(mappingBody.items.find(item => item.sourceId === 'b1').resourceId, 9)
    assert.equal(db.bookmarks.filter(item => item.user_id === 1).length, 2)
    assert.equal(db.collections.length, 1)

    db.tasks[0].status = 'queued'
    db.archives[0].status = 'queued'
    await worker.queue({ messages: [{ body: { taskId }, ack() {}, retry() { assert.fail('unexpected retry') } }] }, env)
    assert.equal(db.bookmarks.filter(item => item.user_id === 1).length, 2)
    assert.equal(db.collections.length, 1)
})
