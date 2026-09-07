/* global globalThis */

import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import worker, { createMetadataTask, fetchPageMetadata, processMetadataTask, validateFetchableUrl } from '../src/index.js'

globalThis.crypto ||= webcrypto

class TaskDatabase {
    constructor(task = {}) {
        this.tasks = task.id ? [{
            id: task.id,
            user_id: task.user_id || 1,
            bookmark_id: task.bookmark_id || 1,
            type: task.type || 'metadata_enrichment',
            status: task.status || 'queued',
            progress: task.progress || 0,
            retry_count: task.retry_count || 0,
            idempotency_key: task.idempotency_key || 'existing',
            source_url: task.source_url || 'https://public.example.test/page',
            result_metadata: task.result_metadata || '{}',
            error_code: task.error_code || null,
            error_message: task.error_message || null,
            next_retry_at: task.next_retry_at || null,
            created_at: task.created_at || 1,
            updated_at: task.updated_at || 1,
            completed_at: task.completed_at || null
        }] : []
        this.bookmarks = [{ id: 1, user_id: 1, title: '', description: '', removed_at: null }]
        this.alerts = []
        this.nextId = 1
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM background_tasks')) {
                if (sql.includes('WHERE idempotency_key'))
                    return this.tasks.find(task => task.idempotency_key === values[0] && task.user_id === values[1]) || null
                return this.tasks.find(task => task.id === values[0] && (values.length < 2 || task.user_id === values[1])) || null
            }
            if (sql.includes('FROM bookmarks WHERE id'))
                return this.bookmarks.find(bookmark => bookmark.id === values[0] && bookmark.user_id === values[1] && (!sql.includes('removed_at IS NULL') || !bookmark.removed_at)) || null
            return null
        }
        const run = async () => {
            if (sql.includes('INSERT INTO background_tasks')) {
                const [id, userId, bookmarkId, type, key, sourceUrl, createdAt, updatedAt] = values
                if (this.tasks.some(task => task.idempotency_key === key)) return { meta: { changes: 0 } }
                this.tasks.push({ id, user_id: userId, bookmark_id: bookmarkId, type, status: 'queued', progress: 0, retry_count: 0, idempotency_key: key, source_url: sourceUrl, result_metadata: '{}', error_code: null, error_message: null, next_retry_at: null, created_at: createdAt, updated_at: updatedAt, completed_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'processing\'')) {
                const [updatedAt, id, retryAt, staleAt] = values
                const task = this.tasks.find(item => item.id === id && (
                    ['queued', 'retrying'].includes(item.status) && (!item.next_retry_at || item.next_retry_at <= retryAt) ||
                    item.status === 'processing' && item.updated_at <= staleAt))
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'processing', progress: 10, next_retry_at: null, updated_at: updatedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'queued\'')) {
                const [updatedAt, id, userId, type] = values
                const task = this.tasks.find(item => item.id === id && item.user_id === userId && item.type === type && item.status === 'dead_letter')
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'queued', progress: 0, retry_count: 0, result_metadata: '{}', error_code: null, error_message: null, next_retry_at: null, updated_at: updatedAt, completed_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'retrying\'')) {
                const [retryCount, errorCode, errorMessage, nextRetryAt, updatedAt, id] = values
                const task = this.tasks.find(item => item.id === id && item.status === 'processing')
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'retrying', progress: 10, retry_count: retryCount, error_code: errorCode, error_message: errorMessage, next_retry_at: nextRetryAt, updated_at: updatedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'dead_letter\'')) {
                const enqueueFailure = values.length === 5
                const [retryCount, errorCode, errorMessage, updatedAt, completedAt, id] = enqueueFailure
                    ? [0, values[0], values[1], values[2], values[3], values[4]]
                    : values
                const task = this.tasks.find(item => item.id === id && ['queued', 'processing', 'retrying'].includes(item.status))
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'dead_letter', progress: 0, retry_count: retryCount, error_code: errorCode, error_message: errorMessage, next_retry_at: null, updated_at: updatedAt, completed_at: completedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE background_tasks SET status = \'succeeded\'')) {
                const [metadata, updatedAt, completedAt, id] = values
                const task = this.tasks.find(item => item.id === id && item.status === 'processing')
                if (!task) return { meta: { changes: 0 } }
                Object.assign(task, { status: 'succeeded', progress: 100, result_metadata: metadata, error_code: null, error_message: null, next_retry_at: null, updated_at: updatedAt, completed_at: completedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE bookmarks SET')) {
                const [title, description, updatedAt, id, userId] = values
                const bookmark = this.bookmarks.find(item => item.id === id && item.user_id === userId && !item.removed_at)
                if (!bookmark) return { meta: { changes: 0 } }
                if (!bookmark.title) bookmark.title = title
                if (!bookmark.description) bookmark.description = description
                bookmark.updated_at = updatedAt
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO alerts')) {
                this.alerts.push({ kind: values[2], severity: values[3], route: values[4], metadata: values[6] })
                return { meta: { changes: 1 } }
            }
            return { meta: { changes: 1 } }
        }
        return { bind: (...next) => { values = next; return { first, run } } }
    }
}

