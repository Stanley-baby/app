import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import worker from '../src/index.js'

globalThis.crypto ||= webcrypto

class MemoryDatabase {
    constructor() {
        this.users = []
        this.sessions = []
        this.tokens = []
        this.bookmarks = []
        this.collections = []
        this.identities = []
        this.oauthStates = []
        this.deletions = []
        this.collaborators = []
        this.changes = []
        this.nextChangeVersion = 1
        this.batchCalls = 0
        this.beforeBatch = null
        this.failBatchAt = null
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM users WHERE email'))
                return this.users.find(user => user.email === values[0]) || null

            if (sql.includes('FROM users WHERE id'))
                return this.users.find(user => user.id === values[0]) || null

            if (sql.includes('FROM sessions s')) {
                const session = this.sessions.find(item => item.token_hash === values[0] && !item.revoked_at && item.expires_at > values[1])
                if (!session) return null
                const user = this.users.find(item => item.id === session.user_id)
                return user && {
                    ...session,
                    session_id: session.id,
                    ...user,
                    google_enabled: sql.includes('connected_identities') && this.identities.some(identity => identity.user_id === user.id && identity.provider === 'google')
                }
            }

            if (sql.includes('FROM email_tokens'))
                return this.tokens.find(token => token.token_hash === values[0] && !token.used_at && token.expires_at > values[1]) || null

            if (sql.includes('FROM connected_identities'))
                return this.identities.find(identity => identity.provider === values[0] && identity.provider_subject === values[1]) || null

            if (sql.includes('FROM oauth_states'))
                return this.oauthStates.find(state => state.state_hash === values[0] && !state.used_at && state.expires_at > values[1]) || null

            if (sql.includes('FROM account_deletions'))
                return this.deletions.find(deletion => deletion.user_id === values[0]) || null

            if (sql.includes('FROM collection_collaborators'))
                return this.collaborators.find(item => item.owner_id === values[0]) || null

            if (sql.includes('FROM bookmarks WHERE id'))
                return this.bookmarks.find(item => item.id === values[0] && item.user_id === values[1]) || null

            if (sql.includes('FROM bookmark_changes WHERE user_id'))
                return this.changes.filter(item => item.user_id === values[0]).sort((left, right) => right.version - left.version)[0] || null

            if (sql.includes('FROM collections WHERE id')) {
                const item = this.collections.find(item => item.id === values[0] && item.user_id === values[1])
                return item && (!sql.includes('removed_at IS NULL') || !item.removed_at) ? item : null
            }

            if (sql.includes('FROM collections WHERE user_id'))
                return this.collections.find(item => item.user_id === values[0]) || null

            if (sql.includes('SELECT c.*')) {
                const item = this.collections.find(item => item.id === values[0] && item.user_id === values[1])
                return item && { ...item, count: this.bookmarks.filter(bookmark => bookmark.collection_id === item.id && !bookmark.removed_at).length }
            }

            if (sql.includes('SUM(CASE')) {
                const items = this.bookmarks.filter(item => item.user_id === values[0])
                return {
                    all_count: items.filter(item => !item.removed_at).length,
                    unsorted_count: items.filter(item => !item.removed_at && item.collection_id === -1).length,
                    trash_count: items.filter(item => item.removed_at).length
                }
            }

            return null
        }
        const run = async () => {
            if (sql.includes('INSERT INTO users')) {
                const user = {
                    id: this.users.length + 1,
                    email: values[0],
                    name: values[1],
                    password_hash: values[2],
                    password_salt: values[3],
                    email_verified_at: sql.includes('email_verified_at') ? values[4] : null,
                    federated_only: sql.includes('federated_only') ? 1 : 0
                }
                this.users.push(user)
                return { meta: { last_row_id: user.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO sessions')) {
                this.sessions.push({ id: values[0], user_id: values[1], token_hash: values[2], device_name: values[3], created_at: values[4], last_seen_at: values[5], expires_at: values[6], revoked_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO email_tokens')) {
                this.tokens.push({ token_hash: values[0], user_id: values[1], expires_at: values[2], used_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO bookmarks')) {
                const modern = sql.includes('description')
                const bookmark = modern
                    ? { id: this.bookmarks.length + 1, user_id: values[0], url: values[1], title: values[2], description: values[3], note: values[4], highlights: values[5], created_at: values[6], updated_at: values[7], collection_id: values[8], tags: values[9], removed_at: null, removed_batch: null, change_version: this.nextChangeVersion }
                    : { id: this.bookmarks.length + 1, user_id: values[0], url: values[1], title: values[2], description: '', note: '', created_at: values[3], updated_at: values[4], collection_id: values[5], tags: values[6], highlights: '[]', removed_at: null, removed_batch: null, change_version: this.nextChangeVersion }
                this.bookmarks.push(bookmark)
                this.changes.push({ version: this.nextChangeVersion++, user_id: bookmark.user_id, bookmark_id: bookmark.id, changed_at: bookmark.updated_at })
                return { meta: { last_row_id: bookmark.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO collections')) {
                const collection = { id: this.collections.length + 1, user_id: values[0], title: values[1], parent_id: values[2], created_at: values[3], updated_at: values[4], removed_at: null, removed_batch: null }
                this.collections.push(collection)
                return { meta: { last_row_id: collection.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO connected_identities')) {
                const identity = { id: this.identities.length + 1, provider: values[0], provider_subject: values[1], user_id: values[2], email: values[3], created_at: values[4] }
                this.identities.push(identity)
                return { meta: { last_row_id: identity.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO oauth_states')) {
                this.oauthStates.push({ state_hash: values[0], purpose: values[1], user_id: values[2], redirect_path: values[3], admission_granted: values[4], expires_at: values[5], used_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO account_deletions')) {
                this.deletions = this.deletions.filter(item => item.user_id !== values[0])
                this.deletions.push({ user_id: values[0], requested_at: values[1], purge_after: values[2] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE bookmarks SET url')) {
                const modern = sql.includes('description = ?')
                const bookmark = this.bookmarks.find(item => item.id === values[modern ? 10 : 7] && item.user_id === values[modern ? 11 : 8])
                Object.assign(bookmark, modern
                    ? { url: values[0], title: values[1], description: values[2], note: values[3], collection_id: values[4], tags: values[5], highlights: values[6], removed_at: values[7], removed_batch: values[8], updated_at: values[9], change_version: this.nextChangeVersion }
                    : { url: values[0], title: values[1], collection_id: values[2], tags: values[3], highlights: values[4], removed_at: values[5], updated_at: values[6], change_version: this.nextChangeVersion })
                this.changes.push({ version: this.nextChangeVersion++, user_id: bookmark.user_id, bookmark_id: bookmark.id, changed_at: bookmark.updated_at })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE bookmarks SET removed_at')) {
                if (sql.includes('removed_at = NULL')) {
                    const userId = values[1]
                    const batch = values[values.length - 1]
                    const ids = new Set(values.slice(2, -1).map(Number))
                    const matches = this.bookmarks.filter(item => item.user_id === userId && ids.has(item.collection_id) && item.removed_batch === batch)
                    for (const bookmark of matches) {
                        Object.assign(bookmark, { removed_at: null, removed_batch: null, updated_at: values[0], change_version: this.nextChangeVersion })
                        this.changes.push({ version: this.nextChangeVersion++, user_id: bookmark.user_id, bookmark_id: bookmark.id, changed_at: bookmark.updated_at })
                    }
                    return { meta: { changes: matches.length } }
                }
                if (sql.includes('WHERE id = ?')) {
                    const bookmark = this.bookmarks.find(item => item.id === values[3] && item.user_id === values[4])
                    if (!bookmark) return { meta: { changes: 0 } }
                    Object.assign(bookmark, { removed_at: values[0], removed_batch: values[1], updated_at: values[2], change_version: this.nextChangeVersion })
                    this.changes.push({ version: this.nextChangeVersion++, user_id: bookmark.user_id, bookmark_id: bookmark.id, changed_at: bookmark.updated_at })
                    return { meta: { changes: 1 } }
                }
                const userId = values[3]
                let matches = this.bookmarks.filter(item => item.user_id === userId && !item.removed_at)
                if (sql.includes('collection_id = ?')) matches = matches.filter(item => item.collection_id === values[4])
                if (sql.includes('collection_id IN')) {
                    const collectionIds = sql.match(/collection_id IN \(([^)]+)\)/)?.[1].split(',').length || 0
                    const ids = new Set(values.slice(4, 4 + collectionIds).map(Number))
                    matches = matches.filter(item => ids.has(item.collection_id))
                }
                if (sql.includes(' AND id IN')) {
                    const offset = sql.includes('collection_id = ?') ? 5 : sql.includes('collection_id IN') ? 4 + (sql.match(/collection_id IN \(([^)]+)\)/)?.[1].split(',').length || 0) : 4
                    const ids = new Set(values.slice(offset).map(Number))
                    matches = matches.filter(item => ids.has(item.id))
                }
                for (const bookmark of matches) {
                    Object.assign(bookmark, { removed_at: values[0], removed_batch: values[1], updated_at: values[2], change_version: this.nextChangeVersion })
                    this.changes.push({ version: this.nextChangeVersion++, user_id: bookmark.user_id, bookmark_id: bookmark.id, changed_at: bookmark.updated_at })
                }
                return { meta: { changes: matches.length } }
            }
            if (sql.includes('UPDATE collections SET removed_at')) {
                const restore = sql.includes('removed_at = NULL')
                const userId = restore ? values[1] : values[3]
                const ids = new Set(values.slice(restore ? 2 : 4, restore ? -1 : undefined).map(Number))
                const batch = restore ? values.at(-1) : values[1]
                const matches = this.collections.filter(item => item.user_id === userId && ids.has(item.id) && (restore ? item.removed_batch === batch : !item.removed_at))
                for (const item of matches) Object.assign(item, restore
                    ? { removed_at: null, removed_batch: null, updated_at: values[0] }
                    : { removed_at: values[0], removed_batch: batch, updated_at: values[2] })
                return { meta: { changes: matches.length } }
            }
            if (sql.includes('UPDATE bookmarks SET tags')) {
                const bookmark = this.bookmarks.find(item => item.id === values[2] && item.user_id === values[3])
                if (sql.includes('change_version = ?') && (!bookmark || bookmark.change_version !== values[4]))
                    return { meta: { changes: 0 } }
                Object.assign(bookmark, { tags: values[0], updated_at: values[1], change_version: this.nextChangeVersion })
                this.changes.push({ version: this.nextChangeVersion++, user_id: bookmark.user_id, bookmark_id: bookmark.id, changed_at: bookmark.updated_at })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE users SET email_verified_at')) {
                const user = this.users.find(item => item.id === values[1])
                user.email_verified_at = values[0]
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE email_tokens SET used_at')) {
                const token = this.tokens.find(item => item.token_hash === values[1] && !item.used_at)
                if (!token) return { meta: { changes: 0 } }
                token.used_at = values[0]
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE sessions SET revoked_at')) {
                let matches = this.sessions.filter(item => item.user_id === values[1] && !item.revoked_at)
                if (sql.includes('AND id = ?')) matches = matches.filter(item => item.id === values[2])
                for (const session of matches) session.revoked_at = values[0]
                return { meta: { changes: matches.length } }
            }
            if (sql.includes('UPDATE oauth_states SET used_at')) {
                const state = this.oauthStates.find(item => item.state_hash === values[1] && !item.used_at)
                if (!state) return { meta: { changes: 0 } }
                state.used_at = values[0]
                return { meta: { changes: 1 } }
            }
            if (sql.includes('DELETE FROM connected_identities')) {
                const before = this.identities.length
                if (sql.includes('provider = ?')) this.identities = this.identities.filter(item => !(item.user_id === values[0] && item.provider === values[1]))
                else this.identities = this.identities.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.identities.length } }
            }
            if (sql.includes('DELETE FROM collection_collaborators')) {
                const before = this.collaborators.length
                const ids = sql.includes('collection_id = ?') ? [values[0]] : values.map(Number)
                this.collaborators = this.collaborators.filter(item => !ids.includes(Number(item.collection_id)))
                return { meta: { changes: before - this.collaborators.length } }
            }
            if (sql.includes('DELETE FROM account_deletions')) {
                const before = this.deletions.length
                this.deletions = this.deletions.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.deletions.length } }
            }
            if (sql.includes('DELETE FROM bookmarks')) {
                const before = this.bookmarks.length
                if (sql.includes('id IN')) {
                    const ids = new Set(values.slice(1).map(Number))
                    this.bookmarks = this.bookmarks.filter(item => !(item.user_id === values[0] && ids.has(item.id) && (!sql.includes('removed_at IS NOT NULL') || item.removed_at)))
                } else this.bookmarks = this.bookmarks.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.bookmarks.length } }
            }
            if (sql.includes('DELETE FROM bookmark_changes')) {
                const before = this.changes.length
                if (sql.includes('bookmark_id IN')) {
                    const ids = new Set(values.slice(1).map(Number))
                    this.changes = this.changes.filter(item => !(item.user_id === values[0] && ids.has(item.bookmark_id)))
                } else this.changes = this.changes.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.changes.length } }
            }
            if (sql.includes('DELETE FROM collections')) {
                const before = this.collections.length
                if (sql.includes('id IN')) {
                    const ids = new Set(values.slice(1).map(Number))
                    this.collections = this.collections.filter(item => !(item.user_id === values[0] && ids.has(item.id) && (!sql.includes('removed_at IS NOT NULL') || item.removed_at)))
                } else if (sql.includes('id = ?')) {
                    this.collections = this.collections.filter(item => !(item.user_id === values[0] && item.id === values[1] && (!sql.includes('removed_at IS NULL') || !item.removed_at)))
                } else this.collections = this.collections.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.collections.length } }
            }
            if (sql.includes('DELETE FROM email_tokens')) {
                this.tokens = this.tokens.filter(item => item.user_id !== values[0])
                return { meta: { changes: 1 } }
            }
            if (sql.includes('DELETE FROM sessions')) {
                this.sessions = this.sessions.filter(item => item.user_id !== values[0])
                return { meta: { changes: 1 } }
            }
            if (sql.includes('DELETE FROM users')) {
                this.users = this.users.filter(item => item.id !== values[0])
                return { meta: { changes: 1 } }
            }
            return { meta: { changes: 1 } }
        }
        const all = async () => {
            if (sql.includes('FROM account_deletions'))
                return { results: this.deletions.filter(item => item.purge_after <= values[0]).map(item => ({ ...item })) }
            if (sql.includes('FROM sessions WHERE user_id'))
                return {
                    results: this.sessions
                        .filter(item => item.user_id === values[0] && !item.revoked_at && item.expires_at > values[1])
                        .map(item => ({ ...item }))
                }
            if (sql.includes('FROM collections c')) {
                let items = this.collections.filter(item => item.user_id === values[0])
                if (sql.includes('removed_at IS NOT NULL')) items = items.filter(item => item.removed_at)
                else if (sql.includes('removed_at IS NULL')) items = items.filter(item => !item.removed_at)
                return { results: items.map(item => ({ ...item, count: this.bookmarks.filter(bookmark => bookmark.collection_id === item.id && !bookmark.removed_at).length })) }
            }
            if (sql.includes('FROM collections WHERE user_id'))
                return { results: this.collections.filter(item => item.user_id === values[0]).map(item => ({ ...item })) }
            if (sql.includes('FROM bookmark_changes c JOIN bookmarks')) {
                return {
                    results: this.changes
                        .filter(item => item.user_id === values[0] && item.version > values[1])
                        .sort((left, right) => left.version - right.version)
                        .map(change => ({ ...this.bookmarks.find(bookmark => bookmark.id === change.bookmark_id), sync_version: change.version }))
                }
            }
            if (sql.includes('FROM bookmarks WHERE')) {
                let items = this.bookmarks.filter(item => item.user_id === values[0])
                if (sql.includes('removed_at IS NOT NULL')) items = items.filter(item => item.removed_at)
                else items = items.filter(item => !item.removed_at)
                if (sql.includes('collection_id = ?')) items = items.filter(item => item.collection_id === values[1])
                if (sql.includes('id IN')) {
                    const offset = sql.includes('collection_id = ?') ? 2 : 1
                    const ids = new Set(values.slice(offset).map(Number))
                    items = items.filter(item => ids.has(item.id))
                }
                if (sql.includes('title LIKE ?')) {
                    const offset = sql.includes('collection_id = ?') ? 2 : 1
                    const terms = values.slice(offset).map(value => String(value).replace(/^%|%$/g, '').toLowerCase())
                    items = items.filter(item => terms.some(term => [item.title, item.url, item.description, item.note, item.tags, item.highlights].some(value => String(value || '').toLowerCase().includes(term))))
                }
                return { results: items }
            }
            return { results: [] }
        }
        return {
            bind: (...next) => {
                values = next
                return { first, run, all }
            }
        }
    }

    async batch(statements) {
        this.batchCalls++
        if (this.beforeBatch) {
            const beforeBatch = this.beforeBatch
            this.beforeBatch = null
            await beforeBatch()
        }
        const snapshot = {
            bookmarks: this.bookmarks.map(item => ({ ...item })),
            changes: this.changes.map(item => ({ ...item })),
            nextChangeVersion: this.nextChangeVersion
        }
        try {
            const results = []
            for (const [index, statement] of statements.entries()) {
                if (index === this.failBatchAt) throw new Error('forced batch failure')
                results.push(await statement.run())
            }
            return results
        } catch (error) {
            this.bookmarks = snapshot.bookmarks
            this.changes = snapshot.changes
            this.nextChangeVersion = snapshot.nextChangeVersion
            throw error
        }
    }
}

test('D1 batch mutations roll back all writes on failure', async () => {
    const db = new MemoryDatabase()
    db.bookmarks.push({ id: 1, user_id: 1, tags: '[]', updated_at: 1, change_version: 1 })
    const update = 'UPDATE bookmarks SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ? AND change_version = ?'
    const first = db.prepare(update).bind('["first"]', 2, 1, 1, 1)
    const failing = db.prepare(update).bind('["second"]', 2, 2, 1, 1)
    db.failBatchAt = 1

    await assert.rejects(() => db.batch([first, failing]))
    assert.equal(db.batchCalls, 1)
    assert.equal(db.bookmarks[0].tags, '[]')
    assert.equal(db.bookmarks[0].change_version, 1)
    assert.equal(db.changes.length, 0)
    assert.equal(db.nextChangeVersion, 1)
})

const request = (path, body, headers = {}) => new Request(`https://api.example.test${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    ...(body ? { body: JSON.stringify(body) } : {})
})

const env = db => ({
    DB: db,
    ENVIRONMENT: 'beta',
    VERSION: '0.1.0-beta',
    APP_ORIGIN: 'https://beta.example.test',
    CORS_ORIGINS: 'https://beta.example.test',
    BETA_ACCESS_PASSWORD: 'invite-only',
    SESSION_SECRET: 'session-secret',
    TURNSTILE_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    RESEND_API_KEY: 'resend-secret',
    MAIL_PROVIDER: 'resend',
    MAIL_FROM: 'Raindrop Beta <beta@example.test>'
})

test('beta signup verifies Turnstile, keeps credentials private, and creates revocable device sessions', async t => {
    const db = new MemoryDatabase()
    let confirmationUrl
    let turnstileValid = true
    let turnstileRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
        if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
            turnstileRequests++
            return Response.json({ success: turnstileValid })
        }
        if (url === 'https://api.resend.com/emails') {
            const email = JSON.parse(options.body)
            confirmationUrl = email.html.match(/href="([^"]+)"/)[1]
            return Response.json({ id: 'email_1' })
        }
        return originalFetch(url, options)
    }
    t.after(() => { globalThis.fetch = originalFetch })

    const disabledDb = new MemoryDatabase()
    const disabled = await worker.fetch(request('/v1/auth/email/signup', {
        name: 'Disabled User', email: 'disabled.user@enterprise.example', password: 'correct horse battery staple', betaAccessPassword: 'invite-only'
    }), { ...env(disabledDb), TURNSTILE_ENABLED: 'false' })
    assert.equal(disabled.status, 201)
    assert.equal(turnstileRequests, 0)

    const invalid = await worker.fetch(request('/v1/auth/email/signup', {
        name: 'Beta User', email: 'beta.user@enterprise.example', password: 'correct horse battery staple', betaAccessPassword: 'wrong', turnstileToken: 'token'
    }), env(db))
    assert.equal(invalid.status, 403)
    assert.equal(db.users.length, 0)

    turnstileValid = false
    const rejected = await worker.fetch(request('/v1/auth/email/signup', {
        name: 'Beta User', email: 'beta.user@enterprise.example', password: 'correct horse battery staple', betaAccessPassword: 'invite-only', turnstileToken: 'token'
    }), env(db))
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json()).error, 'turnstile_failed')
    assert.equal(db.users.length, 0)
    turnstileValid = true

    const signup = await worker.fetch(request('/v1/auth/email/signup', {
        name: 'Beta User', email: 'beta.user@enterprise.example', password: 'correct horse battery staple', betaAccessPassword: 'invite-only', turnstileToken: 'token'
    }), env(db))
    assert.equal(signup.status, 201)
    assert.deepEqual(await signup.json(), { result: true, email: 'beta.user@enterprise.example', verified: false })
    assert.notEqual(db.users[0].password_hash, 'correct horse battery staple')
    assert.ok(confirmationUrl.includes('/account/confirm/'))

    const login = await worker.fetch(request('/v1/auth/email/login', {
        email: 'beta.user@enterprise.example', password: 'correct horse battery staple'
    }, { 'User-Agent': 'Beta browser' }), env(db))
    assert.equal(login.status, 200)
    assert.match(login.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=None/)
    const cookie = login.headers.get('Set-Cookie').split(';')[0]

    const invalidForm = await worker.fetch(new Request('https://api.example.test/v1/auth/email/login', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'missing@example.test', password: 'wrong' })
    }), env(db))
    assert.equal(invalidForm.status, 401)
    assert.match(await invalidForm.text(), /Email or password is invalid/)

    const user = await worker.fetch(request('/v1/user', null, { Cookie: cookie }), env(db))
    assert.deepEqual(await user.json(), {
        result: true,
        user: { _id: '1', email: 'beta.user@enterprise.example', name: 'Beta User', email_verified: false }
    })

    const blocked = await worker.fetch(request('/v1/oauth/connections', null, { Cookie: cookie }), env(db))
    assert.equal(blocked.status, 403)
    assert.equal((await blocked.json()).error, 'email_verification_required')

    const bookmark = await worker.fetch(request('/v1/raindrop', {
        link: 'https://example.com/read-later',
        title: 'Read later'
    }, { Cookie: cookie }), env(db))
    assert.equal(bookmark.status, 201)
    const createdBookmark = await bookmark.json()
    assert.equal(createdBookmark.result, true)
    assert.equal(createdBookmark.item.link, 'https://example.com/read-later')
    assert.equal(createdBookmark.item.collectionId, -1)

    const collection = await worker.fetch(request('/v1/collection', { title: 'QA Collection' }, { Cookie: cookie }), env(db))
    assert.equal(collection.status, 201)
    const collectionId = (await collection.json()).item._id

    const updated = await worker.fetch(new Request('https://api.example.test/v1/raindrop/1', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Updated', tags: ['qa'], collectionId })
    }), env(db))
    assert.equal(updated.status, 200)
    assert.deepEqual((await updated.json()).item.tags, ['qa'])

    const listed = await worker.fetch(request(`/v1/raindrops/${collectionId}`, null, { Cookie: cookie }), env(db))
    assert.equal((await listed.json()).count, 1)

    const bookmarkRemoved = await worker.fetch(new Request('https://api.example.test/v1/raindrop/1', { method: 'DELETE', headers: { Cookie: cookie } }), env(db))
    assert.equal(bookmarkRemoved.status, 200)
    const trash = await worker.fetch(request('/v1/raindrops/-99', null, { Cookie: cookie }), env(db))
    assert.equal((await trash.json()).count, 1)

    const restored = await worker.fetch(new Request('https://api.example.test/v1/raindrop/1', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ removed: false, collectionId: -1 })
    }), env(db))
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).item.removed, false)

    const batch = await worker.fetch(request('/v1/raindrops', { items: [{ link: 'https://example.com/batch', title: 'Batch' }] }, { Cookie: cookie }), env(db))
    assert.equal(batch.status, 201)
    assert.equal((await batch.json()).items.length, 1)

    const confirmation = new URL(confirmationUrl).pathname.split('/').pop()
    const confirmed = await worker.fetch(request('/v1/auth/email/confirm', { token: confirmation }), env(db))
    assert.equal(confirmed.status, 200)
    const repeatedConfirmation = await worker.fetch(request('/v1/auth/email/confirm', { token: confirmation }), env(db))
    assert.equal(repeatedConfirmation.status, 400)
    const invalidConfirmation = await worker.fetch(request('/v1/auth/email/confirm', { token: 'invalid' }), env(db))
    assert.equal(invalidConfirmation.status, 400)

    const sessions = await worker.fetch(request('/v1/sessions', null, { Cookie: cookie }), env(db))
    const session = (await sessions.json()).items[0]
    assert.equal(session.current, true)

    const removed = await worker.fetch(new Request(`https://api.example.test/v1/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
    }), env(db))
    assert.equal(removed.status, 200)
    assert.match(removed.headers.get('Set-Cookie'), /Max-Age=0/)

