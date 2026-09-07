/* global Uint8Array, globalThis */

import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import worker from '../src/index.js'

globalThis.crypto ||= webcrypto

const hash = async (value, secret) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

class AiDatabase {
    constructor(secret) {
        this.secret = secret
        this.users = [
            { id: 1, email: 'one@example.test', name: 'One', email_verified_at: 1 },
            { id: 2, email: 'two@example.test', name: 'Two', email_verified_at: 1 }
        ]
        this.sessions = []
        this.chats = []
        this.messages = []
        this.usage = []
        this.globalUsage = []
        this.bookmarks = []
        this.collections = []
        this.proposals = []
        this.standingApprovals = []
        this.providers = []
        this.alerts = []
        this.quotaFailure = false
        this.nextMessageId = 1
    }

    async addSession(token, userId) {
        this.sessions.push({ id: 'session-' + userId, user_id: userId, token_hash: await hash(token, this.secret), expires_at: Date.now() + 86400000 })
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM sessions s')) {
                const session = this.sessions.find(item => item.token_hash === values[0] && item.expires_at > values[1])
                const user = this.users.find(item => item.id === session?.user_id)
                return session && user ? { ...session, session_id: session.id, ...user, federated_only: 0, google_enabled: false } : null
            }
            if (this.quotaFailure && sql.includes('ai_usage')) throw new Error('quota storage unavailable')
            if (sql.includes('FROM ai_usage_counters')) return this.usage.find(item => item.user_id === values[0] && item.window_start === values[1]) || null
            if (sql.includes('FROM ai_global_usage_counters')) return this.globalUsage.find(item => item.window_start === values[0]) || null
            if (sql.includes('FROM ai_action_proposals WHERE id')) return this.proposals.find(item => item.id === values[0] && item.user_id === values[1]) || null
            if (sql.includes('FROM ai_standing_approvals') && sql.includes('id = ?') && sql.includes('user_id = ?') && !sql.includes('tool_name = ?')) return this.standingApprovals.find(item => item.id === values[0] && item.user_id === values[1]) || null
            if (sql.includes('FROM ai_standing_approvals') && sql.includes('user_id = ?') && !sql.includes('WHERE id')) return this.standingApprovals.find(item =>
                item.user_id === values[0] && item.tool_name === values[1] && item.collection_id === values[2] && (!sql.includes('revoked_at IS NULL') || !item.revoked_at)) || null
            if (sql.includes('FROM ai_providers WHERE user_id')) return this.providers.find(item => item.user_id === values[0]) || null
            if (sql.includes('FROM ai_chats WHERE id')) return this.chats.find(item => item.id === values[0] && item.user_id === values[1]) || null
            if (sql.includes('FROM bookmarks WHERE id'))
                return this.bookmarks.find(item => item.id === values[0] && item.user_id === values[1] && !item.removed_at) || null
            if (sql.includes('FROM collections WHERE id')) return this.collections.find(item => item.id === values[0] && !item.removed_at) || null
            if (sql.includes('FROM bookmarks')) return null
            return null
        }
        const all = async () => {
            if (sql.includes('FROM bookmarks b')) return { results: this.bookmarks }
            if (sql.includes('FROM bookmarks WHERE user_id')) return { results: this.bookmarks.filter(item => item.user_id === values[0] && !item.removed_at) }
            if (sql.includes('FROM collections WHERE user_id')) return { results: this.collections.filter(item => item.user_id === values[0] && !item.removed_at) }
            if (sql.includes('FROM ai_action_proposals WHERE user_id')) return { results: this.proposals.filter(item =>
                item.user_id === values[0] && (!values[1] || item.status === values[1])) }
            if (sql.includes('FROM ai_standing_approvals WHERE user_id')) return { results: this.standingApprovals.filter(item => item.user_id === values[0] && !item.revoked_at) }
            if (sql.includes('FROM ai_chats WHERE user_id')) return { results: this.chats.filter(item => item.user_id === values[0]).map(item => ({ ...item })) }
            if (sql.includes('FROM ai_messages WHERE chat_id')) return { results: this.messages.filter(item => item.chat_id === values[0] && item.user_id === values[1]).sort((a, b) => b.created_at - a.created_at).slice(0, values[2]).map(item => ({ ...item })) }
            if (sql.includes('FROM ai_messages') && sql.includes('user_id = ?')) return { results: this.messages.filter(item => item.user_id === values[0]).map(item => ({ ...item })) }
            if (sql.includes('FROM ai_chats')) return { results: this.chats.filter(item => item.user_id === values[0]).map(item => ({ id: item.id })) }
            return { results: [] }
        }
        const run = async () => {
            if (sql.includes('INSERT INTO ai_usage_counters')) {
                const [userId, windowStart, updatedAt, limit] = values
                const row = this.usage.find(item => item.user_id === userId && item.window_start === windowStart)
                if (row) {
                    if (row.units + 1 > limit) return { meta: { changes: 0 } }
                    row.units++
                    row.updated_at = updatedAt
                } else this.usage.push({ user_id: userId, window_start: windowStart, units: 1, updated_at: updatedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO ai_global_usage_counters')) {
                if (this.quotaFailure) throw new Error('quota storage unavailable')
                const [windowStart, updatedAt, limit] = values
                const row = this.globalUsage.find(item => item.window_start === windowStart)
                if (row) {
                    if (row.units + 1 > limit) return { meta: { changes: 0 } }
                    row.units++
                    row.updated_at = updatedAt
                } else this.globalUsage.push({ window_start: windowStart, units: 1, updated_at: updatedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE ai_usage_counters SET units = units - 1')) {
                const row = this.usage.find(item => item.user_id === values[1] && item.window_start === values[2])
                if (!row || !row.units) return { meta: { changes: 0 } }
                row.units--
                row.updated_at = values[0]
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE ai_global_usage_counters SET units = units - 1')) {
                const row = this.globalUsage.find(item => item.window_start === values[1])
                if (!row || !row.units) return { meta: { changes: 0 } }
                row.units--
                row.updated_at = values[0]
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO ai_chats')) {
                this.chats.push({ id: values[0], user_id: values[1], title: values[2], created_at: values[3], updated_at: values[4] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO ai_action_proposals')) {
                this.proposals.push({ id: values[0], user_id: values[1], tool_name: values[2], action: values[3], bookmark_id: values[4], collection_id: values[5], payload: values[6], status: 'pending', result: null, error_code: null, error_message: null, created_at: values.at(-2), updated_at: values.at(-1), decided_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO ai_standing_approvals')) {
                const existing = this.standingApprovals.find(item => item.user_id === values[1] && item.tool_name === values[2] && item.collection_id === values[3])
                if (existing) return { meta: { changes: 0 } }
                this.standingApprovals.push({ id: values[0], user_id: values[1], tool_name: values[2], collection_id: values[3], created_at: values[4], updated_at: values[5], revoked_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO ai_providers')) {
                const [userId, endpoint, model, encryptedApiKey, verifiedAt, createdAt, updatedAt] = values
                const existing = this.providers.find(item => item.user_id === userId)
                if (existing) Object.assign(existing, { endpoint, model, encrypted_api_key: encryptedApiKey, verified_at: verifiedAt, updated_at: updatedAt })
                else this.providers.push({ user_id: userId, endpoint, model, encrypted_api_key: encryptedApiKey, verified_at: verifiedAt, created_at: createdAt, updated_at: updatedAt })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE ai_action_proposals SET status = \'processing\'')) {
                const row = this.proposals.find(item => item.id === values[1] && item.user_id === values[2] && item.status === 'pending')
                if (row) { row.status = 'processing'; row.updated_at = values[0] }
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE ai_action_proposals SET status = \'applied\'')) {
                const row = this.proposals.find(item => item.id === values[3] && item.user_id === values[4])
                if (row) { row.status = 'applied'; row.result = values[0]; row.updated_at = values[1]; row.decided_at = values[2] }
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE ai_action_proposals SET status = \'failed\'')) {
                const row = this.proposals.find(item => item.id === values[4] && item.user_id === values[5])
                if (row) { row.status = 'failed'; row.error_code = values[0]; row.error_message = values[1]; row.updated_at = values[2]; row.decided_at = values[3] }
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE ai_action_proposals SET status = \'rejected\'')) {
                const row = this.proposals.find(item => item.id === values[2] && item.user_id === values[3])
                if (row) { row.status = 'rejected'; row.updated_at = values[0]; row.decided_at = values[1] }
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE ai_standing_approvals SET revoked_at = NULL')) {
                const row = this.standingApprovals.find(item => item.id === values[1] && item.user_id === values[2])
                if (row) { row.revoked_at = null; row.updated_at = values[0] }
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE ai_standing_approvals SET revoked_at = ?')) {
                const row = this.standingApprovals.find(item => item.id === values[2] && item.user_id === values[3])
                if (row) { row.revoked_at = values[0]; row.updated_at = values[1] }
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE bookmarks SET url = ?')) {
                const row = this.bookmarks.find(item => item.id === values[10] && item.user_id === values[11])
                if (row) {
                    Object.assign(row, { url: values[0], title: values[1], description: values[2], note: values[3], collection_id: values[4], tags: values[5], highlights: values[6], removed_at: values[7], removed_batch: values[8], updated_at: values[9] })
                }
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('UPDATE bookmarks SET removed_at = ?')) {
                const row = this.bookmarks.find(item => item.id === values[3] && item.user_id === values[4])
                if (row) Object.assign(row, { removed_at: values[0], removed_batch: values[1], updated_at: values[2] })
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('INSERT INTO ai_messages')) {
                this.messages.push({ id: this.nextMessageId++, chat_id: values[0], user_id: values[1], role: values[2], content: values[3], created_at: values[4] })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE ai_chats')) {
                const row = this.chats.find(item => item.id === values[1] && item.user_id === values[2])
                if (row) row.updated_at = values[0]
                return { meta: { changes: row ? 1 : 0 } }
            }
            if (sql.includes('DELETE FROM ai_messages')) {
                const before = this.messages.length
                if (sql.includes('chat_id = ?')) this.messages = this.messages.filter(item => !(item.chat_id === values[0] && item.user_id === values[1]))
                else this.messages = this.messages.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.messages.length } }
            }
            if (sql.includes('DELETE FROM ai_chats')) {
                const before = this.chats.length
                if (sql.includes(' WHERE id = ?')) this.chats = this.chats.filter(item => !(item.id === values[0] && item.user_id === values[1]))
                else this.chats = this.chats.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.chats.length } }
            }
            if (sql.includes('DELETE FROM ai_providers')) {
                const before = this.providers.length
                this.providers = this.providers.filter(item => item.user_id !== values[0])
                return { meta: { changes: before - this.providers.length } }
            }
            if (sql.includes('INSERT INTO alerts')) {
                this.alerts.push({ kind: values[2], severity: values[3], route: values[4], metadata: values[6] })
                return { meta: { changes: 1 } }
            }
            return { meta: { changes: 1 } }
        }
        return { bind: (...next) => { values = next; return { first, all, run } } }
    }

    async batch(statements) {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        return results
    }
}