class ProjectionTaskDatabase extends TaskDatabase {
    prepare(sql) {
        const statement = super.prepare(sql)
        if (!sql.includes('FROM background_tasks')) return statement
        return {
            bind: (...values) => {
                const bound = statement.bind(...values)
                return {
                    first: async () => {
                        const row = await bound.first()
                        if (!row || sql.includes('source_url')) return row
                        const projected = { ...row }
                        delete projected.source_url
                        return projected
                    },
                    run: bound.run
                }
            }
        }
    }
}

class RouteTaskDatabase extends TaskDatabase {
    constructor(task, authenticated = true) {
        super(task)
        this.authenticated = authenticated
    }

    prepare(sql) {
        if (!sql.includes('FROM sessions s')) return super.prepare(sql)
        return {
            bind: () => ({
                first: async () => this.authenticated ? {
                    session_id: 'session-1',
                    user_id: 1,
                    device_name: 'test',
                    created_at: 1,
                    last_seen_at: 1,
                    expires_at: Date.now() + 86400000,
                    id: 1,
                    email: 'owner@example.test',
                    name: 'Owner',
                    email_verified_at: 1,
                    federated_only: 0,
                    google_enabled: false
                } : null,
                run: async () => ({ meta: { changes: 1 } })
            })
        }
    }
}

const baseEnv = db => ({ DB: db, SESSION_SECRET: 'task-secret', API_ORIGIN: 'https://api.example.test' })

test('fetchable URL validation rejects internal destinations and accepts public HTTP(S)', () => {
    for (const value of [
        'http://localhost/private',
        'http://127.0.0.1:8080',
        'http://10.0.0.1',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/',
        'http://metadata.google.internal/',
        'ftp://public.example.test/file',
        'https://user:password@public.example.test/'
    ]) assert.equal(validateFetchableUrl(value).ok, false, value)
    assert.equal(validateFetchableUrl('https://public.example.test/page').ok, true)
    assert.equal(validateFetchableUrl('http://public.example.test:80/page').ok, true)
})

test('configured DNS resolution rejects private answers before fetching a hostname', async t => {
    const originalFetch = globalThis.fetch
    let originFetches = 0
    globalThis.fetch = async url => {
        if (String(url).startsWith('https://dns.example.test/resolve'))
            return Response.json({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] })
        originFetches++
        return new Response('', { status: 200 })
    }
    t.after(() => { globalThis.fetch = originalFetch })
    await assert.rejects(
        () => fetchPageMetadata('https://public.example.test/page', { FETCH_DNS_RESOLVER: 'https://dns.example.test/resolve' }),
        error => error.code === 'url_not_public'
    )
    assert.equal(originFetches, 0)
})