    const loggedOut = await worker.fetch(request('/v1/user', null, { Cookie: cookie }), env(db))
    assert.equal(loggedOut.status, 401)
})

test('Google identity conflicts stay separate, logout-all revokes every session, and deletion can be cancelled before purge', async t => {
    const db = new MemoryDatabase()
    const oauthEnv = {
        ...env(db),
        TURNSTILE_ENABLED: 'false',
        API_ORIGIN: 'https://api.example.test',
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret'
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options = {}) => {
        if (url === 'https://api.resend.com/emails') return Response.json({ id: 'email_1' })
        if (url === 'https://oauth2.googleapis.com/token') {
            assert.equal(options.method, 'POST')
            return Response.json({ access_token: 'google-access-token' })
        }
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
            return Response.json({ sub: 'google-subject-1', email: 'google.user@example.test', email_verified: true, name: 'Google User' })
        return originalFetch(url, options)
    }
    t.after(() => { globalThis.fetch = originalFetch })

    const federatedDb = new MemoryDatabase()
    const federatedEnv = { ...oauthEnv, DB: federatedDb }
    const admitted = await worker.fetch(request('/v1/auth/google', { betaAccessPassword: 'invite-only' }), federatedEnv)
    assert.equal(admitted.status, 200)
    const admittedState = new URL((await admitted.json()).location).searchParams.get('state')
    const enrolled = await worker.fetch(request(`/v1/auth/google/callback?code=google-code&state=${admittedState}`), federatedEnv)
    assert.equal(enrolled.status, 303)
    assert.equal(federatedDb.users.length, 1)
    assert.equal(federatedDb.identities.length, 1)
    assert.equal(federatedDb.users[0].email_verified_at > 0, true)
    const federatedCookie = enrolled.headers.get('Set-Cookie').split(';')[0]
    const csrfRejected = await worker.fetch(new Request('https://api.example.test/v1/user/connect/google/revoke', {
        method: 'POST', headers: { Cookie: federatedCookie, Origin: 'https://attacker.example.test' }
    }), federatedEnv)
    assert.equal(csrfRejected.status, 403)
    assert.equal(federatedDb.identities.length, 1)
    const lockedIdentity = await worker.fetch(new Request('https://api.example.test/v1/user/connect/google/revoke', {
        method: 'POST', headers: { Cookie: federatedCookie, Origin: 'https://beta.example.test' }
    }), federatedEnv)
    assert.equal(lockedIdentity.status, 409)
    assert.equal(federatedDb.identities.length, 1)
    await worker.fetch(request('/v1/auth/logout?all', null, { Cookie: federatedCookie }), federatedEnv)
    const returning = await worker.fetch(request('/v1/auth/google'), federatedEnv)
    const returningState = new URL(returning.headers.get('Location')).searchParams.get('state')
    await worker.fetch(request(`/v1/auth/google/callback?code=google-code&state=${returningState}`), federatedEnv)
    assert.equal(federatedDb.users.length, 1)

    const collisionDb = new MemoryDatabase()
    collisionDb.users.push({ id: 1, email: 'google.user@example.test', name: 'Email User' })
    const collisionEnv = { ...oauthEnv, DB: collisionDb }
    const collisionStart = await worker.fetch(request('/v1/auth/google', { betaAccessPassword: 'invite-only' }), collisionEnv)
    const collisionState = new URL((await collisionStart.json()).location).searchParams.get('state')
    const collisionLogin = await worker.fetch(request(`/v1/auth/google/callback?code=google-code&state=${collisionState}`), collisionEnv)
    assert.match(collisionLogin.headers.get('Location'), /google_identity_conflict/)
    assert.equal(collisionDb.identities.length, 0)

    const signup = async (name, email) => {
        const created = await worker.fetch(request('/v1/auth/email/signup', {
            name, email, password: 'correct horse battery staple', betaAccessPassword: 'invite-only'
        }), oauthEnv)
        assert.equal(created.status, 201)
        const login = await worker.fetch(request('/v1/auth/email/login', {
            email, password: 'correct horse battery staple'
        }), oauthEnv)
        assert.equal(login.status, 200)
        return login.headers.get('Set-Cookie').split(';')[0]
    }

    const firstCookie = await signup('First User', 'first.user@example.test')
    const connect = await worker.fetch(request('/v1/user/connect/google', null, { Cookie: firstCookie }), oauthEnv)
    assert.equal(connect.status, 302)
    const connectState = new URL(connect.headers.get('Location')).searchParams.get('state')
    assert.ok(connectState)

    const connected = await worker.fetch(request(`/v1/auth/google/callback?code=google-code&state=${connectState}`), oauthEnv)
    assert.equal(connected.status, 303)
    assert.match(connected.headers.get('Location'), /settings\/account\?connected=google/)
    assert.equal(db.identities.length, 1)
    assert.equal(db.identities[0].user_id, 1)

    const profile = await worker.fetch(request('/v1/user', null, { Cookie: firstCookie }), oauthEnv)
    assert.deepEqual((await profile.json()).user.google, { enabled: true })

    const revoked = await worker.fetch(new Request('https://api.example.test/v1/user/connect/google/revoke', {
        method: 'POST', headers: { Cookie: firstCookie, Origin: 'https://beta.example.test' }
    }), oauthEnv)
    assert.equal(revoked.status, 200)
    assert.equal(db.identities.length, 0)
    const reconnect = await worker.fetch(request('/v1/user/connect/google', null, { Cookie: firstCookie }), oauthEnv)
    const reconnectState = new URL(reconnect.headers.get('Location')).searchParams.get('state')
    await worker.fetch(request(`/v1/auth/google/callback?code=google-code&state=${reconnectState}`), oauthEnv)
    assert.equal(db.identities.length, 1)

    const secondCookie = await signup('Second User', 'second.user@example.test')
    const conflictStart = await worker.fetch(request('/v1/user/connect/google', null, { Cookie: secondCookie }), oauthEnv)
    const conflictState = new URL(conflictStart.headers.get('Location')).searchParams.get('state')
    const conflict = await worker.fetch(request(`/v1/auth/google/callback?code=google-code&state=${conflictState}`), oauthEnv)
    assert.equal(conflict.status, 303)
    assert.match(conflict.headers.get('Location'), /connect_error=conflict/)
    assert.equal(db.identities.length, 1)

    const secondFirstSession = await worker.fetch(request('/v1/auth/email/login', {
        email: 'first.user@example.test', password: 'correct horse battery staple'
    }), oauthEnv)
    const secondFirstCookie = secondFirstSession.headers.get('Set-Cookie').split(';')[0]
    const logoutAll = await worker.fetch(request('/v1/auth/logout?all', null, { Cookie: firstCookie }), oauthEnv)
    assert.equal(logoutAll.status, 200)
    const allRevoked = await worker.fetch(request('/v1/user', null, { Cookie: secondFirstCookie }), oauthEnv)
    assert.equal(allRevoked.status, 401)

    const googleStart = await worker.fetch(request('/v1/auth/google'), oauthEnv)
    const googleState = new URL(googleStart.headers.get('Location')).searchParams.get('state')
    const googleLogin = await worker.fetch(request(`/v1/auth/google/callback?code=google-code&state=${googleState}`), oauthEnv)
    assert.equal(googleLogin.status, 303)
    const googleCookie = googleLogin.headers.get('Set-Cookie').split(';')[0]
    const signedIn = await worker.fetch(request('/v1/user', null, { Cookie: googleCookie }), oauthEnv)
    assert.equal(signedIn.status, 200)

    db.collaborators.push({ owner_id: 1 })
    const shared = await worker.fetch(request('/v1/user/deletion', {}, { Cookie: googleCookie }), oauthEnv)
    assert.equal(shared.status, 409)
    assert.equal((await shared.json()).error, 'shared_collections_pending')
    db.collaborators = []

    const scheduled = await worker.fetch(request('/v1/user/deletion', {}, { Cookie: googleCookie }), oauthEnv)
    assert.equal(scheduled.status, 202)
    assert.equal(db.deletions[0].user_id, 1)
    const restorePage = await worker.fetch(request('/v1/user/remove', null, { Cookie: googleCookie }), oauthEnv)
    assert.match(await restorePage.text(), /Restore account/)
    const cancelled = await worker.fetch(new Request('https://api.example.test/v1/user/deletion', {
        method: 'DELETE', headers: { Cookie: googleCookie }
    }), oauthEnv)
    assert.equal(cancelled.status, 200)
    assert.equal(db.deletions.length, 0)

    await worker.fetch(request('/v1/user/deletion', {}, { Cookie: googleCookie }), oauthEnv)
    db.bookmarks.push({ id: 1, user_id: 1, url: 'https://example.test', title: 'Private', created_at: 1, updated_at: 1, collection_id: -1, tags: '[]', removed_at: null })
    db.deletions[0].purge_after = Date.now() - 1
    db.collaborators.push({ owner_id: 1 })
    let purge
    await worker.scheduled({}, oauthEnv, { waitUntil: promise => { purge = promise } })
    await purge
    assert.equal(db.users.some(user => user.id === 1), true)
    db.collaborators = []
    await worker.scheduled({}, oauthEnv, { waitUntil: promise => { purge = promise } })
    await purge
    assert.equal(db.users.some(user => user.id === 1), false)
    assert.equal(db.sessions.some(session => session.user_id === 1), false)
    assert.equal(db.identities.some(identity => identity.user_id === 1), false)
    assert.equal(db.bookmarks.some(bookmark => bookmark.user_id === 1), false)
})

