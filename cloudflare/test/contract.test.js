import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import worker from '../src/index.js'

const require = createRequire(import.meta.url)
const manifest = require('../contracts/v1-routes.json')
const environments = require('../environments.json')
const env = {
    DB: {},
    ENVIRONMENT: 'local',
    VERSION: '0.1.0-local',
    APP_ORIGIN: 'http://localhost:2000',
    CORS_ORIGINS: 'http://localhost:2000 http://127.0.0.1:2000 chrome-extension://*',
    SESSION_SECRET: 'test-session-secret'
}

test('environment profiles keep origins, resources, and secret scopes separate', () => {
    const profiles = Object.values(environments)
    const unique = values => assert.equal(new Set(values).size, profiles.length)

    unique(profiles.map(profile => profile.apiOrigin))
    unique(profiles.map(profile => profile.aiPageOrigin))
    unique(profiles.map(profile => profile.workerName))
    unique(profiles.map(profile => profile.secretScope))
    assert.equal(environments.beta.attachmentScanEnabled, false)
    assert.equal(profiles.filter(profile => profile !== environments.beta).every(profile => profile.attachmentScanEnabled), true)

    const resourceNames = profiles.flatMap(profile => Object.values(profile.resourceNames))
    assert.equal(new Set(resourceNames).size, resourceNames.length)
})

test('contract manifest entries describe response cases', () => {
    assert.equal(manifest.version, '1.0.0')
    assert.ok(manifest.routes.length > 0)
    for (const route of manifest.routes) {
        assert.match(route.path, /^\/v1\//)
        assert.ok(['required', 'none'].includes(route.authentication))
        if (route.authentication === 'required')
            assert.ok(route.responses.includes(401))
    }
})

test('health and version expose the selected environment', async () => {
    const health = await worker.fetch(new Request('http://localhost/health'), env)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
        result: true,
        status: 'ok',
        environment: 'local',
        version: '0.1.0-local'
    })

    const deployedVersion = await worker.fetch(new Request('http://localhost/version'), env)
    assert.equal(deployedVersion.status, 200)
    assert.deepEqual(await deployedVersion.json(), {
        result: true,
        environment: 'local',
        version: '0.1.0-local'
    })
})

test('unauthenticated v1 requests return the login envelope', async () => {
    const response = await worker.fetch(new Request('http://localhost/v1/user', {
        headers: { Origin: 'http://localhost:2000' }
    }), env)

    assert.equal(response.status, 401)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:2000')
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true')
    assert.deepEqual(await response.json(), {
        result: false,
        auth: false,
        error: 'auth_required',
        errorMessage: 'Login is required',
        login: 'http://localhost:2000/account/login'
    })

    const loopbackResponse = await worker.fetch(new Request('http://localhost/v1/user', {
        headers: { Origin: 'http://127.0.0.1:2000' }
    }), env)
    assert.equal(loopbackResponse.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:2000')
})

test('configured extension origins receive credentialed CORS headers', async () => {
    const response = await worker.fetch(new Request('http://localhost/v1/user', {
        headers: { Origin: 'chrome-extension://local-dev' }
    }), env)

    assert.equal(response.status, 401)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://local-dev')
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true')
})

test('preflight returns credentialed CORS headers without a response body', async () => {
    const response = await worker.fetch(new Request('http://localhost/v1/auth/email/signup', {
        method: 'OPTIONS',
        headers: {
            Origin: 'http://localhost:2000',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'Content-Type'
        }
    }), env)

    assert.equal(response.status, 204)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:2000')
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true')
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-Request-ID, X-Device-Name')
})