const request = (path, options = {}) => new Request('https://api.example.test' + path, {
    ...options,
    headers: { Cookie: 'rd_session=one', 'Content-Type': 'application/json', ...(options.headers || {}) }
})

const environment = async () => {
    const db = new AiDatabase('ai-secret')
    await db.addSession('one', 1)
    await db.addSession('two', 2)
    const calls = []
    return {
        env: {
            DB: db,
            SESSION_SECRET: 'ai-secret',
            APP_ORIGIN: 'https://app.example.test',
            AI_PAGE_ORIGIN: 'https://ai.example.test/ai',
            CORS_ORIGINS: 'https://app.example.test',
            AI_DAILY_QUOTA: '1',
            AI_GLOBAL_DAILY_QUOTA: '2',
            AI_MODEL: '@cf/test-model',
            AI: {
                run: async (...args) => {
                    calls.push(args)
                    return new Response('data: {"response":"Hello"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
                }
            }
        },
        db,
        calls
    }
}

test('AI config, streaming chat, private history, deletion, and quota recovery', async () => {
    const { env, db, calls } = await environment()
    const config = await worker.fetch(request('/v2/ai/config', { headers: { Origin: 'https://ai.example.test' } }), env)
    assert.equal(config.status, 200)
    assert.equal(config.headers.get('Access-Control-Allow-Origin'), 'https://ai.example.test')
    assert.equal((await config.json()).quota.limit, 1)

    const stream = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Hello AI' }) }), env)
    assert.equal(stream.status, 200)
    const text = await stream.text()
    assert.match(text, /"delta":"Hello"/)
    assert.match(text, /"done":true/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], '@cf/test-model')
    assert.equal(calls[0][1].stream, true)
    assert.equal(calls[0][1].messages.at(-1).content, 'Hello AI')

    const history = await worker.fetch(request('/v2/ai/history'), env)
    const chat = (await history.json()).items[0]
    assert.equal(chat.messages.length, 2)
    assert.deepEqual(chat.messages.map(item => item.role), ['user', 'assistant'])

    const exhausted = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ chatId: chat.id, message: 'Again' }) }), env)
    assert.equal(exhausted.status, 429)
    const exhaustedBody = await exhausted.json()
    assert.equal(exhaustedBody.error, 'ai_quota_exceeded')
    assert.ok(exhaustedBody.retryAt)
    assert.ok(exhaustedBody.resetAt)
    assert.equal(calls.length, 1)

    const otherHistory = await worker.fetch(request('/v2/ai/history', { headers: { Cookie: 'rd_session=two' } }), env)
    assert.deepEqual((await otherHistory.json()).items, [])
    const forbiddenDelete = await worker.fetch(request('/v2/ai/chats/' + encodeURIComponent(chat.id), { method: 'DELETE', headers: { Cookie: 'rd_session=two' } }), env)
    assert.equal(forbiddenDelete.status, 404)

    const deletedChat = await worker.fetch(request('/v2/ai/chats/' + encodeURIComponent(chat.id), { method: 'DELETE' }), env)
    assert.equal(deletedChat.status, 200)

    const deleted = await worker.fetch(request('/v2/ai/history', { method: 'DELETE' }), env)
    assert.equal(deleted.status, 200)
    const afterDelete = await worker.fetch(request('/v2/ai/history'), env)
    assert.deepEqual((await afterDelete.json()).items, [])
    assert.equal(db.chats.length, 0)
    assert.equal(db.messages.length, 0)
})

