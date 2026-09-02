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
            if (sql.includes('FROM ai_chats WHERE id')) return this.chats.find(item => item.id === values[0] && item.user_id === values[1]) || null
            if (sql.includes('FROM bookmarks')) return null
            return null
        }
        const all = async () => {
            if (sql.includes('FROM bookmarks b')) return { results: [] }
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
            if (sql.includes('INSERT INTO ai_chats')) {
                this.chats.push({ id: values[0], user_id: values[1], title: values[2], created_at: values[3], updated_at: values[4] })
                return { meta: { changes: 1 } }
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

test('AI provider failures are explicit and do not invoke a fallback', async () => {
    const { env, calls } = await environment()
    env.AI.run = async (...args) => { calls.push(args); throw new Error('provider down') }
    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Try once' }) }), env)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'ai_provider_unavailable')
    assert.equal(calls.length, 1)
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
    const { env } = await environment()
    env.AI.run = async () => new Response('data: {"toolCalled":{"name":"bookmark_refresh"}}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' }
    })
    const response = await worker.fetch(request('/v2/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'Use the bookmark tool' }) }), env)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /"toolCalled":\{"name":"bookmark_refresh"\}/)
})
