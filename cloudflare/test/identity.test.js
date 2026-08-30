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
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM users WHERE email'))
                return this.users.find(user => user.email === values[0]) || null

            if (sql.includes('FROM sessions s')) {
                const session = this.sessions.find(item => item.token_hash === values[0] && !item.revoked_at && item.expires_at > values[1])
                if (!session) return null
                const user = this.users.find(item => item.id === session.user_id)
                return user && { ...session, session_id: session.id, ...user }
            }

            if (sql.includes('FROM email_tokens'))
                return this.tokens.find(token => token.token_hash === values[0] && !token.used_at && token.expires_at > values[1]) || null

            if (sql.includes('FROM bookmarks WHERE id'))
                return this.bookmarks.find(item => item.id === values[0] && item.user_id === values[1]) || null

            if (sql.includes('FROM collections WHERE id'))
                return this.collections.find(item => item.id === values[0] && item.user_id === values[1]) || null

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
                const user = { id: this.users.length + 1, email: values[0], name: values[1], password_hash: values[2], password_salt: values[3], email_verified_at: null }
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
                const bookmark = { id: this.bookmarks.length + 1, user_id: values[0], url: values[1], title: values[2], created_at: values[3], updated_at: values[4], collection_id: values[5], tags: values[6], removed_at: null }
                this.bookmarks.push(bookmark)
                return { meta: { last_row_id: bookmark.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO collections')) {
                const collection = { id: this.collections.length + 1, user_id: values[0], title: values[1], parent_id: values[2], created_at: values[3], updated_at: values[4] }
                this.collections.push(collection)
                return { meta: { last_row_id: collection.id, changes: 1 } }
            }
            if (sql.includes('UPDATE bookmarks SET url')) {
                const bookmark = this.bookmarks.find(item => item.id === values[6] && item.user_id === values[7])
                Object.assign(bookmark, { url: values[0], title: values[1], collection_id: values[2], tags: values[3], removed_at: values[4], updated_at: values[5] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE bookmarks SET removed_at')) {
                const bookmark = this.bookmarks.find(item => item.id === values[2] && item.user_id === values[3])
                Object.assign(bookmark, { removed_at: values[0], updated_at: values[1] })
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
            return { meta: { changes: 1 } }
        }
        const all = async () => {
            if (sql.includes('FROM sessions WHERE user_id'))
                return {
                    results: this.sessions
                        .filter(item => item.user_id === values[0] && !item.revoked_at && item.expires_at > values[1])
                        .map(item => ({ ...item }))
                }
            if (sql.includes('FROM collections c'))
                return { results: this.collections.filter(item => item.user_id === values[0]).map(item => ({ ...item, count: this.bookmarks.filter(bookmark => bookmark.collection_id === item.id && !bookmark.removed_at).length })) }
            if (sql.includes('FROM bookmarks WHERE')) {
                let items = this.bookmarks.filter(item => item.user_id === values[0])
                if (sql.includes('removed_at IS NOT NULL')) items = items.filter(item => item.removed_at)
                else items = items.filter(item => !item.removed_at)
                if (sql.includes('collection_id = ?')) items = items.filter(item => item.collection_id === values[1])
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
}

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