test('AI quota storage failures fail closed', async () => {
    const { env } = await environment()
    env.DB.quotaFailure = true
    const response = await worker.fetch(request('/v2/ai/config'), env)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'ai_quota_unavailable')
})

test('AI global quota does not charge denied users', async () => {
    const { env, db } = await environment()
    env.AI_GLOBAL_DAILY_QUOTA = '1'
    const first = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'First' }) }), env)
    assert.equal(first.status, 200)
    await first.text()
    const second = await worker.fetch(request('/v2/ai/chat', {
        method: 'POST',
        headers: { Cookie: 'rd_session=two' },
        body: JSON.stringify({ message: 'Second' })
    }), env)
    assert.equal(second.status, 429)
    assert.equal((await second.json()).quota.scope, 'global')
    assert.deepEqual(db.usage.map(item => [item.user_id, item.units]), [[1, 1]])
    assert.equal(db.globalUsage[0].units, 1)
})

test('AI capacity thresholds emit content-free alerts', async () => {
    const { env, db } = await environment()
    const response = await worker.fetch(request('/v2/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'Threshold check' })
    }), env)
    assert.equal(response.status, 200)
    await response.text()
    const threshold = db.alerts.find(item => item.kind === 'ai_quota_threshold')
    assert.ok(threshold)
    assert.match(threshold.metadata, /"scope":"user"/)
    assert.doesNotMatch(threshold.metadata, /Threshold check|Bookmark|attachment/i)
})

