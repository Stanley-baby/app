/* global BigInt, Uint8Array, globalThis */

import assert from 'node:assert/strict'
import { createHash, createHmac, createSign, generateKeyPairSync, webcrypto } from 'node:crypto'
import test from 'node:test'
import worker from '../src/index.js'

globalThis.crypto ||= webcrypto
const secret = 'public-auth-test-secret'
const b64 = bytes => Buffer.from(bytes).toString('base64url')
const hmac = value => b64(createHmac('sha256', secret).update(value).digest())
const passwordHash = async value =>
    b64(
        new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'PBKDF2',
                    hash: 'SHA-256',
                    salt: new Uint8Array(16).fill(7),
                    iterations: 100000
                },
                await crypto.subtle.importKey(
                    'raw',
                    new TextEncoder().encode(value),
                    'PBKDF2',
                    false,
                    ['deriveBits']
                ),
                256
            )
        )
    )
const totp = (base32, now = Date.now()) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const c of base32)
        bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)))
    const digest = createHmac(
        'sha1',
        Buffer.from(
            [...Array(Math.floor(bits.length / 8))].map((_, i) =>
                parseInt(bits.slice(i * 8, i * 8 + 8), 2)
            )
        )
    )
        .update(bytes)
        .digest()
    const o = digest.at(-1) & 15
    return String(
        (((digest[o] & 127) << 24) |
            (digest[o + 1] << 16) |
            (digest[o + 2] << 8) |
            digest[o + 3]) %
            1000000
    ).padStart(6, '0')
}
class DB {
    constructor() {
        this.users = [
            {
                id: 1,
                email: 'u@example.test',
                name: 'U',
                password_hash: null,
                password_salt: b64(new Uint8Array(16).fill(7)),
                email_verified_at: 1,
                federated_only: 0
            }
        ]
        this.sessions = []
        this.tfa = null
        this.challenges = []
        this.states = []
        this.identities = []
        this.developer = []
        this.clients = []
        this.codes = []
        this.access = []
        this.refresh = []
        this.usage = []
        this.next = 1
    }
    async init() {
        this.users[0].password_hash = await passwordHash('correct-password')
        this.sessions = [
            {
                id: 'session-1',
                user_id: 1,
                token_hash: hmac('session-token'),
                device_name: 'test',
                created_at: 1,
                last_seen_at: 1,
                expires_at: Date.now() + 86400000,
                revoked_at: null
            }
        ]
    }
    prepare(sql) {
        let v = []
        const rowUser = () => this.users.find(u => u.id === 1)
        const session = () => {
            const s = this.sessions.find(
                x =>
                    x.token_hash === v[0] &&
                    !x.revoked_at &&
                    x.expires_at > v[1]
            )
            if (!s) return null
            return {
                ...s,
                session_id: s.id,
                ...rowUser(),
                google_enabled: 0,
                apple_enabled: 0,
                tfa_enabled: Boolean(this.tfa?.enabled_at)
            }
        }
        const first = async () => {
            if (sql.includes('FROM sessions s')) return session()
            if (sql.includes('FROM oauth_states'))
                return this.states.find(s => s.state_hash === v[0] && !s.used_at && s.expires_at > v[1]) || null
            if (sql.includes('FROM connected_identities WHERE'))
                return this.identities.find(i => i.provider === v[0] && i.provider_subject === v[1]) || null
            if (sql.includes('FROM users WHERE email'))
                return this.users.find(u => u.email === v[0]) || null
            if (sql.includes('FROM users WHERE id')) return rowUser()
            if (
                sql.includes('FROM user_tfa') &&
                !sql.includes('FROM developer_tokens') &&
                !sql.includes('FROM oauth_access_tokens')
            )
                return this.tfa &&
                    this.tfa.user_id === v[0] &&
                    (!sql.includes('enabled_at IS NOT NULL') ||
                        this.tfa.enabled_at)
                    ? { ...this.tfa }
                    : null
            if (sql.includes('FROM tfa_login_challenges'))
                return (
                    this.challenges.find(
                        c =>
                            c.token_hash === v[0] &&
                            !c.used_at &&
                            c.expires_at > v[1]
                    ) || null
                )
            if (sql.includes('FROM developer_tokens'))
                return this.developer.find(
                    t =>
                        t.token_hash === v[0] &&
                        !t.revoked_at &&
                        t.expires_at > v[1]
                )
                    ? {
                          ...this.developer.find(t => t.token_hash === v[0]),
                          ...rowUser(),
                          token_id: this.developer.find(
                              t => t.token_hash === v[0]
                          ).id
                      }
                    : null
            if (sql.includes('FROM oauth_access_tokens'))
                return this.access.find(
                    t =>
                        t.token_hash === v[0] &&
                        !t.revoked_at &&
                        t.expires_at > v[1]
                )
                    ? {
                          ...this.access.find(t => t.token_hash === v[0]),
                          ...rowUser(),
                          access_token_id: this.access.find(
                              t => t.token_hash === v[0]
                          ).id
                      }
                    : null
            if (sql.includes('FROM oauth_refresh_tokens')) {
                const refresh = this.refresh.find(
                    t =>
                        t.token_hash === v[0] &&
                        t.client_id === v[1] &&
                        t.expires_at > v[2]
                )
                if (!refresh) return null
                const client = this.clients.find(c => c.id === v[1])
                return { ...refresh, client_secret_hash: client.client_secret_hash, client_revoked_at: client.revoked_at }
            }
            if (sql.includes('FROM oauth_clients'))
                return (
                    this.clients.find(
                        c =>
                            c.id === v[0] &&
                            (v.length < 2 || c.user_id === v[1])
                    ) || null
                )
            if (sql.includes('FROM oauth_authorization_codes')) {
                const c = this.codes.find(
                    c =>
                        c.code_hash === v[0] &&
                        c.client_id === v[1] &&
                        c.expires_at > v[2]
                )
                if (!c) return null
                const cl = this.clients.find(x => x.id === c.client_id)
                return {
                    ...c,
                    client_secret_hash: cl.client_secret_hash,
                    revoked_at: cl.revoked_at
                }
            }
            if (sql.includes('FROM usage_counters'))
                return (
                    this.usage.find(
                        x => x.user_id === v[0] && x.window_start === v[1]
                    ) || null
                )
            return null
        }
        const all = async () => {
            if (sql.includes('FROM developer_tokens'))
                return {
                    results: this.developer.filter(x => x.user_id === v[0])
                }
            if (sql.includes('FROM oauth_clients'))
                return {
                    results: this.clients.filter(x => x.user_id === v[0])
                }
            if (sql.includes('FROM oauth_access_tokens'))
                return {
                    results: this.access
                        .filter(
                            x =>
                                x.user_id === v[0] &&
                                !x.revoked_at &&
                                x.expires_at > v[1]
                        )
                        .map(x =>
                            this.clients.find(c => c.id === x.client_id)
                        )
                        .filter(Boolean)
                }
            if (sql.includes('FROM sessions')) return { results: this.sessions }
            return { results: [] }
        }
        const run = async () => {
            if (sql.includes('INSERT INTO rate_limits'))
                return { meta: { changes: 1 } }
            if (sql.includes('INSERT INTO usage_counters')) {
                let x = this.usage.find(
                    x => x.user_id === v[0] && x.window_start === v[1]
                )
                if (x) x.units += v[2]
                else
                    this.usage.push({
                        user_id: v[0],
                        window_start: v[1],
                        units: v[2]
                    })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE sessions SET last_seen_at'))
                return { meta: { changes: 1 } }
            if (sql.includes('UPDATE oauth_states SET used_at')) {
                const state = this.states.find(s => s.state_hash === v[1] && !s.used_at)
                if (state) {
                    state.used_at = v[0]
                    return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
            }
            if (sql.includes('INSERT INTO user_tfa')) {
                this.tfa = {
                    user_id: v[0],
                    secret_encrypted: v[1],
                    created_at: v[2],
                    enabled_at: null,
                    recovery_code_hash: null,
                    recovery_used_at: null
                }
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE user_tfa SET secret_encrypted')) {
                Object.assign(this.tfa, {
                    secret_encrypted: v[1],
                    created_at: v[2],
                    enabled_at: null,
                    recovery_code_hash: null,
                    recovery_used_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE user_tfa SET enabled_at')) {
                Object.assign(this.tfa, {
                    enabled_at: v[0],
                    recovery_code_hash: v[1],
                    recovery_used_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE user_tfa SET recovery_used_at')) {
                if (
                    this.tfa &&
                    this.tfa.user_id === v[1] &&
                    this.tfa.recovery_code_hash === v[2] &&
                    !this.tfa.recovery_used_at
                ) {
                    this.tfa.recovery_used_at = v[0]
                    return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
            }
            if (sql.includes('DELETE FROM user_tfa')) {
                this.tfa = null
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO tfa_login_challenges')) {
                this.challenges.push({
                    id: this.next++,
                    token_hash: v[0],
                    user_id: v[1],
                    redirect_path: v[2],
                    expires_at: v[3],
                    used_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE tfa_login_challenges')) {
                const c = this.challenges.find(
                    c => c.id === v[1] && !c.used_at
                )
                if (c) {
                    c.used_at = v[0]
                    return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
            }
            if (sql.includes('INSERT INTO developer_tokens')) {
                this.developer.push({
                    id: v[0],
                    user_id: v[1],
                    name: v[2],
                    token_hash: v[3],
                    scopes: v[4],
                    expires_at: v[5],
                    created_at: v[6],
                    last_used_at: null,
                    revoked_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE developer_tokens SET last_used_at'))
                return { meta: { changes: 1 } }
            if (sql.includes('UPDATE developer_tokens SET revoked_at')) {
                const t = this.developer.find(
                    x => x.id === v[1] && x.user_id === v[2] && !x.revoked_at
                )
                if (t) {
                    t.revoked_at = v[0]
                    return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
            }
            if (sql.includes('INSERT INTO oauth_clients')) {
                this.clients.push({
                    id: v[0],
                    user_id: v[1],
                    name: v[2],
                    icon: v[3],
                    site: v[4],
                    description: v[5],
                    redirect_uris: v[6],
                    client_secret_hash: v[7],
                    created_at: v[8],
                    updated_at: v[9],
                    revoked_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO oauth_authorization_codes')) {
                this.codes.push({
                    id: this.next++,
                    code_hash: v[0],
                    client_id: v[1],
                    user_id: v[2],
                    redirect_uri: v[3],
                    scopes: v[4],
                    code_challenge: v[5],
                    expires_at: v[6],
                    created_at: v[7],
                    used_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE oauth_authorization_codes')) {
                const c = this.codes.find(c => c.id === v[1] && !c.used_at)
                if (c) {
                    c.used_at = v[0]
                    return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
            }
            if (sql.includes('INSERT INTO oauth_access_tokens')) {
                this.access.push({
                    id: v[0],
                    token_hash: v[1],
                    client_id: v[2],
                    user_id: v[3],
                    scopes: v[4],
                    expires_at: v[5],
                    created_at: v[6],
                    last_used_at: null,
                    revoked_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO oauth_refresh_tokens')) {
                this.refresh.push({
                    id: v[0],
                    token_hash: v[1],
                    client_id: v[2],
                    user_id: v[3],
                    scopes: v[4],
                    expires_at: v[5],
                    created_at: v[6],
                    used_at: null,
                    revoked_at: null
                })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE oauth_refresh_tokens')) {
                const token = this.refresh.find(t => t.id === v[2] && !t.used_at && !t.revoked_at && t.expires_at > v[3])
                if (token) {
                    token.used_at = v[0]
                    token.revoked_at = v[1]
                    return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
            }
            if (sql.includes('UPDATE oauth_access_tokens SET last_used_at'))
                return { meta: { changes: 1 } }
            if (sql.includes('INSERT INTO audit_records'))
                return { meta: { changes: 1 } }
            return { meta: { changes: 1 } }
        }
        return {
            bind: (...args) => {
                v = args
                return { first, all, run }
            }
        }
    }
}
const env = db => ({
    DB: db,
    SESSION_SECRET: secret,
    ENCRYPTION_KEY: secret,
    APP_ORIGIN: 'https://app.example.test',
    API_ORIGIN: 'https://api.example.test',
    CORS_ORIGINS: 'https://app.example.test',
    ENVIRONMENT: 'production',
    RATE_LIMIT_PER_MINUTE: '1000',
    MAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 'mail',
    MAIL_FROM: 'mail@example.test'
})
const req = (path, method = 'GET', body, headers = {}) =>
    new Request('https://api.example.test' + path, {
        method,
        headers: new Headers({
            Cookie: 'rd_session=session-token',
            ...(body !== undefined
                ? { 'Content-Type': 'application/json' }
                : {}),
            ...headers
        }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
const formReq = (path, values, headers = {}) =>
    new Request('https://api.example.test' + path, {
        method: 'POST',
        headers: new Headers({
            Cookie: 'rd_session=session-token',
            'Content-Type': 'application/x-www-form-urlencoded',
            ...headers
        }),
        body: new URLSearchParams(values)
    })
test('public identity access controls', async () => {
    const db = new DB()
    await db.init()
    const e = env(db)
    let r = await worker.fetch(req('/v1/user/tfa'), e)
    assert.equal(r.status, 200)
    const cfg = await r.json()
    assert.match(cfg.secret, /^[A-Z2-7]+$/)
    const code = totp(cfg.secret)
    r = await worker.fetch(req('/v1/user/tfa', 'POST', { code }), e)
    assert.equal(r.status, 200)
    const enabled = await r.json()
    assert.ok(enabled.recoveryCode)
    r = await worker.fetch(
        req('/v1/auth/email/login', 'POST', {
            email: 'u@example.test',
            password: 'correct-password'
        }),
        { ...e }
    )
    assert.equal(r.status, 200)
    const challenge = (await r.json()).tfa
    assert.ok(challenge)
    r = await worker.fetch(
        req('/v1/auth/tfa/' + challenge, 'POST', { code }),
        e
    )
    assert.equal(r.status, 200)
    assert.match(r.headers.get('Set-Cookie'), /rd_session=/)
    r = await worker.fetch(
        req('/v1/auth/tfa/' + challenge, 'POST', { code }),
        e
    )
    assert.equal(r.status, 401)
    r = await worker.fetch(
        req('/v1/auth/email/login', 'POST', {
            email: 'u@example.test',
            password: 'correct-password'
        }),
        e
    )
    const recoveryChallenge = (await r.json()).tfa
    r = await worker.fetch(
        req('/v1/auth/tfa/' + recoveryChallenge, 'POST', { code: enabled.recoveryCode }),
        e
    )
    assert.equal(r.status, 200)
})
test('developer token scopes, expiry and revocation', async () => {
    const db = new DB()
    await db.init()
    const e = env(db)
    let r = await worker.fetch(
        req('/v1/developer/tokens', 'POST', {
            name: 'reader',
            scope: 'profile:read bookmarks:read',
            expiresIn: 3600
        }),
        e
    )
    assert.equal(r.status, 201)
    const made = await r.json()
    assert.ok(made.token)
    r = await worker.fetch(
        req('/v1/user', 'GET', undefined, {
            Cookie: '',
            Authorization: 'Bearer ' + made.token
        }),
        e
    )
    assert.equal(r.status, 200)
    r = await worker.fetch(
        req(
            '/v1/collections',
            'DELETE',
            { ids: [1] },
            { Cookie: '', Authorization: 'Bearer ' + made.token }
        ),
        e
    )
    assert.equal(r.status, 403)
    r = await worker.fetch(
        req('/v1/developer/tokens/' + made.item.id, 'DELETE', undefined, {}),
        e
    )
    assert.equal(r.status, 200)
    r = await worker.fetch(
        req('/v1/user', 'GET', undefined, {
            Cookie: '',
            Authorization: 'Bearer ' + made.token
        }),
        e
    )
    assert.equal(r.status, 401)
})

test('Beta cookie sessions keep their existing contract', async () => {
    const db = new DB()
    await db.init()
    const production = env(db)
    const response = await worker.fetch(req('/v1/user'), {
        ...production,
        ENVIRONMENT: 'beta'
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).user.email, 'u@example.test')

    const tokenResponse = await worker.fetch(req('/v1/developer/tokens', 'POST', {
        name: 'beta-check',
        scope: 'profile:read',
        expiresIn: 3600
    }), production)
    const token = (await tokenResponse.json()).token
    const bearerResponse = await worker.fetch(req('/v1/user', 'GET', undefined, {
        Cookie: '',
        Authorization: 'Bearer ' + token
    }), { ...production, ENVIRONMENT: 'beta' })
    assert.equal(bearerResponse.status, 401)
    const managementResponse = await worker.fetch(req('/v1/developer/tokens'), {
        ...production,
        ENVIRONMENT: 'beta'
    })
    assert.equal(managementResponse.status, 404)
    const oauthResponse = await worker.fetch(req('/v1/oauth/token', 'POST', {}), {
        ...production,
        ENVIRONMENT: 'beta'
    })
    assert.equal(oauthResponse.status, 404)
})

test('Apple authorization requests use form_post for requested identity scopes', async () => {
    const db = new DB()
    await db.init()
    const response = await worker.fetch(req('/v1/auth/apple'), {
        ...env(db),
        APPLE_CLIENT_ID: 'com.example.web',
        APPLE_TEAM_ID: 'TEAM123',
        APPLE_KEY_ID: 'KEY123',
        APPLE_PRIVATE_KEY: 'private-key'
    })
    assert.equal(response.status, 302)
    const location = new URL(response.headers.get('Location'))
    assert.equal(location.searchParams.get('response_mode'), 'form_post')
    assert.equal(location.searchParams.get('scope'), 'name email')
})

test('Apple callback accepts an RS256 ID token from the Apple RSA JWKS', async () => {
    const db = new DB()
    await db.init()
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const appleKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const applePrivateKey = appleKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const kid = 'rsa-key'
    const now = Math.floor(Date.now() / 1000)
    const header = b64(Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })))
    const payload = b64(Buffer.from(JSON.stringify({
        iss: 'https://appleid.apple.com',
        aud: 'com.example.web',
        exp: now + 300,
        iat: now,
        sub: 'apple-subject',
        email: 'apple@example.test',
        email_verified: true
    })))
    const signingInput = header + '.' + payload
    const idToken = signingInput + '.' + b64(createSign('RSA-SHA256').update(signingInput).sign(privateKey))
    db.states.push({
        state_hash: hmac('apple-state'),
        purpose: 'apple_login',
        user_id: null,
        redirect_path: '/',
        admission_granted: 1,
        expires_at: Date.now() + 600000,
        used_at: null
    })
    db.identities.push({ provider: 'apple', provider_subject: 'apple-subject', user_id: 1 })
    const e = {
        ...env(db),
        APPLE_CLIENT_ID: 'com.example.web',
        APPLE_TEAM_ID: 'TEAM123',
        APPLE_KEY_ID: 'KEY123',
        APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\n' + applePrivateKey + '\n-----END PRIVATE KEY-----',
        APPLE_JWKS_URL: 'https://apple.example.test/keys'
    }
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async input => {
        const target = String(input.url || input)
        if (target === 'https://appleid.apple.com/auth/token')
            return new Response(JSON.stringify({ id_token: idToken }), { status: 200 })
        if (target === e.APPLE_JWKS_URL)
            return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
        throw new Error('unexpected fetch: ' + target)
    }
    try {
        const response = await worker.fetch(req('/v1/auth/apple/callback?code=apple-code&state=apple-state'), e)
        assert.equal(response.status, 303)
        assert.equal(new URL(response.headers.get('Location')).pathname, '/')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('oauth authorization code requires exact redirect and S256 PKCE', async () => {
    const db = new DB()
    await db.init()
    const e = env(db)
    let r = await worker.fetch(
        req('/v1/oauth/client', 'POST', { name: 'missing-redirect' }),
        e
    )
    assert.equal(r.status, 400)
    r = await worker.fetch(
        req('/v1/oauth/client', 'POST', {
            name: 'app',
            redirects: ['https://client.example/callback']
        }),
        e
    )
    assert.equal(r.status, 201)
    const client = (await r.json()).item
    const verifier = 'a'.repeat(43)
    const challenge = b64(createHash('sha256').update(verifier).digest())
    r = await worker.fetch(
        req(
            '/v1/oauth/authorize?response_type=code&client_id=' +
                client.client_id +
                '&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_challenge=' +
                challenge +
                '&code_challenge_method=S256&state=x'
        ),
        e
    )
    assert.equal(r.status, 200)
    assert.match(r.headers.get('Content-Type'), /text\/html/)
    const consent = await r.text()
    assert.match(consent, /Authorize app/)
    assert.doesNotMatch(consent, /name="code"/)
    const approvalToken = consent.match(/name="approval_token" value="([^"]+)"/)?.[1]
    assert.ok(approvalToken)
    r = await worker.fetch(formReq('/v1/oauth/authorize', { decision: 'approve', approval_token: 'tampered' }), e)
    assert.equal(r.status, 400)
    r = await worker.fetch(formReq('/v1/oauth/authorize', {
        approval_token: approvalToken,
        decision: 'deny'
    }), e)
    assert.equal(r.status, 302)
    let denied = new URL(r.headers.get('Location'))
    assert.equal(denied.searchParams.get('error'), 'access_denied')
    assert.equal(denied.searchParams.get('state'), 'x')

    r = await worker.fetch(
        req(
            '/v1/oauth/authorize?response_type=code&client_id=' +
                client.client_id +
                '&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_challenge=' +
                challenge +
                '&code_challenge_method=S256&state=x'
        ),
        e
    )
    const approval = (await r.text()).match(/name="approval_token" value="([^"]+)"/)?.[1]
    assert.ok(approval)
    r = await worker.fetch(formReq('/v1/oauth/authorize', {
        approval_token: approval,
        decision: 'approve'
    }), e)
    assert.equal(r.status, 302)
    const code = new URL(r.headers.get('Location')).searchParams.get('code')
    r = await worker.fetch(
        req(
            '/v1/oauth/token',
            'POST',
            {
                grant_type: 'authorization_code',
                client_id: client.client_id,
                redirect_uri: 'https://client.example/callback',
                code,
                code_verifier: verifier
            },
            { Cookie: '' }
        ),
        e
    )
    assert.equal(r.status, 200)
    const exchanged = await r.json()
    const token = exchanged.access_token
    const refresh = exchanged.refresh_token
    assert.ok(token)
    assert.ok(refresh)
    r = await worker.fetch(
        req(
            '/v1/oauth/access_token',
            'POST',
            {
                grant_type: 'refresh_token',
                client_id: client.client_id,
                client_secret: client.client_secret,
                refresh_token: refresh
            },
            { Cookie: '' }
        ),
        e
    )
    assert.equal(r.status, 200)
    assert.ok((await r.json()).refresh_token)
    r = await worker.fetch(
        req(
            '/v1/oauth/token',
            'POST',
            {
                grant_type: 'authorization_code',
                client_id: client.client_id,
                redirect_uri: 'https://wrong.example/callback',
                code,
                code_verifier: verifier
            },
            { Cookie: '' }
        ),
        e
    )
    assert.equal(r.status, 400)
    r = await worker.fetch(
        req('/v1/user', 'GET', undefined, {
            Cookie: '',
            Authorization: 'Bearer ' + token
        }),
        e
    )
    assert.equal(r.status, 200)
})
