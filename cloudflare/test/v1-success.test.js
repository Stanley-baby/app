/* global globalThis, Uint8Array */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import worker from '../src/index.js'
globalThis.crypto ||= webcrypto
const f = JSON.parse(fs.readFileSync(new URL('../contracts/v1-fixtures.json', import.meta.url), 'utf8'))
const encoder = new TextEncoder()
const b64 = bytes => Buffer.from(bytes).toString('base64url')
const hmac = async (value, secret) => b64(new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(value))))
const passwordHash = async (value, salt) => b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, await crypto.subtle.importKey('raw', encoder.encode(value), 'PBKDF2', false, ['deriveBits']), 256)))
const salt = new Uint8Array(16).fill(7)
const pathFor = item => item.request.path
    .replaceAll(':collectionId', '1').replaceAll(':contentId', 'fixture-content').replaceAll(':userId', '2').replaceAll(':id', '1').replaceAll(':slug', 'fixture-slug')
const bodyFor = item => {
    const p = item.path
    if (p === '/v1/auth/email/signup') return { email: 'fixture@example.test', name: 'Fixture', password: 'fixture-password-123', betaAccessPassword: 'expected' }
    if (p === '/v1/auth/email/login') return { email: 'fixture@example.test', password: 'fixture-password-123' }
    if (p === '/v1/auth/email/confirm') return { token: 'fixture-token' }
    if (p === '/v1/auth/google') return { betaAccessPassword: 'expected' }
    if (p === '/v1/collections') return { ids: [1] }
    if (p === '/v1/collection') return { title: 'Fixture' }
    if (p === '/v1/collection/:id') return { title: 'Fixture' }
    if (p === '/v1/tags/0') return { tag: 'old', replace: 'new' }
    if (p === '/v1/raindrop') return { link: 'https://example.test', title: 'Fixture' }
    if (p === '/v1/raindrop/suggest') return { link: 'https://example.test', title: 'Fixture' }
    if (p === '/v1/raindrop/:id') return { title: 'Fixture' }
    if (p === '/v1/raindrops') return { items: [{ link: 'https://example.test', title: 'Fixture' }] }
    if (p === '/v1/tag') return {}
    if (p === '/v1/raindrops/:collectionId') return { ids: [1] }
    if (p === '/v1/backup/connections') return { provider: 'webdav', credentials: { url: 'https://example.test', username: 'u', password: 'p' } }
    if (p === '/v1/user/deletion') return {}
    if (p === '/v1/tasks/:id/retry') return {}
    if (p === '/v1/import/preflight') return { source: 'fixture', collections: [{ id: 'c1', title: 'Fixture' }], bookmarks: [{ id: 'b1', url: 'https://example.test', title: 'Fixture' }], assets: [] }
    if (p === '/v1/import/:id/review') return { decisions: {} }
    if (p === '/v1/import/:id/commit') return {}
    if (p === '/v1/collaborators/join') return { token: 'fixture-invitation' }
    if (p === '/v1/collection/:id/sharing') return { role: 'editor' }
    if (p === '/v1/collection/:id/sharing/:userId') return { role: 'viewer' }
    if (p === '/v1/collection/:id/transfer') return { userId: 2 }
    if (p === '/v1/collection/:id/published-snapshots') return { contentId: 'fixture-content' }
    if (p === '/v1/content/:id/publish') return {}
    if (p === '/v1/raindrop/:id/capture') return { kind: 'snapshot' }
    return item.request.body || {}
}
const queryFor = item => {
    if (item.path === '/v1/tag') return { tag: 'old' }
    if (item.path === '/v1/raindrops/:collectionId') return { page: 0, perpage: 40 }
    if (item.path === '/v1/raindrops/changes') return { since: 0 }
    if (item.path === '/v1/collaborators/join') return { token: 'fixture-invitation' }
    if (item.path === '/v1/collection/:id/lastAction') return {}
    return item.request.query || {}
}
class DB {
    constructor(item) { this.item = item; this.nextId = 1; this.taskStatus = item.path.endsWith('/retry') ? 'dead_letter' : 'queued' }
    prepare(sql) {
        let values = []
        const session = { session_id: 'fixture-session', user_id: 1, id: 1, email: 'fixture@example.test', name: 'Fixture', email_verified_at: 1, federated_only: 0, google_enabled: false, expires_at: Date.now() + 86400000, device_name: 'Fixture device', created_at: Date.now(), last_seen_at: Date.now() }
        const collection = { id: 1, user_id: 1, title: 'Fixture', parent_id: null, slug: 'fixture', is_public: 1, removed_at: null, count: 0, role: 'owner' }
        const bookmark = { id: 1, user_id: 1, url: 'https://example.test', title: 'Fixture', description: '', excerpt: '', note: '', cover: '', collection_id: -1, tags: '["old"]', highlights: '[]', removed_at: null, removed_batch: null, created_at: Date.now(), updated_at: Date.now(), change_version: 1 }
        const content = { id: 'fixture-content', user_id: 1, bookmark_id: 1, kind: 'snapshot', filename: 'snapshot.html', content_type: 'text/html', status: 'cleared', object_key: 'content/fixture', size_bytes: 1, created_at: Date.now(), updated_at: Date.now(), published_at: Date.now() }
        const backup = { id: values[0] || 'fixture-backup', user_id: 1, kind: 'manual', period_key: 'manual', status: this.item.path.match(/\.(html|csv|txt|zip)$/) ? 'succeeded' : 'queued', object_key: values[0] ? 'backups/1/' + values[0] + '.json' : 'backups/1/fixture.json', size_bytes: 0, error_code: null, error_message: null, created_at: Date.now(), updated_at: Date.now(), completed_at: null }
        const task = { id: values[0] || 'fixture-task', user_id: 1, bookmark_id: 1, type: this.item.path.startsWith('/v1/import') ? 'migration_import' : 'metadata_enrichment', status: this.taskStatus, progress: 0, retry_count: 0, idempotency_key: 'fixture', source_url: 'https://example.test', content_id: 'fixture-content', payload: '{}', result_metadata: '{}', error_code: null, error_message: null, next_retry_at: null, created_at: Date.now(), updated_at: Date.now(), completed_at: null }
        const archive = { id: values[0] || 'fixture-id', user_id: 1, source: 'fixture', archive_json: JSON.stringify({ collections: [{ id: 'c1', title: 'Fixture' }], bookmarks: [{ id: 'b1', url: 'https://example.test', title: 'Fixture' }], assets: [] }), preflight_json: '{"duplicates":[]}', review_json: '{}', status: this.item.path.endsWith('/commit') ? 'succeeded' : this.item.path.endsWith('/retry') ? 'failed' : 'review', collection_count: 1, bookmark_count: 1, asset_count: 0, total_items: 2, completed_items: 2, task_id: 'fixture-task', error_code: null, error_message: null, created_at: Date.now(), updated_at: Date.now() }
        const first = async () => {
            if (sql.includes('FROM sessions s')) return session
            if (sql.includes('FROM users WHERE email')) { if (this.item.path === '/v1/auth/email/signup') return null; return { id: 1, email: session.email, name: session.name, password_hash: await passwordHash('fixture-password-123', salt), password_salt: b64(salt), email_verified_at: 1, federated_only: 0 } }
            if (sql.includes('FROM users WHERE id')) return { id: 2, name: 'Target', email: 'target@example.test' }
            if (sql.includes('FROM email_tokens')) return { user_id: 1, token_hash: await hmac('fixture-token', 'secret'), expires_at: Date.now() + 86400000, used_at: null }
            if (sql.includes('FROM collections')) return collection
            if (sql.includes('FROM collection_invitations')) return { token_hash: await hmac('fixture-invitation', 'secret'), collection_id: 1, role: 'editor', expires_at: Date.now() + 86400000, used_at: null }
            if (sql.includes('FROM collection_collaborators') && sql.includes('SELECT role')) return { role: 'owner' }
            if (sql.includes('FROM bookmarks')) return bookmark
            if (sql.includes('FROM bookmark_changes')) return { version: 1, changed_at: Date.now() }
            if (sql.includes('FROM background_tasks')) return task
            if (sql.includes('FROM migration_archives')) return archive
            if (sql.includes('FROM published_snapshots')) return { ...content, collection_id: 1, bookmark_collection_id: 1 }
            if (sql.includes('FROM content_objects')) return content
            if (sql.includes('FROM backups')) return backup
            if (sql.includes('FROM backup_connections')) return { id: 'fixture-connection', user_id: 1, provider: 'webdav', is_default: 1, verified_at: Date.now(), encrypted_credentials: 'x' }
            return null
        }
        const all = async () => {
            if (sql.includes('FROM sessions')) return { results: [session] }
            if (sql.includes('FROM collections')) return { results: [collection] }
            if (sql.includes('FROM bookmarks')) return { results: [bookmark] }
            if (sql.includes('FROM collection_collaborators')) return { results: [{ collection_id: 1, user_id: 1, role: 'owner', name: 'Fixture', email: 'fixture@example.test' }, { collection_id: 1, user_id: 2, role: 'viewer', name: 'Target', email: 'target@example.test' }] }
            if (sql.includes('FROM background_tasks')) return { results: [task] }
            if (sql.includes('FROM migration_archives')) return { results: [archive] }
            if (sql.includes('FROM content_objects') || sql.includes('published_snapshots')) return { results: [content] }
            if (sql.includes('FROM backups')) return { results: [backup] }
            if (sql.includes('FROM backup_connections')) return { results: [{ id: 'fixture-connection', provider: 'webdav', is_default: 1, verified_at: Date.now() }] }
            if (sql.includes('FROM bookmark_changes')) return { results: [{ id: 1, user_id: 1, url: bookmark.url, title: bookmark.title, description: '', note: '', cover: '', collection_id: -1, tags: '[]', highlights: '[]', removed_at: null, created_at: bookmark.created_at, updated_at: bookmark.updated_at, sync_version: 1 }] }
            return { results: [] }
        }
        const run = async () => { if (sql.includes('UPDATE background_tasks SET status = \'queued\'')) this.taskStatus = 'queued'; return { meta: { changes: 1, last_row_id: 1 } } }
        return { bind: (...next) => { values = next; return { first, all, run } } }
    }
}
const base = { ENVIRONMENT: 'local', VERSION: 'test', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test', CORS_ORIGINS: 'https://app.test', SESSION_SECRET: 'secret', RATE_LIMIT_PER_MINUTE: '1000', MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'key', MAIL_FROM: 'test@example.test', TURNSTILE_ENABLED: 'false', BETA_ACCESS_PASSWORD: 'expected', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', MICROSOFT_CLIENT_ID: 'microsoft-client', MICROSOFT_CLIENT_SECRET: 'microsoft-secret', TASK_QUEUE: { send: async () => {} }, CONTENT_BUCKET: { put: async () => {}, get: async () => ({ body: new Blob(['x']).stream(), size: 1 }), delete: async () => {} }, BACKUP_BUCKET: { put: async () => {}, get: async () => ({ body: new Blob(['{"version":1}']).stream(), size: 15 }), delete: async () => {} }, ATTACHMENT_SCAN_ENABLED: 'false' }
test('success fixtures execute every v1 route with an authenticated verified setup', async () => {
    const oldFetch = globalThis.fetch
    globalThis.fetch = async url => { const target = String(url); if (target.includes('resend.com')) return new Response('{}', { status: 200 }); if (target.includes('googleapis.com') || target.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'token', id_token: 'token', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); return new Response('<html><title>Fixture</title></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) }
    try {
        for (const item of f.routes) {
            let path = pathFor(item)
            const query = new URLSearchParams(queryFor(item))
            if (query.toString()) path += '?' + query
            const headers = new Headers({ Cookie: 'rd_session=fixture-session' })
            let body
            if (['PUT /v1/raindrop/file', 'POST /v1/content/upload', 'PUT /v1/content/upload', 'POST /v1/raindrop/:id/attachments', 'PUT /v1/raindrop/:id/attachments'].includes(item.method + ' ' + item.path)) {
                const form = new FormData()
                form.set('file', new Blob(['fixture'], { type: 'text/plain' }), 'fixture.txt')
                if (!item.path.endsWith('/raindrop/file')) form.set('bookmarkId', '1')
                body = form
            } else if (!['GET', 'HEAD'].includes(item.method)) {
                headers.set('Content-Type', 'application/json')
                body = JSON.stringify(bodyFor(item))
            }
            if (item.path === '/v1/user/connect/google/revoke') headers.set('Origin', base.APP_ORIGIN)
            if (item.authentication === 'none') headers.delete('Cookie')
            const env = { ...base, DB: new DB(item) }
            const response = await worker.fetch(new Request('https://api.test' + path, { method: item.method, headers, body }), env)
            const expected = typeof item.cases.success === 'object' ? item.cases.success.status : item.cases.success
            assert.equal(response.status, expected, `${item.method} ${item.path}`)
            if (item.cases.sync !== null) {
                const marker = await response.json()
                assert.equal(typeof marker.version, 'number', `${item.method} ${item.path} version marker`)
                assert.equal(typeof marker.lastAction, 'number', `${item.method} ${item.path} lastAction marker`)
                if (item.path === '/v1/raindrops/changes') assert.equal(marker.fromVersion, 0)
            }
        }
    } finally {
        globalThis.fetch = oldFetch
    }
})