test('AI grounds natural-language prompts in authorized bookmark search results', async () => {
    const { env, db, calls } = await environment()
    db.bookmarks.push({
        id: 7,
        user_id: 1,
        url: 'https://developers.cloudflare.com/workers-ai/',
        title: 'Cloudflare Workers AI',
        description: 'AI documentation',
        note: '',
        highlights: '[]',
        tags: '["cloudflare"]'
    })
    const response = await worker.fetch(request('/v2/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'Find Cloudflare bookmarks' })
    }), env)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /"raindropId":7/)
    assert.match(calls[0][1].messages.at(-1).content, /Cloudflare Workers AI/)
    assert.match(calls[0][1].messages.at(-1).content, /Tags: cloudflare/)
})

test('AI provider failures are explicit and do not invoke a fallback', async () => {
    const { env, calls } = await environment()
    env.AI.run = async (...args) => { calls.push(args); throw new Error('provider down') }
    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Try once' }) }), env)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'ai_provider_unavailable')
    assert.equal(calls.length, 1)
})

test('Custom AI Provider validates public HTTPS endpoints and keeps probes metadata-free', async () => {
    const { env, db } = await environment()
    const privateEndpoint = await worker.fetch(request('/v2/ai/provider/test', {
        method: 'POST',
        body: JSON.stringify({ endpoint: 'http://127.0.0.1/v1', model: 'custom-model', apiKey: 'secret-key' })
    }), env)
    assert.equal(privateEndpoint.status, 400)
    assert.equal((await privateEndpoint.json()).error, 'ai_provider_endpoint_invalid')

    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options = {}) => {
        const body = JSON.parse(options.body || '{}')
        calls.push({ url: String(url), body, headers: options.headers })
        if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"Custom hello"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'Content-Type': 'application/json' } })
    }
    try {
        const saved = await worker.fetch(request('/v2/ai/provider', {
            method: 'PUT',
            body: JSON.stringify({ endpoint: 'https://provider.example.test/v1', model: 'custom-model', apiKey: 'secret-key' })
        }), env)
        assert.equal(saved.status, 200)
        const savedBody = await saved.json()
        assert.equal(savedBody.custom.configured, true)
        assert.equal(savedBody.custom.endpoint, 'https://provider.example.test/v1/chat/completions')
        assert.equal(db.providers.length, 1)
        assert.doesNotMatch(db.providers[0].encrypted_api_key, /secret-key/)
        assert.equal(calls[0].body.messages[0].content, 'Reply with OK only.')
        assert.doesNotMatch(JSON.stringify(calls[0].body), /Bookmark|bookmark|Highlights|attachment/i)

        const config = await worker.fetch(request('/v2/ai/config'), env)
        const configBody = await config.json()
        assert.equal(configBody.custom.configured, true)
        assert.equal(Object.hasOwn(configBody.custom, 'apiKey'), false)

        const chat = await worker.fetch(request('/v2/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ provider: 'custom', message: 'Hello custom' })
        }), env)
        assert.equal(chat.status, 200)
        const stream = await chat.text()
        assert.match(stream, /"provider":"custom"/)
        assert.match(stream, /Custom hello/)
        assert.equal(calls[1].body.model, 'custom-model')
        assert.ok(calls[1].body.tools.every(item => item.type === 'function'))
        assert.deepEqual(db.usage, [])

        globalThis.fetch = async () => { throw new Error('provider down') }
        const failed = await worker.fetch(request('/v2/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ provider: 'custom', message: 'Try custom again' })
        }), env)
        assert.equal(failed.status, 503)
        const failedBody = await failed.json()
        assert.equal(failedBody.provider, 'custom')
        assert.deepEqual(failedBody.fallbackProviders, ['workers_ai'])

        const deleted = await worker.fetch(request('/v2/ai/provider', { method: 'DELETE' }), env)
        assert.equal(deleted.status, 200)
        assert.equal((await deleted.json()).deleted, true)
        assert.deepEqual(db.providers, [])
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('Custom AI Provider rejects unsafe redirects without sending credentials onward', async () => {
    const { env } = await environment()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
        calls++
        return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } })
    }
    try {
        const response = await worker.fetch(request('/v2/ai/provider/test', {
            method: 'POST',
            body: JSON.stringify({ endpoint: 'https://provider.example.test/v1', model: 'custom-model', apiKey: 'secret-key' })
        }), env)
        assert.equal(response.status, 400)
        assert.equal((await response.json()).error, 'ai_provider_redirect_invalid')
        assert.equal(calls, 1)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('AI accepts a Workers AI ReadableStream binding result', async () => {
    const { env } = await environment()
    env.AI.run = async () => new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"response":"streamed"}\n\n'))
            controller.close()
        }
    })
    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Stream this' }) }), env)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /"delta":"streamed"/)
})