test('bookmark sync markers are monotonic and incremental reads return changes', async () => {
    const db = new MemoryDatabase()
    const testEnv = { ...env(db), TURNSTILE_ENABLED: 'false' }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
        if (url === 'https://api.resend.com/emails') return Response.json({ id: 'email_sync' })
        return originalFetch(url, options)
    }

    try {
        const signup = await worker.fetch(request('/v1/auth/email/signup', {
            name: 'Sync User', email: 'sync.user@example.test', password: 'correct horse battery staple', betaAccessPassword: 'invite-only'
        }), testEnv)
        assert.equal(signup.status, 201)
        const login = await worker.fetch(request('/v1/auth/email/login', {
            email: 'sync.user@example.test', password: 'correct horse battery staple'
        }), testEnv)
        const cookie = login.headers.get('Set-Cookie').split(';')[0]

        const initial = await worker.fetch(request('/v1/collection/0/lastAction', null, { Cookie: cookie }), testEnv)
        const initialMarker = await initial.json()
        assert.equal(initialMarker.version, 0)

        const created = await worker.fetch(request('/v1/raindrop', {
            link: 'https://example.com/sync', title: 'Sync before'
        }, { Cookie: cookie }), testEnv)
        const createdBody = await created.json()
        assert.equal(createdBody.item.changeVersion, 1)

        const marker = await worker.fetch(request('/v1/collection/0/lastAction', null, { Cookie: cookie }), testEnv)
        const currentMarker = await marker.json()
        assert.equal(currentMarker.version, 1)
        assert.ok(currentMarker.lastAction > 0)

        const updated = await worker.fetch(new Request('https://api.example.test/v1/raindrop/1', {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ title: 'Sync after' })
        }), testEnv)
        const updatedBody = await updated.json()
        assert.equal(updatedBody.item.changeVersion, 2)

        const changes = await worker.fetch(request('/v1/raindrops/0?version=1', null, { Cookie: cookie }), testEnv)
        const changesBody = await changes.json()
        assert.equal(changesBody.items.length, 1)
        assert.equal(changesBody.items[0].title, 'Sync after')
        assert.equal(changesBody.items[0].changeVersion, 2)
        assert.equal(changesBody.version, 2)

        const concurrent = await Promise.all(['Sync winner A', 'Sync winner B'].map(title => worker.fetch(new Request('https://api.example.test/v1/raindrop/1', {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ title })
        }), testEnv).then(response => response.json())))
        const latestVersion = Math.max(...concurrent.map(body => body.version))
        const final = await worker.fetch(request('/v1/raindrop/1', null, { Cookie: cookie }), testEnv)
        const finalBody = await final.json()
        assert.equal(finalBody.item.changeVersion, latestVersion)
        assert.equal(finalBody.item.title, concurrent.find(body => body.version === latestVersion).item.title)

        const changesRoute = await worker.fetch(request('/v1/raindrops/changes?since=2', null, { Cookie: cookie }), testEnv)
        assert.equal((await changesRoute.json()).items[0].changeVersion, latestVersion)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('nested collections, bookmark moves, tags, and highlights stay user-scoped', async () => {
    const db = new MemoryDatabase()
    const testEnv = { ...env(db), TURNSTILE_ENABLED: 'false' }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
        if (url === 'https://api.resend.com/emails') return Response.json({ id: 'email_collections' })
        return originalFetch(url, options)
    }

    try {
        const signup = await worker.fetch(request('/v1/auth/email/signup', {
            name: 'Collections User', email: 'collections.user@example.test', password: 'correct horse battery staple', betaAccessPassword: 'invite-only'
        }), testEnv)
        assert.equal(signup.status, 201)
        const login = await worker.fetch(request('/v1/auth/email/login', {
            email: 'collections.user@example.test', password: 'correct horse battery staple'
        }), testEnv)
        const cookie = login.headers.get('Set-Cookie').split(';')[0]

        const rootResponse = await worker.fetch(request('/v1/collection', { title: 'Parent Collection' }, { Cookie: cookie }), testEnv)
        assert.equal(rootResponse.status, 201)
        const root = (await rootResponse.json()).item
        assert.equal(Number.isSafeInteger(root._id), true)

        const childResponse = await worker.fetch(request('/v1/collection', { title: 'Nested Collection', parentId: Number(root._id) }, { Cookie: cookie }), testEnv)
        assert.equal(childResponse.status, 201)
        const child = (await childResponse.json()).item
        assert.equal(child.parentId, Number(root._id))

        const cycle = await worker.fetch(new Request('https://api.example.test/v1/collection/' + root._id, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ parentId: Number(child._id) })
        }), testEnv)
        assert.equal(cycle.status, 404)

        const collections = await worker.fetch(request('/v1/collections/all', null, { Cookie: cookie }), testEnv)
        assert.deepEqual((await collections.json()).items.map(item => item.parentId), [null, Number(root._id)])

        const collectionTags = await worker.fetch(request('/v1/tags/' + root._id, null, { Cookie: cookie }), testEnv)
        assert.equal(collectionTags.status, 200)

        const bookmarkResponse = await worker.fetch(request('/v1/raindrop', {
            link: 'https://example.com/issue6', title: 'Issue 6 collection bookmark', collectionId: Number(child._id), tags: ['alpha', 'beta']
        }, { Cookie: cookie }), testEnv)
        assert.equal(bookmarkResponse.status, 201)
        const bookmark = (await bookmarkResponse.json()).item
        assert.equal(Number.isSafeInteger(bookmark._id), true)
        assert.equal(bookmark.collectionId, Number(child._id))
        assert.deepEqual(bookmark.tags, ['alpha', 'beta'])

        const invalidTags = await worker.fetch(request('/v1/raindrop', {
            link: 'https://example.com/invalid-tags', title: 'Invalid tags', tags: ['x'.repeat(101)]
        }, { Cookie: cookie }), testEnv)
        assert.equal(invalidTags.status, 400)

        const moved = await worker.fetch(new Request('https://api.example.test/v1/raindrop/' + bookmark._id, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ collectionId: Number(root._id) })
        }), testEnv)
        assert.equal(moved.status, 200)
        assert.equal((await moved.json()).item.collectionId, Number(root._id))

        const filters = await worker.fetch(request('/v1/filters/0?search=alpha&tagsSort=-count', null, { Cookie: cookie }), testEnv)
        assert.deepEqual((await filters.json()).tags, [{ _id: 'alpha', count: 1 }])

        const recentTags = await worker.fetch(request('/v1/tags/recent', null, { Cookie: cookie }), testEnv)
        assert.equal((await recentTags.json()).items[0]._id, 'alpha')

        db.beforeBatch = async () => {
            const current = db.bookmarks.find(item => item.id === bookmark._id)
            current.tags = JSON.stringify(['alpha', 'beta', 'concurrent'])
            current.change_version = db.nextChangeVersion
            db.changes.push({ version: db.nextChangeVersion++, user_id: current.user_id, bookmark_id: current.id, changed_at: current.updated_at })
        }
        const renamed = await worker.fetch(new Request('https://api.example.test/v1/tags/0', {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ tag: 'alpha', replace: 'renamed' })
        }), testEnv)
        assert.equal(renamed.status, 200)

        const removedTag = await worker.fetch(new Request('https://api.example.test/v1/tag?tag=beta', {
            method: 'DELETE', headers: { Cookie: cookie }
        }), testEnv)
        assert.equal(removedTag.status, 200)
        assert.equal(db.batchCalls, 3)

        const afterTags = await worker.fetch(request('/v1/raindrop/' + bookmark._id, null, { Cookie: cookie }), testEnv)
        assert.deepEqual((await afterTags.json()).item.tags, ['renamed', 'concurrent'])

        const addedHighlight = await worker.fetch(new Request('https://api.example.test/v1/raindrop/' + bookmark._id, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ highlights: [{ text: 'A quoted passage', note: 'first note', color: 'blue' }] })
        }), testEnv)
        assert.equal(addedHighlight.status, 200)
        const addedHighlightItem = (await addedHighlight.json()).item.highlights[0]
        assert.equal(Number.isInteger(addedHighlightItem._id), true)
        assert.equal(addedHighlightItem.text, 'A quoted passage')

        const updatedHighlight = await worker.fetch(new Request('https://api.example.test/v1/raindrop/' + bookmark._id, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ highlights: [{ _id: addedHighlightItem._id, note: 'updated note', color: 'green' }] })
        }), testEnv)
        assert.equal((await updatedHighlight.json()).item.highlights[0].note, 'updated note')

        const exported = await worker.fetch(request('/v1/raindrop/' + bookmark._id + '/highlights.txt', null, { Cookie: cookie }), testEnv)
        assert.equal(exported.status, 200)
        assert.match(await exported.text(), /A quoted passage/)

        const removedHighlight = await worker.fetch(new Request('https://api.example.test/v1/raindrop/' + bookmark._id, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ highlights: [{ _id: addedHighlightItem._id, text: '' }] })
        }), testEnv)
        assert.deepEqual((await removedHighlight.json()).item.highlights, [])

        const outsiderSignup = await worker.fetch(request('/v1/auth/email/signup', {
            name: 'Outsider', email: 'issue6.outsider@example.test', password: 'correct horse battery staple', betaAccessPassword: 'invite-only'
        }), testEnv)
        assert.equal(outsiderSignup.status, 201)
        const outsiderLogin = await worker.fetch(request('/v1/auth/email/login', {
            email: 'issue6.outsider@example.test', password: 'correct horse battery staple'
        }), testEnv)
        const outsiderCookie = outsiderLogin.headers.get('Set-Cookie').split(';')[0]
        const foreignCollection = await worker.fetch(request('/v1/collection', { title: 'Foreign Child', parentId: Number(root._id) }, { Cookie: outsiderCookie }), testEnv)
        assert.equal(foreignCollection.status, 404)
        const foreignBookmark = await worker.fetch(request('/v1/raindrop', {
            link: 'https://example.com/foreign', title: 'Foreign', collectionId: Number(root._id)
        }, { Cookie: outsiderCookie }), testEnv)
        assert.equal(foreignBookmark.status, 404)

        const unauthorized = await worker.fetch(request('/v1/collections/all'), testEnv)
        assert.equal(unauthorized.status, 401)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('recycle bin, metadata search, and last-write-wins stay user-scoped', async () => {
    const db = new MemoryDatabase()
    const testEnv = { ...env(db), TURNSTILE_ENABLED: 'false' }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
        if (url === 'https://api.resend.com/emails') return Response.json({ id: 'email_issue7' })
        return originalFetch(url, options)
    }

    const jsonRequest = (path, method, body, cookie) => new Request('https://api.example.test' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

    const signIn = async email => {
        const signup = await worker.fetch(request('/v1/auth/email/signup', {
            name: email.split('@')[0], email, password: 'correct horse battery staple', betaAccessPassword: 'invite-only'
        }), testEnv)
        assert.equal(signup.status, 201)
        const login = await worker.fetch(request('/v1/auth/email/login', {
            email, password: 'correct horse battery staple'
        }), testEnv)
        assert.equal(login.status, 200)
        return login.headers.get('Set-Cookie').split(';')[0]
    }

    try {
        const ownerCookie = await signIn('issue7.owner@example.test')
        const outsiderCookie = await signIn('issue7.outsider@example.test')
        const rootResponse = await worker.fetch(request('/v1/collection', { title: 'Issue 7 root' }, { Cookie: ownerCookie }), testEnv)
        const rootId = (await rootResponse.json()).item._id
        const childResponse = await worker.fetch(request('/v1/collection', { title: 'Issue 7 child', parentId: rootId }, { Cookie: ownerCookie }), testEnv)
        const childId = (await childResponse.json()).item._id
        const created = await worker.fetch(request('/v1/raindrop', {
            link: 'https://example.test/issue7',
            title: 'Issue 7 searchable title',
            description: 'Issue 7 searchable description',
            note: 'Issue 7 searchable note',
            tags: ['issue7-search-tag'],
            highlights: [{ text: 'Issue 7 searchable highlight' }],
            collectionId: childId
        }, { Cookie: ownerCookie }), testEnv)
        assert.equal(created.status, 201)
        const bookmark = (await created.json()).item
        const stored = db.bookmarks.find(item => item.id === bookmark._id)
        stored.snapshot_body = 'Issue 7 private snapshot body'
        assert.equal(bookmark.description, 'Issue 7 searchable description')
        assert.equal(bookmark.note, 'Issue 7 searchable note')

        const partialUpdate = await worker.fetch(jsonRequest('/v1/raindrop/' + bookmark._id, 'PUT', { title: 'Issue 7 searchable title' }, ownerCookie), testEnv)
        assert.equal(partialUpdate.status, 200)
        assert.equal((await partialUpdate.json()).item.description, 'Issue 7 searchable description')

        for (const term of ['description', 'searchable note', 'search-tag', 'searchable highlight']) {
            const searched = await worker.fetch(request('/v1/raindrops/0?search=' + encodeURIComponent(term), null, { Cookie: ownerCookie }), testEnv)
            assert.equal(searched.status, 200)
            assert.equal((await searched.json()).items.length, 1)
        }
        const snapshotSearch = await worker.fetch(request('/v1/raindrops/0?search=' + encodeURIComponent('private snapshot body'), null, { Cookie: ownerCookie }), testEnv)
        assert.equal((await snapshotSearch.json()).items.length, 0)

        const removed = await worker.fetch(jsonRequest('/v1/raindrop/' + bookmark._id, 'DELETE', undefined, ownerCookie), testEnv)
        assert.equal(removed.status, 200)
        const removedVersion = (await removed.json()).version
        const trash = await worker.fetch(request('/v1/raindrops/-99', null, { Cookie: ownerCookie }), testEnv)
        assert.equal((await trash.json()).items.length, 1)
        const restored = await worker.fetch(jsonRequest('/v1/raindrop/' + bookmark._id, 'PUT', { removed: false }, ownerCookie), testEnv)
        const restoredBody = await restored.json()
        assert.equal(restored.status, 200)
        assert.equal(restoredBody.item.removed, false)
        assert.ok(restoredBody.item.changeVersion > removedVersion)

        const removedCollection = await worker.fetch(jsonRequest('/v1/collection/' + rootId, 'DELETE', undefined, ownerCookie), testEnv)
        assert.equal(removedCollection.status, 200)
        const activeCollections = await worker.fetch(request('/v1/collections/all', null, { Cookie: ownerCookie }), testEnv)
        assert.equal((await activeCollections.json()).items.some(item => item._id === rootId), false)
        const removedCollections = await worker.fetch(request('/v1/collections/all?removed=true', null, { Cookie: ownerCookie }), testEnv)
        assert.deepEqual((await removedCollections.json()).items.map(item => item._id).sort(), [rootId, childId].sort())
        const restoredCollection = await worker.fetch(jsonRequest('/v1/collection/' + rootId, 'PUT', { removed: false }, ownerCookie), testEnv)
        assert.equal(restoredCollection.status, 200)
        const restoredBookmarks = await worker.fetch(request('/v1/raindrops/' + childId, null, { Cookie: ownerCookie }), testEnv)
        assert.equal((await restoredBookmarks.json()).items.length, 1)

        const staggeredRoot = await worker.fetch(request('/v1/collection', { title: 'Issue 7 staggered root' }, { Cookie: ownerCookie }), testEnv)
        const staggeredRootId = (await staggeredRoot.json()).item._id
        const staggeredChild = await worker.fetch(request('/v1/collection', { title: 'Issue 7 staggered child', parentId: staggeredRootId }, { Cookie: ownerCookie }), testEnv)
        const staggeredChildId = (await staggeredChild.json()).item._id
        const staggeredBookmarkResponse = await worker.fetch(request('/v1/raindrop', {
            link: 'https://example.test/issue7-staggered', title: 'Issue 7 staggered bookmark', collectionId: staggeredChildId
        }, { Cookie: ownerCookie }), testEnv)
        assert.equal(staggeredBookmarkResponse.status, 201)
        const staggeredBookmarkId = (await staggeredBookmarkResponse.json()).item._id
        const originalNow = Date.now
        Date.now = () => 1735689600000
        try {
            assert.equal((await worker.fetch(jsonRequest('/v1/collection/' + staggeredChildId, 'DELETE', undefined, ownerCookie), testEnv)).status, 200)
            assert.equal((await worker.fetch(jsonRequest('/v1/collection/' + staggeredRootId, 'DELETE', undefined, ownerCookie), testEnv)).status, 200)
        } finally {
            Date.now = originalNow
        }
        assert.equal((await worker.fetch(jsonRequest('/v1/collection/' + staggeredChildId, 'PUT', { removed: false }, ownerCookie), testEnv)).status, 200)
        assert.equal((await worker.fetch(jsonRequest('/v1/collection/' + staggeredChildId, 'DELETE', undefined, ownerCookie), testEnv)).status, 200)
        assert.equal((await worker.fetch(jsonRequest('/v1/collection/' + staggeredRootId, 'PUT', { removed: false }, ownerCookie), testEnv)).status, 200)
        const staggeredRemoved = await worker.fetch(request('/v1/collections/all?removed=true', null, { Cookie: ownerCookie }), testEnv)
        assert.equal((await staggeredRemoved.json()).items.some(item => item._id === staggeredChildId), true)
        const staggeredTrash = await worker.fetch(request('/v1/raindrops/-99', null, { Cookie: ownerCookie }), testEnv)
        assert.equal((await staggeredTrash.json()).items.some(item => item._id === staggeredBookmarkId), true)

        const second = await worker.fetch(request('/v1/raindrop', {
            link: 'https://example.test/issue7-second', title: 'Issue 7 second', collectionId: childId
        }, { Cookie: ownerCookie }), testEnv)
        const secondId = (await second.json()).item._id
        const unconfirmedBulk = await worker.fetch(jsonRequest('/v1/raindrops/' + childId, 'DELETE', {}, ownerCookie), testEnv)
        assert.equal(unconfirmedBulk.status, 400)
        const falseDangerAll = await worker.fetch(jsonRequest('/v1/raindrops/' + childId + '?dangerAll=false', 'DELETE', {}, ownerCookie), testEnv)
        assert.equal(falseDangerAll.status, 400)
        const bulkRemoved = await worker.fetch(jsonRequest('/v1/raindrops/' + childId + '?dangerAll=true', 'DELETE', { ids: [secondId] }, ownerCookie), testEnv)
        assert.equal(bulkRemoved.status, 200)
        const unconfirmedTrashClear = await worker.fetch(jsonRequest('/v1/raindrops/-99', 'DELETE', {}, ownerCookie), testEnv)
        assert.equal(unconfirmedTrashClear.status, 400)
        const cleared = await worker.fetch(jsonRequest('/v1/collection/-99', 'DELETE', undefined, ownerCookie), testEnv)
        assert.equal(cleared.status, 200)
        assert.equal((await worker.fetch(request('/v1/raindrops/-99', null, { Cookie: ownerCookie }), testEnv).then(response => response.json())).items.length, 0)

        const bulkCollection = await worker.fetch(request('/v1/collection', { title: 'Issue 7 bulk collection' }, { Cookie: ownerCookie }), testEnv)
        const bulkCollectionId = (await bulkCollection.json()).item._id
        const bulkCollectionDelete = await worker.fetch(jsonRequest('/v1/collections', 'DELETE', { ids: [bulkCollectionId] }, ownerCookie), testEnv)
        assert.equal(bulkCollectionDelete.status, 200)
        assert.equal((await worker.fetch(request('/v1/collections/all?removed=true', null, { Cookie: ownerCookie }), testEnv).then(response => response.json())).items.some(item => item._id === bulkCollectionId), true)
        assert.equal((await worker.fetch(jsonRequest('/v1/collection/' + bulkCollectionId, 'PUT', { removed: false }, ownerCookie), testEnv)).status, 200)

        const emptyCollection = await worker.fetch(request('/v1/collection', { title: 'Issue 7 empty collection' }, { Cookie: ownerCookie }), testEnv)
        const emptyCollectionId = (await emptyCollection.json()).item._id
        const cleaned = await worker.fetch(jsonRequest('/v1/collections/clean', 'PUT', {}, ownerCookie), testEnv)
        assert.equal((await cleaned.json()).count, 3)
        assert.equal((await worker.fetch(request('/v1/collection/' + emptyCollectionId, null, { Cookie: ownerCookie }), testEnv)).status, 404)
        assert.equal((await worker.fetch(request('/v1/collection/' + bulkCollectionId, null, { Cookie: ownerCookie }), testEnv)).status, 404)

        const foreignDelete = await worker.fetch(jsonRequest('/v1/raindrop/' + bookmark._id, 'DELETE', undefined, outsiderCookie), testEnv)
        assert.equal(foreignDelete.status, 404)
        const foreignCollectionDelete = await worker.fetch(jsonRequest('/v1/collection/' + rootId, 'DELETE', undefined, outsiderCookie), testEnv)
        assert.equal(foreignCollectionDelete.status, 404)
        const firstWrite = await worker.fetch(jsonRequest('/v1/raindrop/' + bookmark._id, 'PUT', { title: 'Issue 7 first write' }, ownerCookie), testEnv)
        const firstWriteBody = await firstWrite.json()
        const secondWrite = await worker.fetch(jsonRequest('/v1/raindrop/' + bookmark._id, 'PUT', { title: 'Issue 7 later write' }, ownerCookie), testEnv)
        const secondWriteBody = await secondWrite.json()
        assert.equal(firstWrite.status, 200)
        assert.equal(secondWrite.status, 200)
        assert.ok(secondWriteBody.item.changeVersion > firstWriteBody.item.changeVersion)
        assert.equal(secondWriteBody.item.title, 'Issue 7 later write')
        const orderedFinal = await worker.fetch(request('/v1/raindrop/' + bookmark._id, null, { Cookie: ownerCookie }), testEnv)
        assert.equal((await orderedFinal.json()).item.title, 'Issue 7 later write')
        const winner = await Promise.all(['Issue 7 winner A', 'Issue 7 winner B'].map(title =>
            worker.fetch(jsonRequest('/v1/raindrop/' + bookmark._id, 'PUT', { title }, ownerCookie), testEnv).then(response => response.json())
        ))
        const latest = await worker.fetch(request('/v1/raindrop/' + bookmark._id, null, { Cookie: ownerCookie }), testEnv)
        const latestBody = await latest.json()
        const winningResponse = winner.find(body => body.item.changeVersion === latestBody.item.changeVersion)
        assert.equal(latestBody.item.title, winningResponse.item.title)
    } finally {
        globalThis.fetch = originalFetch
    }
})