test('metadata task creation is idempotent and queue payload contains no URL or secret', async () => {
    const db = new TaskDatabase()
    const sent = []
    const env = { ...baseEnv(db), TASK_QUEUE: { send: async body => sent.push(body) } }
    const first = await createMetadataTask(env, null, 1, 1, 'https://public.example.test/page')
    const second = await createMetadataTask(env, null, 1, 1, 'https://public.example.test/page')
    assert.equal(first.id, second.id)
    assert.equal(db.tasks.length, 1)
    assert.deepEqual(sent, [{ taskId: first.id, type: 'metadata_enrichment' }])
})

test('queue publish failures create a redacted operational alert', async () => {
    const db = new TaskDatabase()
    const env = {
        ...baseEnv(db),
        TASK_QUEUE: { send: async () => { throw new Error('queue failed with page secret') } }
    }
    const task = await createMetadataTask(env, null, 1, 1, 'https://public.example.test/page-secret')
    assert.equal(task.status, 'dead_letter')
    assert.equal(db.alerts.length, 1)
    assert.equal(db.alerts[0].kind, 'task_enqueue_failed')
    assert.doesNotMatch(JSON.stringify(db.alerts[0]), /page-secret|queue failed/i)
})

test('queue follows redirects, enriches empty fields, and records success', async t => {
    const db = new TaskDatabase({ id: 'task-success', source_url: 'https://public.example.test/start' })
    const env = baseEnv(db)
    const originalFetch = globalThis.fetch
    const requested = []
    globalThis.fetch = async (url, options) => {
        requested.push([String(url), options.redirect])
        if (requested.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://public.example.test/final' } })
        return new Response('<html><title>Fetched title</title><meta name="description" content="Fetched description"></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    }
    t.after(() => { globalThis.fetch = originalFetch })
    const message = { body: { taskId: 'task-success' }, ack: () => {}, retry: () => {} }
    await worker.queue({ messages: [message] }, env)
    assert.deepEqual(requested, [['https://public.example.test/start', 'manual'], ['https://public.example.test/final', 'manual']])
    assert.equal(db.tasks[0].status, 'succeeded')
    assert.equal(db.tasks[0].progress, 100)
    assert.equal(db.bookmarks[0].title, 'Fetched title')
    assert.equal(db.bookmarks[0].description, 'Fetched description')
})

test('claimed tasks retain their persisted source URL after D1 projection', async t => {
    const db = new ProjectionTaskDatabase({ id: 'task-projection', source_url: 'https://public.example.test/projected' })
    const env = baseEnv(db)
    const originalFetch = globalThis.fetch
    let requested
    globalThis.fetch = async url => {
        requested = String(url)
        return new Response('<title>Projected</title>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    }
    t.after(() => { globalThis.fetch = originalFetch })
    const result = await processMetadataTask(env, 'task-projection')
    assert.equal(result.action, 'ack')
    assert.equal(requested, 'https://public.example.test/projected')
    assert.equal(db.tasks[0].status, 'succeeded')
})

test('unsafe redirect is dead-lettered without retrying', async t => {
    const db = new TaskDatabase({ id: 'task-redirect', source_url: 'https://public.example.test/start' })
    const dlq = []
    const env = { ...baseEnv(db), TASK_DLQ: { send: async body => dlq.push(body) } }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } })
    t.after(() => { globalThis.fetch = originalFetch })
    let retries = 0
    await worker.queue({ messages: [{ body: { taskId: 'task-redirect' }, ack: () => {}, retry: () => { retries++ } }] }, env)
    assert.equal(db.tasks[0].status, 'dead_letter')
    assert.equal(retries, 0)
    assert.equal(dlq.length, 1)
    assert.equal(dlq[0].failure.code, 'redirect_not_public')
})

test('metadata failures get three backoff retries before dead-letter', async t => {
    const db = new TaskDatabase({ id: 'task-failure', source_url: 'https://public.example.test/fails' })
    const dlq = []
    const env = { ...baseEnv(db), TASK_DLQ: { send: async body => dlq.push(body) } }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('network down') }
    t.after(() => { globalThis.fetch = originalFetch })
    let retries = 0
    for (let attempt = 0; attempt < 4; attempt++) {
        db.tasks[0].next_retry_at = 0
        await worker.queue({ messages: [{ body: { taskId: 'task-failure' }, ack: () => {}, retry: options => { retries++; assert.ok(options.delaySeconds > 0) } }] }, env)
    }
    assert.equal(retries, 3)
    assert.equal(db.tasks[0].status, 'dead_letter')
    assert.equal(db.tasks[0].retry_count, 3)
    assert.equal(dlq.length, 1)
    assert.equal(dlq[0].failure.code, 'metadata_fetch_failed')
})

test('processMetadataTask ignores duplicate delivery after success', async () => {
    const db = new TaskDatabase({ id: 'task-duplicate', status: 'succeeded', source_url: 'https://public.example.test/page', result_metadata: '{"title":"done"}' })
    const env = baseEnv(db)
    const originalFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = async () => { fetches++; return new Response('', { status: 200 }) }
    try {
        const result = await processMetadataTask(env, 'task-duplicate')
        assert.equal(result.action, 'skip')
        assert.equal(fetches, 0)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('stale processing tasks are reclaimable after an interrupted delivery', async t => {
    const db = new TaskDatabase({ id: 'task-stale', status: 'processing', updated_at: 1, source_url: 'https://public.example.test/recover' })
    const env = baseEnv(db)
    const originalFetch = globalThis.fetch
    let requested
    globalThis.fetch = async url => {
        requested = String(url)
        return new Response('<title>Recovered</title>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    }
    t.after(() => { globalThis.fetch = originalFetch })
    const result = await processMetadataTask(env, 'task-stale')
    assert.equal(result.action, 'ack')
    assert.equal(requested, 'https://public.example.test/recover')
    assert.equal(db.tasks[0].status, 'succeeded')
})

test('task routes enforce authentication, ownership, and retry states', async () => {
    const call = async (db, path, method = 'GET') => worker.fetch(new Request(`https://api.example.test${path}`, {
        method,
        headers: { Cookie: 'rd_session=test-session', Origin: 'https://app.example.test' }
    }), { ...baseEnv(db), CORS_ORIGINS: 'https://app.example.test' })

    const unauthenticated = await call(new RouteTaskDatabase({ id: 'task-auth' }, false), '/v1/tasks/task-auth')
    assert.equal(unauthenticated.status, 401)

    const succeededDb = new RouteTaskDatabase({ id: 'task-route', status: 'succeeded', result_metadata: '{"title":"done"}' })
    const status = await call(succeededDb, '/v1/tasks/task-route')
    assert.equal(status.status, 200)
    const statusBody = await status.json()
    assert.equal(statusBody.task.status, 'succeeded')
    assert.equal(statusBody.task.metadata.title, 'done')
    assert.equal('source_url' in statusBody.task, false)

    const progress = await call(succeededDb, '/v1/tasks/task-route/status')
    assert.equal(progress.status, 200)
    const failure = await call(succeededDb, '/v1/tasks/task-route/failure')
    assert.equal(failure.status, 200)
    assert.equal((await failure.json()).failure, null)

    const wrongOwner = await call(new RouteTaskDatabase({ id: 'task-other-user', user_id: 2 }), '/v1/tasks/task-other-user')
    assert.equal(wrongOwner.status, 404)

    const unsupported = await call(new RouteTaskDatabase({ id: 'task-unsupported', type: 'capture', status: 'dead_letter' }), '/v1/tasks/task-unsupported/retry', 'POST')
    assert.equal(unsupported.status, 400)

    const notFailed = await call(succeededDb, '/v1/tasks/task-route/retry', 'POST')
    assert.equal(notFailed.status, 409)

    const deadDb = new RouteTaskDatabase({ id: 'task-dead', status: 'dead_letter', error_code: 'metadata_fetch_failed' })
    const retried = await call(deadDb, '/v1/tasks/task-dead/retry', 'POST')
    assert.equal(retried.status, 202)
    assert.equal((await retried.json()).task.status, 'queued')
    const retriedAgain = await call(deadDb, '/v1/tasks/task-dead/retry', 'POST')
    assert.equal(retriedAgain.status, 409)
})