test('AI forwards confirmed tool-called events without changing the provider', async () => {
    const { env, db } = await environment()
    db.bookmarks.push({
        id: 7,
        user_id: 1,
        url: 'https://example.test/tool',
        title: 'Tool bookmark',
        description: '',
        note: '',
        highlights: '[]'
    })
    env.AI.run = async () => new Response('data: {"toolCalled":{"name":"bookmark_refresh","raindropId":7}}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' }
    })
    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Find Tool bookmark' }) }), env)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /"toolCalled":\{"name":"bookmark_refresh","raindropId":7\}/)
})

test('AI suggestions stay authorized, language-aware, and metadata-only', async () => {
    const { env, db, calls } = await environment()
    db.bookmarks.push({
        id: 7,
        user_id: 1,
        url: 'https://developers.cloudflare.com/workers-ai/',
        title: 'Cloudflare Workers AI',
        description: 'AI documentation',
        note: 'Keep this note',
        highlights: '[]',
        tags: '["existing"]'
    })
    db.bookmarks.push({ id: 8, user_id: 1, url: 'https://example.test/other', title: 'Other bookmark', description: '', note: '', highlights: '[]', tags: '["cloudflare"]' })
    db.collections.push({ id: 3, user_id: 1, title: 'Engineering', parent_id: null })
    db.collections.push({ id: 4, user_id: 2, title: 'Other user collection', parent_id: null })
    env.AI.run = async (...args) => {
        calls.push(args)
        return new Response('data: {"response":"{\\"collections\\":[{\\"$id\\":3}],\\"tags\\":[\\"cloudflare\\"],\\"new_tags\\":[\\"workers\\"]}"}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' }
        })
    }

    const response = await worker.fetch(request('/v2/ai/suggestions', {
        method: 'POST',
        body: JSON.stringify({ raindropId: 7, language: 'zh-Hans' })
    }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.suggestions.collections.map(item => item.id), [3])
    assert.deepEqual(body.suggestions.tags, ['cloudflare'])
    assert.deepEqual(body.suggestions.newTags, ['workers'])
    assert.equal(Object.hasOwn(body, 'item'), false)
    assert.equal(body.language, 'zh-Hans')
    assert.match(calls[0][1].messages[0].content, /zh-Hans/)
    assert.match(calls[0][1].messages.at(-1).content, /Cloudflare Workers AI/)
    assert.match(calls[0][1].messages.at(-1).content, /"tags":\["existing"\]/)
    assert.doesNotMatch(calls[0][1].messages.at(-1).content, /Other user collection/)
    assert.doesNotMatch(calls[0][1].messages.at(-1).content, /attachment-body|snapshot-body/)
})

