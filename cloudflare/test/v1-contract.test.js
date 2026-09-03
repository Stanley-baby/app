/* global globalThis */

import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import yaml from 'yaml'
import worker, { auditRoute } from '../src/index.js'

const require = createRequire(import.meta.url)
const manifest = require('../contracts/v1-routes.json')
const fixture = require('../contracts/v1-fixtures.json')

globalThis.crypto ||= webcrypto

const openapi = yaml.parse(fs.readFileSync(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'))

const normalizePath = path => String(path)
    .replace(/\/export\.(?:html|csv|txt|zip)$/, '/export.{format}')
    .replace(/\/(?:backup|backups)\/:id\.(?:html|csv|txt|zip)$/, '/backup/{id}.{format}')
    .replace(/:([A-Za-z][\w-]*)(?=\/|$)/g, '{$1}')

const keyFor = (method, path) => method + ' ' + path

test('versioned v1 fixtures cover every route and required QA dimension', () => {
    assert.equal(fixture.version, manifest.version)
    assert.equal(fixture.apiVersion, 'v1')
    assert.deepEqual(fixture.errors.unexpected, { status: 500, error: 'internal_error', alert: 'api_error', redacted: true })
    const fixtureByKey = new Map(fixture.routes.map(route => [keyFor(route.method, route.path), route]))
    assert.equal(fixtureByKey.size, manifest.routes.length)

    for (const route of manifest.routes) {
        const item = fixtureByKey.get(keyFor(route.method, route.path))
        assert.ok(item, `missing fixture for ${route.method} ${route.path}`)
        assert.deepEqual(item.request.method, route.method)
        assert.ok(item.request.path.startsWith('/v1/'))
        if (!['GET', 'HEAD'].includes(route.method)) assert.ok(item.request.body && typeof item.request.body === 'object')
        assert.deepEqual(Object.keys(item.cases).sort(), ['authentication', 'pagination', 'permission', 'success', 'sync', 'validation'])
        for (const [name, coverage] of Object.entries(item.cases)) {
            const entries = Array.isArray(coverage) ? coverage : [coverage]
            for (const entry of entries) {
                if (entry === null) continue
                if (typeof entry === 'object') {
                    assert.ok(Number.isInteger(entry.status), `${route.path} ${name} status missing`)
                    assert.ok(route.responses.includes(entry.status), `${route.path} ${name} status is undeclared`)
                    if (name === 'sync') assert.match(entry.assertion || '', /changeVersion|marker/i)
                } else {
                    assert.ok(Number.isInteger(entry), `${route.path} ${name} status missing`)
                    assert.ok(route.responses.includes(entry), `${route.path} ${name} status is undeclared`)
                }
            }
        }
        if (item.cases.pagination !== null) assert.ok(item.request.query)
        assert.deepEqual(item.responses, route.responses)
    }
})

test('OpenAPI v1 paths and methods stay in lockstep with the route manifest', () => {
    assert.deepEqual(openapi['x-error-alerts']?.api_error, {
        response: 'internal_error',
        metadata: ['code', 'status'],
        redacted: true
    })
    const openapiRoutes = new Map()
    for (const route of manifest.routes) {
        const path = normalizePath(route.path)
        const operation = openapi.paths[path]?.[route.method.toLowerCase()]
        assert.ok(operation, `missing OpenAPI operation for ${route.method} ${route.path}`)
        if (route.authentication === 'required')
            assert.deepEqual(operation.security, [{ SessionCookie: [] }], `OpenAPI ${route.method} ${path} must require the session cookie`)
        else assert.deepEqual(operation.security, [], `OpenAPI ${route.method} ${path} must be explicitly public`)
        const responses = Object.keys(operation.responses || {}).map(Number)
        for (const status of route.responses)
            assert.ok(responses.includes(status), `OpenAPI ${route.method} ${path} omits ${status}`)
        assert.equal(operation.responses['500']?.$ref, '#/components/responses/InternalError', `OpenAPI ${route.method} ${path} must use the redacted 500 response`)
        openapiRoutes.set(keyFor(route.method, path), true)
    }

    for (const [path, item] of Object.entries(openapi.paths)) {
        if (!path.startsWith('/v1/')) continue
        for (const method of Object.keys(item).filter(value => ['get', 'post', 'put', 'patch', 'delete'].includes(value)))
            assert.ok(openapiRoutes.has(keyFor(method.toUpperCase(), path)), `OpenAPI exposes an untracked route: ${method.toUpperCase()} ${path}`)
    }
})

const materializePath = (path, { collectionId = '0', contentId = 'fixture-content', userId = '2', id = 'fixture-id', slug = 'fixture-slug' } = {}) => path
    .replaceAll(':collectionId', collectionId)
    .replaceAll(':contentId', contentId)
    .replaceAll(':userId', userId)
    .replaceAll(':id', id)
    .replaceAll(':slug', slug)

const fixtureRequest = (item, { query = item.request.query, body = item.request.body, cookie = true, collectionId = '0', id = 'fixture-id', contentId = 'fixture-content' } = {}) => {
    const params = new URLSearchParams(query || {})
    const path = materializePath(item.request.path, { collectionId, id, contentId }) + (params.toString() ? '?' + params : '')
    const headers = new Headers()
    for (const [name, value] of Object.entries(item.request.headers || {})) {
        if (name.toLowerCase() === 'cookie' && !cookie) continue
        headers.set(name, value === '{{session-cookie}}' ? 'rd_session=fixture-session' : value)
    }
    if (!['GET', 'HEAD'].includes(item.request.method) && body !== undefined && body !== null) {
        headers.set('Content-Type', 'application/json')
        return new Request('https://api.example.test' + path, {
            method: item.request.method,
            headers,
            body: JSON.stringify(body || {})
        })
    }
    return new Request('https://api.example.test' + path, { method: item.request.method, headers })
}

class UnauthenticatedDatabase {
    prepare(sql) {
        return {
            bind: () => ({
                first: async () => null,
                all: async () => ({ results: [] }),
                run: async () => ({ meta: { changes: sql.includes('INSERT INTO rate_limits') ? 1 : 0 } })
            })
        }
    }
}

test('authentication fixtures execute for every protected v1 route', async () => {
    const env = {
        DB: new UnauthenticatedDatabase(),
        ENVIRONMENT: 'beta',
        VERSION: '0.1.0-beta',
        APP_ORIGIN: 'https://beta.example.test',
        API_ORIGIN: 'https://api.example.test',
        CORS_ORIGINS: 'https://beta.example.test',
        SESSION_SECRET: 'session-secret',
        RATE_LIMIT_PER_MINUTE: '1000'
    }
    const protectedRoutes = fixture.routes.filter(item => item.cases.authentication !== null)
    assert.equal(protectedRoutes.length, manifest.routes.filter(route => route.authentication === 'required').length)
    for (const item of protectedRoutes) {
        const response = await worker.fetch(fixtureRequest(item, { cookie: false }), env)
        assert.equal(response.status, item.cases.authentication, `${item.request.method} ${item.request.path}`)
        const body = await response.json()
        assert.equal(body.error, 'auth_required', `${item.request.method} ${item.request.path}`)
    }
})

test('the runtime route inventory resolves every manifest path', () => {
    for (const item of fixture.routes) {
        const request = fixtureRequest(item, {
            cookie: false,
            id: '1',
            collectionId: '1',
            contentId: 'fixture-content'
        })
        assert.notEqual(auditRoute(request), '/v1/unknown', `${item.request.method} ${item.request.path}`)
    }
})

class ContractDatabase {
    prepare(sql) {
        const session = {
            session_id: 'fixture-session', user_id: 1, id: 1, email: 'fixture@example.test',
            name: 'Fixture', email_verified_at: 1, federated_only: 0, google_enabled: false,
            expires_at: Date.now() + 86400000
        }
        const collection = { id: 1, user_id: 1, title: 'Fixture', parent_id: null, slug: 'fixture', is_public: 0, removed_at: null }
        const bookmark = {
            id: 1, user_id: 1, url: 'http://127.0.0.1', title: 'Fixture', description: '', note: '',
            cover: '', collection_id: -1, tags: '[]', highlights: '[]', removed_at: null,
            created_at: Date.now(), updated_at: Date.now(), change_version: 1
        }
        const first = async () => {
            if (sql.includes('FROM sessions s')) return session
            if (sql.includes('FROM collections')) return collection
            if (sql.includes('FROM bookmarks')) return bookmark
            if (sql.includes('FROM users WHERE id')) return { id: 2, name: 'Target', email: 'target@example.test' }
            if (sql.includes('FROM background_tasks')) return {
                id: 'fixture-task', user_id: 1, bookmark_id: 1, type: 'unknown', status: 'failed', progress: 0,
                retry_count: 0, idempotency_key: 'fixture', source_url: 'https://example.test', content_id: null,
                payload: '{}', result_metadata: '{}', error_code: 'fixture', error_message: 'fixture',
                next_retry_at: null, created_at: Date.now(), updated_at: Date.now(), completed_at: Date.now()
            }
            if (sql.includes('FROM migration_archives')) return {
                id: 'fixture-id', user_id: 1, source: 'fixture', archive_json: '{}',
                preflight_json: '{"duplicates":[]}', review_json: '{}', status: 'review',
                collection_count: 0, bookmark_count: 0, asset_count: 0, total_items: 0,
                completed_items: 0, task_id: 'fixture-task', error_code: null, error_message: null,
                created_at: Date.now(), updated_at: Date.now()
            }
            if (sql.includes('FROM content_objects')) return {
                id: 'fixture-content', bookmark_id: 1, kind: 'attachment', content_type: 'text/html',
                status: 'cleared', object_key: 'fixture', size_bytes: 1
            }
            return null
        }
        const all = async () => ({ results: [] })
        const run = async () => ({ meta: { changes: 1, last_row_id: 1 } })
        return { bind: () => ({ first, all, run }) }
    }
}

const validationRequest = item => {
    const numericId = item.request.path.startsWith('/v1/collection/') || item.request.path.startsWith('/v1/raindrop/')
    let body = item.request.body
    if (item.path === '/v1/collection/:id' && item.method === 'PUT') body = { title: 'x'.repeat(201) }
    if (item.path === '/v1/raindrop/:id' && item.method === 'PUT') body = { title: 'x'.repeat(501) }
    if (item.path === '/v1/import/:id/review') body = { decisions: { fixture: 'invalid' } }
    if (item.path === '/v1/collection/:id/sharing' && item.method === 'POST') body = { role: 'invalid' }
    if (item.path === '/v1/collection/:id/sharing/:userId' && ['PUT', 'PATCH'].includes(item.method)) body = { role: 'invalid' }
    if (['/v1/raindrop/file', '/v1/content/upload', '/v1/raindrop/:id/attachments'].includes(item.path)) body = null
    return fixtureRequest(item, {
        body,
        query: item.path === '/v1/raindrops/:collectionId' ? { page: -1, perpage: 101 } : {},
        collectionId: item.path.includes('/export.') ? '-99' : '1',
        id: numericId ? '1' : 'fixture-id',
        contentId: 'fixture-content'
    })
}

test('validation fixtures execute every declared malformed-input case', async () => {
    const env = {
        DB: new ContractDatabase(),
        ENVIRONMENT: 'local',
        VERSION: '0.1.0-local',
        APP_ORIGIN: 'https://beta.example.test',
        API_ORIGIN: 'https://api.example.test',
        CORS_ORIGINS: 'https://beta.example.test',
        SESSION_SECRET: 'session-secret',
        RATE_LIMIT_PER_MINUTE: '1000',
        MAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'fixture-key',
        MAIL_FROM: 'fixture@example.test',
        TURNSTILE_ENABLED: 'false',
        ATTACHMENT_SCAN_ENABLED: 'false',
        TASK_QUEUE: { send: async () => {} }
    }
    const validationRoutes = fixture.routes.filter(item => item.cases.validation !== null)
    for (const item of validationRoutes) {
        const response = await worker.fetch(validationRequest(item), env)
        assert.equal(response.status, item.cases.validation, `${item.request.method} ${item.request.path}`)
        const body = await response.json()
        assert.equal(typeof body.error, 'string', `${item.request.method} ${item.request.path}`)
        assert.equal(JSON.stringify(body).includes('fixture-key'), false)
    }
})

class PermissionDatabase {
    constructor(verified = false) {
        this.verified = verified
    }

    prepare(sql) {
        const session = {
            session_id: 'fixture-session', user_id: 1, id: 1, email: 'fixture@example.test',
            name: 'Fixture', email_verified_at: this.verified ? 1 : null, federated_only: 0, google_enabled: false,
            expires_at: Date.now() + 86400000
        }
        const first = async () => {
            if (sql.includes('FROM sessions s')) return session
            if (sql.includes('FROM collections')) return { id: 1, user_id: 2, title: 'Shared', parent_id: null, removed_at: null }
            if (sql.includes('FROM collection_collaborators') && sql.includes('SELECT role')) return { role: 'viewer' }
            if (sql.includes('FROM bookmarks')) return {
                id: 1, user_id: 2, url: 'https://example.test', title: 'Shared', description: '', note: '',
                collection_id: 1, tags: '[]', highlights: '[]', removed_at: null
            }
            if (sql.includes('FROM content_objects')) return {
                id: 'fixture-content', bookmark_id: 1, kind: 'snapshot', content_type: 'text/html',
                status: 'cleared', object_key: 'fixture', size_bytes: 1
            }
            return null
        }
        const all = async () => ({ results: [] })
        const run = async () => ({ meta: { changes: 1, last_row_id: 1 } })
        return { bind: () => ({ first, all, run }) }
    }
}

const permissionRequest = item => {
    let body = item.request.body
    if (item.path === '/v1/auth/email/signup') body = {
        email: 'fixture@example.test', name: 'Fixture', password: 'fixture-password-123', betaAccessPassword: 'wrong'
    }
    if (item.path === '/v1/auth/google') body = { betaAccessPassword: 'wrong' }
    return fixtureRequest(item, {
        body,
        collectionId: '1',
        id: item.request.path.startsWith('/v1/collection/') || item.request.path.startsWith('/v1/raindrop/') ? '1' : 'fixture-id'
    })
}

test('permission fixtures execute every declared forbidden case', async () => {
    const env = {
        DB: new PermissionDatabase(false),
        ENVIRONMENT: 'beta',
        VERSION: '0.1.0-beta',
        APP_ORIGIN: 'https://beta.example.test',
        API_ORIGIN: 'https://api.example.test',
        CORS_ORIGINS: 'https://beta.example.test',
        SESSION_SECRET: 'session-secret',
        RATE_LIMIT_PER_MINUTE: '1000',
        BETA_ACCESS_PASSWORD: 'expected',
        MAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'fixture-key',
        MAIL_FROM: 'fixture@example.test',
        GOOGLE_CLIENT_ID: 'fixture-client',
        GOOGLE_CLIENT_SECRET: 'fixture-secret',
        TURNSTILE_ENABLED: 'false'
    }
    const resourceEnv = { ...env, DB: new PermissionDatabase(true) }
    const permissionRoutes = fixture.routes.filter(item => item.cases.permission !== null)
    for (const item of permissionRoutes) {
        for (const expected of Array.isArray(item.cases.permission) ? item.cases.permission : [item.cases.permission]) {
            const requestEnv = expected.mode === 'resource' || expected.mode === 'origin' || expected.mode === 'admission' ? resourceEnv : env
            const response = await worker.fetch(permissionRequest(item), requestEnv)
            assert.equal(response.status, expected.status, `${item.request.method} ${item.request.path} (${expected.mode})`)
            const body = await response.json()
            assert.equal(body.error, expected.error, `${item.request.method} ${item.request.path} (${expected.mode})`)
            assert.equal(JSON.stringify(body).includes('fixture-secret'), false)
        }
    }
})

test('the operations runbook covers alert triage without User content', () => {
    const runbook = fs.readFileSync(new URL('../OPERATIONS_RUNBOOK.md', import.meta.url), 'utf8')
    for (const kind of [
        'api_error', 'login_anomaly', 'metadata_enrichment_failed', 'capture_failed',
        'attachment_scan_failed', 'usage_quota_threshold', 'ai_quota_threshold',
        'task_enqueue_failed'
    ]) assert.match(runbook, new RegExp('`' + kind + '`'))
    assert.match(runbook, /request bodies, cookies, passwords, tokens/i)
    assert.match(runbook, /wrangler d1 execute raindrop-db-beta/)
    assert.match(runbook, /explicit retry/i)
})

class AlertingDatabase {
    constructor() {
        this.failFirstRead = true
        this.alerts = []
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (this.failFirstRead && sql.includes('FROM sessions s')) {
                this.failFirstRead = false
                throw new Error('query failed with user-content-secret')
            }
            return null
        }
        const run = async () => {
            if (sql.includes('INSERT INTO alerts')) {
                this.alerts.push({ requestId: values[1], kind: values[2], severity: values[3], route: values[4], metadata: values[6] })
            }
            return { meta: { changes: 1 } }
        }
        const all = async () => ({ results: [] })
        return { bind: (...next) => { values = next; return { first, run, all } } }
    }
}

test('unexpected API failures return a redacted error and an actionable alert', async () => {
    const db = new AlertingDatabase()
    const env = {
        DB: db,
        ENVIRONMENT: 'beta',
        VERSION: '0.1.0-beta',
        APP_ORIGIN: 'https://beta.example.test',
        API_ORIGIN: 'https://api.example.test',
        CORS_ORIGINS: 'https://beta.example.test',
        SESSION_SECRET: 'session-secret'
    }
    const response = await worker.fetch(new Request('https://api.example.test/v1/user', {
        headers: { Cookie: 'rd_session=session-secret', 'X-Request-ID': 'qa-api-error-1' }
    }), env)
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.deepEqual(body, { result: false, error: 'internal_error', errorMessage: 'Internal server error' })
    assert.equal(JSON.stringify(body).includes('user-content-secret'), false)
    assert.equal(db.alerts.length, 1)
    assert.equal(db.alerts[0].kind, 'api_error')
    assert.equal(db.alerts[0].severity, 'error')
    assert.equal(db.alerts[0].requestId, response.headers.get('X-Request-ID'))
    assert.notEqual(db.alerts[0].requestId, 'qa-api-error-1')
    assert.equal(JSON.stringify(db.alerts[0]).includes('user-content-secret'), false)
})

class PagingDatabase {
    constructor() {
        this.bookmarks = Array.from({ length: 5 }, (_, index) => ({
            id: index + 1,
            user_id: 1,
            url: `https://example.test/${index + 1}`,
            title: `Bookmark ${index + 1}`,
            description: '',
            note: '',
            cover: '',
            collection_id: -1,
            tags: '[]',
            highlights: '[]',
            removed_at: null,
            created_at: index + 1,
            updated_at: index + 1,
            change_version: index + 1
        }))
    }

    prepare(sql) {
        const first = async () => {
            if (sql.includes('FROM sessions s')) return {
                session_id: 'session-1', user_id: 1, id: 1, email: 'fixture@example.test',
                name: 'Fixture', email_verified_at: 1, federated_only: 0, google_enabled: false,
                expires_at: Date.now() + 86400000
            }
            if (sql.includes('FROM bookmark_changes')) return null
            return null
        }
        const all = async () => sql.includes('FROM bookmarks WHERE') ? { results: this.bookmarks } : { results: [] }
        const run = async () => ({ meta: { changes: 1 } })
        return { bind: () => ({ first, all, run }) }
    }
}

test('Bookmark list fixtures exercise stable pagination envelopes', async () => {
    const db = new PagingDatabase()
    const env = {
        DB: db,
        ENVIRONMENT: 'beta',
        VERSION: '0.1.0-beta',
        APP_ORIGIN: 'https://beta.example.test',
        API_ORIGIN: 'https://api.example.test',
        CORS_ORIGINS: 'https://beta.example.test',
        SESSION_SECRET: 'session-secret',
        RATE_LIMIT_PER_MINUTE: '60'
    }
    const response = await worker.fetch(new Request('https://api.example.test/v1/raindrops/0?page=1&perpage=2', {
        headers: { Cookie: 'rd_session=fixture-session' }
    }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.items.map(item => item._id), [3, 4])
    assert.equal(body.count, 5)
    assert.equal(body.page, 1)
    assert.equal(body.perpage, 2)

    const changes = await worker.fetch(new Request('https://api.example.test/v1/raindrops/changes?since=0', {
        headers: { Cookie: 'rd_session=fixture-session' }
    }), env)
    assert.equal(changes.status, 200)
    const changesBody = await changes.json()
    assert.equal(changesBody.fromVersion, 0)
    assert.equal(typeof changesBody.version, 'number')

    const invalid = await worker.fetch(new Request('https://api.example.test/v1/raindrops/0?page=-1&perpage=101', {
        headers: { Cookie: 'rd_session=fixture-session' }
    }), env)
    assert.equal(invalid.status, 400)
})
