import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const environments = require('../environments.json')
const web = require('../../build/web.js')
const extension = require('../../build/extension.js')
const manifest = require('../../src/target/extension/manifest/index.js')

const profiles = ['local', 'preview', 'beta']
const definitionsFor = config => config.plugins.find(plugin =>
    plugin.definitions?.['process.env.API_ORIGIN'])?.definitions
const valueFor = (definitions, name) => JSON.parse(definitions[`process.env.${name}`])

test('Web and Chrome development profiles inject matching origins and API host permissions', () => {
    for (const name of profiles) {
        const profile = environments[name]
        const webConfig = web({ environment: name })
        const chromeConfig = extension({ environment: name, vendor: 'chrome' })
        const webDefinitions = definitionsFor(webConfig)
        const chromeDefinitions = definitionsFor(chromeConfig)

        for (const definitions of [webDefinitions, chromeDefinitions]) {
            assert.equal(valueFor(definitions, 'API_ORIGIN'), profile.apiOrigin)
            assert.equal(valueFor(definitions, 'AI_PAGE_ORIGIN'), profile.aiPageOrigin)
            assert.equal(valueFor(definitions, 'APP_ORIGIN'), profile.appOrigin)
            assert.equal(valueFor(definitions, 'RAINDROP_BUILD_ENVIRONMENT'), name)
        }

        assert.equal(
            webConfig.output.path,
            path.resolve(process.cwd(), 'dist', 'web', name === 'local' ? 'dev' : name)
        )
        assert.equal(
            chromeConfig.output.path,
            path.resolve(process.cwd(), 'dist', 'chrome', name === 'local' ? 'dev' : name)
        )

        const generated = manifest({ vendor: 'chrome', apiOrigin: profile.apiOrigin }, { emitFile() {} })
        assert.deepEqual(JSON.parse(generated.code).host_permissions, [`${new URL(profile.apiOrigin).origin}/*`])
    }
})