test('AI description draft is editable output and never writes the Bookmark', async () => {
    const { env, db } = await environment()
    db.bookmarks.push({
        id: 7,
        user_id: 1,
        url: 'https://example.test/article',
        title: 'Article',
        description: 'Original description',
        note: '',
        highlights: '[]'
    })
    env.AI.run = async () => new Response('data: {"response":"A proposed description."}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' }
    })

    const response = await worker.fetch(request('/v2/ai/description-draft', {
        method: 'POST',
        body: JSON.stringify({ raindropId: 7, language: 'en' })
    }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.draft, 'A proposed description.')
    assert.equal(Object.hasOwn(body, 'descriptionDraft'), false)
    assert.equal(db.bookmarks[0].description, 'Original description')
})

test('AI context endpoint exposes only authorized Bookmark metadata', async () => {
    const { env, db } = await environment()
    db.bookmarks.push({
        id: 7,
        user_id: 1,
        url: 'https://example.test/article',
        title: 'Article',
        description: 'Metadata only',
        note: '',
        highlights: '[]'
    })
    db.bookmarks.push({ id: 8, user_id: 2, url: 'https://example.test/private', title: 'Private', description: '', note: '', highlights: '[]' })

    const response = await worker.fetch(request('/v2/ai/context?raindropId=7'), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.package.bookmarks.map(item => item.title), ['Article'])
    assert.deepEqual(body.sources, [{ raindropId: 7, title: 'Article', url: 'https://example.test/article' }])
    assert.doesNotMatch(JSON.stringify(body), /Private/)
    const missing = await worker.fetch(request('/v2/ai/context'), env)
    assert.equal(missing.status, 404)
})

test('legacy Bookmark suggestion endpoints return the client-compatible item shape', async () => {
    const { env, db } = await environment()
    env.AI_DAILY_QUOTA = '5'
    env.AI_GLOBAL_DAILY_QUOTA = '5'
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/article', title: 'Article', description: '', note: '', highlights: '[]', tags: '[]' })
    const response = await worker.fetch(request('/v1/raindrop/7/suggest'), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(Array.isArray(body.item.collections))
    assert.ok(Array.isArray(body.item.tags))
    assert.ok(Array.isArray(body.item.new_tags))

    const created = await worker.fetch(request('/v1/raindrop/suggest', {
        method: 'POST',
        body: JSON.stringify({ link: 'https://example.test/new', title: 'New bookmark' })
    }), env)
    assert.equal(created.status, 200)
    const createdBody = await created.json()
    assert.ok(Array.isArray(createdBody.item.collections))
})

test('AI read tools return only authorized context and catalog writes as proposals', async () => {
    const { env, db } = await environment()
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/owned', title: 'Owned bookmark', description: 'Visible', note: '', highlights: '[]', tags: '[]' })
    db.bookmarks.push({ id: 8, user_id: 2, url: 'https://example.test/private', title: 'Private bookmark', description: 'Hidden', note: '', highlights: '[]', tags: '[]' })

    const toolsResponse = await worker.fetch(request('/v2/ai/tools'), env)
    assert.equal(toolsResponse.status, 200)
    const toolsBody = await toolsResponse.json()
    assert.deepEqual(toolsBody.tools.map(item => item.name), ['bookmark_read', 'bookmark_update', 'bookmark_delete'])
    assert.equal(toolsBody.tools.find(item => item.name === 'bookmark_update').approval, 'action_proposal')

    const readResponse = await worker.fetch(request('/v2/ai/tools/execute', { method: 'POST', body: JSON.stringify({ tool: 'bookmark_read', bookmarkId: 7 }) }), env)
    assert.equal(readResponse.status, 200)
    assert.deepEqual((await readResponse.json()).package.bookmarks.map(item => item.title), ['Owned bookmark'])
    const privateRead = await worker.fetch(request('/v2/ai/tools', { method: 'POST', body: JSON.stringify({ tool: 'bookmark_read', bookmarkId: 8 }) }), env)
    assert.equal(privateRead.status, 404)
})

test('AI chat tool calls execute authorized reads and create pending write proposals', async () => {
    const { env, db, calls } = await environment()
    env.AI_DAILY_QUOTA = '5'
    env.AI_GLOBAL_DAILY_QUOTA = '5'
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/tool', title: 'Tool bookmark', description: 'Original', note: '', highlights: '[]', tags: '[]', collection_id: -1, created_at: Date.now(), updated_at: Date.now() })
    env.AI.run = async (...args) => {
        calls.push(args)
        return new Response('data: {"toolCalled":{"name":"bookmark_update","raindropId":7,"changes":{"title":"Proposed title"}}}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' }
        })
    }
    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Rename this bookmark' }) }), env)
    assert.equal(response.status, 200)
    const stream = await response.text()
    assert.match(stream, /"status":"pending"/)
    assert.match(stream, /"proposal"/)
    assert.equal(db.bookmarks[0].title, 'Tool bookmark')
    assert.deepEqual(calls[0][1].tools.map(item => item.name), ['bookmark_read', 'bookmark_update', 'bookmark_delete'])
})

test('AI chat returns authorized tool results to the model for a continuation round', async () => {
    const { env, db, calls } = await environment()
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/owned', title: 'Owned bookmark', description: 'Visible', note: '', highlights: '[]', tags: [] })
    db.bookmarks.push({ id: 8, user_id: 2, url: 'https://example.test/private', title: 'Private bookmark', description: 'Hidden', note: '', highlights: '[]', tags: [] })
    env.AI.run = async (...args) => {
        calls.push(args)
        if (calls.length === 1) return {
            tool_calls: [
                { id: 'read-owned', name: 'bookmark_read', arguments: { bookmarkId: 7 } },
                { id: 'read-private', name: 'bookmark_read', arguments: { bookmarkId: 8 } }
            ]
        }
        return new Response('data: {"response":"Authorized answer"}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' }
        })
    }

    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Read my bookmark' }) }), env)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Authorized answer/)
    assert.equal(calls.length, 2)
    const continuation = calls[1][1]
    const toolMessages = continuation.messages.filter(item => item.role === 'tool')
    assert.equal(toolMessages.length, 2)
    const toolAssistants = continuation.messages.filter(item => item.role === 'assistant').slice(-2)
    assert.match(toolAssistants[0].content, /"name":"bookmark_read"/)
    assert.doesNotMatch(toolAssistants[0].content, /tool_calls|tool_call_id/)
    assert.match(toolMessages[0].content, /Owned bookmark/)
    assert.match(toolMessages[1].content, /bookmark_not_found/)
    assert.doesNotMatch(toolMessages[1].content, /Private bookmark/)
    assert.deepEqual(continuation.tools.map(item => item.name), ['bookmark_read', 'bookmark_update', 'bookmark_delete'])
})

test('AI chat merges streamed tool-call argument fragments before execution', async () => {
    const { env, db, calls } = await environment()
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/owned', title: 'Fragmented bookmark', description: 'Visible', note: '', highlights: '[]', tags: [] })
    env.AI.run = async (...args) => {
        calls.push(args)
        if (calls.length === 1) return new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"tool_calls":[{"index":0,"name":"bookmark_read"}]}\n\n'))
                controller.enqueue(new TextEncoder().encode('data: {"tool_calls":[{"index":0,"arguments":"{\\"bookmarkId\\":7}"}]}\n\n'))
                controller.close()
            }
        })
        return new Response('data: {"response":"Fragment read complete"}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' }
        })
    }

    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Read bookmark 7' }) }), env)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Fragment read complete/)
    assert.equal(calls.length, 2)
    assert.match(calls[1][1].messages.find(item => item.role === 'tool').content, /Fragmented bookmark/)
})

test('AI writes remain pending until approved or rejected', async () => {
    const { env, db } = await environment()
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/action', title: 'Action bookmark', description: 'Original', note: '', highlights: '[]', tags: '[]', collection_id: -1, created_at: Date.now(), updated_at: Date.now() })

    const created = await worker.fetch(request('/v2/ai/action-proposals', {
        method: 'POST', body: JSON.stringify({ tool: 'bookmark_update', bookmarkId: 7, changes: { description: 'Proposed description' } })
    }), env)
    assert.equal(created.status, 201)
    const proposal = (await created.json()).proposal
    assert.equal(proposal.status, 'pending')
    assert.equal(db.bookmarks[0].description, 'Original')
    const getApprove = await worker.fetch(request('/v2/ai/action-proposals/' + proposal.id + '/approve'), env)
    assert.equal(getApprove.status, 404)
    assert.equal(db.bookmarks[0].description, 'Original')

    const rejected = await worker.fetch(request('/v2/ai/action-proposals/' + proposal.id + '/reject', { method: 'POST' }), env)
    assert.equal(rejected.status, 200)
    assert.equal((await rejected.json()).proposal.status, 'rejected')
    assert.equal(db.bookmarks[0].description, 'Original')

    const approvedCreate = await worker.fetch(request('/v2/ai/proposals', {
        method: 'POST', body: JSON.stringify({ tool: 'bookmark_update', bookmarkId: 7, payload: { description: 'Approved description' } })
    }), env)
    assert.equal(approvedCreate.status, 201)
    const approvedProposal = (await approvedCreate.json()).proposal
    const approved = await worker.fetch(request('/v2/ai/proposals/' + approvedProposal.id + '/decision', {
        method: 'POST', body: JSON.stringify({ decision: 'approve' })
    }), env)
    assert.equal(approved.status, 200)
    assert.equal((await approved.json()).proposal.status, 'applied')
    assert.equal(db.bookmarks[0].description, 'Approved description')

    const deleteCreate = await worker.fetch(request('/v2/ai/action-proposals', {
        method: 'POST', body: JSON.stringify({ tool: 'bookmark_delete', bookmarkId: 7 })
    }), env)
    assert.equal(deleteCreate.status, 201)
    const deleteProposal = (await deleteCreate.json()).proposal
    const deleted = await worker.fetch(request('/v2/ai/action-proposals/' + deleteProposal.id + '/approve', { method: 'POST' }), env)
    assert.equal(deleted.status, 200)
    assert.equal(db.bookmarks[0].removed_at > 0, true)
})

test('AI proposal decisions claim the pending row before applying a write', async () => {
    const { env, db } = await environment()
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/action', title: 'Action bookmark', description: 'Original', note: '', highlights: '[]', tags: '[]', collection_id: -1, created_at: Date.now(), updated_at: Date.now() })
    const created = await worker.fetch(request('/v2/ai/action-proposals', {
        method: 'POST', body: JSON.stringify({ tool: 'bookmark_update', bookmarkId: 7, changes: { title: 'Claimed once' } })
    }), env)
    const proposal = (await created.json()).proposal
    const [approved, rejected] = await Promise.all([
        worker.fetch(request('/v2/ai/action-proposals/' + proposal.id + '/approve', { method: 'POST' }), env),
        worker.fetch(request('/v2/ai/action-proposals/' + proposal.id + '/reject', { method: 'POST' }), env)
    ])
    assert.deepEqual([approved.status, rejected.status].sort(), [200, 409])
    assert.equal(db.bookmarks[0].title, 'Claimed once')
    assert.equal(db.proposals[0].status, 'applied')
})

test('standing AI approval is scoped to one tool and Collection and can be revoked', async () => {
    const { env, db } = await environment()
    db.collections.push({ id: 3, user_id: 1, title: 'Scoped collection', parent_id: null, removed_at: null })
    db.bookmarks.push({ id: 7, user_id: 1, url: 'https://example.test/action', title: 'Action bookmark', description: 'Original', note: '', highlights: '[]', tags: '[]', collection_id: 3, created_at: Date.now(), updated_at: Date.now() })

    const grant = await worker.fetch(request('/v2/ai/approvals', {
        method: 'POST', body: JSON.stringify({ tool: 'bookmark_update', collectionId: 3 })
    }), env)
    assert.equal(grant.status, 201)
    const approval = (await grant.json()).approval
    assert.equal(approval.collectionId, 3)

    const auto = await worker.fetch(request('/v2/ai/action-proposals', {
        method: 'POST', body: JSON.stringify({ tool: 'bookmark_update', bookmarkId: 7, changes: { title: 'Auto-approved' } })
    }), env)
    assert.equal(auto.status, 200)
    assert.equal((await auto.json()).autoApproved, true)
    assert.equal(db.bookmarks[0].title, 'Auto-approved')

    const revoked = await worker.fetch(request('/v2/ai/approvals/' + approval.id, { method: 'DELETE' }), env)
    assert.equal(revoked.status, 200)
    assert.equal((await revoked.json()).revoked, true)
    const afterRevoke = await worker.fetch(request('/v2/ai/action-proposals', {
        method: 'POST', body: JSON.stringify({ tool: 'bookmark_update', bookmarkId: 7, changes: { title: 'Needs approval' } })
    }), env)
    assert.equal(afterRevoke.status, 201)
    assert.equal((await afterRevoke.json()).proposal.status, 'pending')
})
