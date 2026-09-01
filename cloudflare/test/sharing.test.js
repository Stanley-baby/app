import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import worker from '../src/index.js'

/* global globalThis */

globalThis.crypto ||= webcrypto

class SharingDatabase {
    constructor() {
        this.users = [
            { id: 1, email: 'owner@example.test', name: 'Owner' },
            { id: 2, email: 'editor@example.test', name: 'Editor' },
            { id: 3, email: 'viewer@example.test', name: 'Viewer' }
        ]
        this.collections = []
        this.bookmarks = []
        this.contents = []
        this.collaborators = []
        this.invitations = []
        this.published = []
        this.nextCollectionId = 1
        this.sessionUserId = 1
    }

    session() {
        const user = this.users.find(item => item.id === this.sessionUserId)
        return user && {
            session_id: 'session-' + user.id,
            user_id: user.id,
            device_name: 'test',
            created_at: 1,
            last_seen_at: 1,
            expires_at: Date.now() + 86400000,
            id: user.id,
            email: user.email,
            name: user.name,
            email_verified_at: 1,
            federated_only: 0,
            google_enabled: false
        }
    }

    prepare(sql) {
        let values = []
        const first = async () => {
            if (sql.includes('FROM sessions s')) return this.session()
            if (sql.includes('FROM usage_counters')) return null
            if (sql.includes('FROM collections WHERE id')) {
                const item = this.collections.find(collection => collection.id === Number(values[0]))
                if (!item) return null
                if (sql.includes('user_id = ?') && item.user_id !== Number(values[1])) return null
                if (sql.includes('removed_at IS NULL') && item.removed_at) return null
                return { ...item }
            }
            if (sql.includes('FROM collections c')) {
                const item = this.collections.find(collection => collection.id === Number(values[0]))
                if (!item || item.removed_at) return null
                if (sql.includes('user_id = ?') && item.user_id !== Number(values[1])) return null
                return { ...item, count: this.bookmarks.filter(bookmark => bookmark.collection_id === item.id && !bookmark.removed_at).length }
            }
            if (sql.includes('FROM collection_collaborators') && sql.includes('SELECT role'))
                return this.collaborators.find(item => item.collection_id === Number(values[0]) && item.user_id === Number(values[1])) || null
            if (sql.includes('FROM users WHERE id'))
                return this.users.find(item => item.id === Number(values[0])) || null
            if (sql.includes('FROM collection_invitations'))
                return this.invitations.find(item => item.token_hash === values[0] && !item.used_at && item.expires_at > values[1]) || null
            if (sql.includes('FROM content_objects co JOIN bookmarks')) {
                const id = String(values[0])
                const allowed = new Set(values.slice(1).map(Number))
                const content = this.contents.find(item => item.id === id)
                const bookmark = content && this.bookmarks.find(item => item.id === content.bookmark_id)
                return content && bookmark && allowed.has(bookmark.collection_id)
                    ? { id: content.id, bookmark_id: content.bookmark_id, kind: content.kind, status: content.status, collection_id: bookmark.collection_id }
                    : null
            }
            if (sql.includes('published_snapshots ps') && sql.includes('content_objects co')) {
                const content = this.contents.find(item => item.id === values[0])
                const published = this.published.find(item => item.content_id === values[0] && !item.revoked_at)
                const collection = published && this.collections.find(item => item.id === published.collection_id)
                return content && published && collection?.is_public && !collection.removed_at && content.status === 'cleared'
                    ? { ...content, published_at: published.published_at, collection_id: published.collection_id, bookmark_collection_id: this.bookmarks.find(item => item.id === content.bookmark_id)?.collection_id }
                    : null
            }
            if (sql.includes('FROM content_objects WHERE'))
                return this.contents.find(item => item.id === values[0]) || null
            if (sql.includes('FROM bookmarks WHERE id')) {
                const bookmark = this.bookmarks.find(item => item.id === Number(values[0]))
                if (!bookmark) return null
                return sql.includes('user_id = ?') && bookmark.user_id !== Number(values[1]) ? null : { ...bookmark }
            }
            if (sql.includes('FROM bookmarks WHERE')) return null
            if (sql.includes('FROM published_snapshots')) return null
            return null
        }
        const all = async () => {
            if (sql.includes('FROM collections WHERE removed_at IS NULL')) return { results: this.collections.filter(item => !item.removed_at).map(item => ({ ...item })) }
            if (sql.includes('FROM collection_collaborators cc')) return { results: this.collaborators.map(item => ({ ...item, ...this.users.find(user => user.id === item.user_id) })) }
            if (sql.includes('FROM published_snapshots')) {
                const collectionId = Number(values[0])
                return { results: this.published.filter(item => item.collection_id === collectionId && !item.revoked_at).flatMap(item => {
                    const content = this.contents.find(contentItem => contentItem.id === item.content_id)
                    return content ? [{ ...item, ...content }] : []
                }) }
            }
            if (sql.includes('FROM bookmarks WHERE removed_at IS NULL')) {
                const ids = new Set(values.map(Number))
                return { results: this.bookmarks.filter(item => !item.removed_at && ids.has(item.collection_id)).map(item => ({ ...item })) }
            }
            return { results: [] }
        }
        const run = async () => {
            if (sql.includes('INSERT INTO rate_limits') || sql.includes('INSERT INTO usage_counters') || sql.includes('INSERT INTO audit_records'))
                return { meta: { changes: 1 } }
            if (sql.includes('UPDATE sessions SET last_seen_at')) return { meta: { changes: 1 } }
            if (sql.includes('UPDATE collections SET slug')) return { meta: { changes: 1 } }
            if (sql.includes('UPDATE collections SET view')) {
                const matches = this.collections.filter(item => item.user_id === Number(values[2]) && !item.removed_at)
                for (const item of matches) item.view = values[0]
                return { meta: { changes: matches.length } }
            }
            if (sql.includes('INSERT INTO collections')) {
                const collection = { id: this.nextCollectionId++, user_id: Number(values[0]), title: values[1], parent_id: values[2], created_at: values[3], updated_at: values[4], slug: values[5], is_public: 0, view: 'list', removed_at: null }
                this.collections.push(collection)
                return { meta: { last_row_id: collection.id, changes: 1 } }
            }
            if (sql.includes('INSERT INTO collection_collaborators')) {
                const collectionId = Number(values[0])
                const userId = Number(values[1])
                const role = sql.includes(String.fromCharCode(39) + 'owner' + String.fromCharCode(39))
                    ? 'owner'
                    : sql.includes(String.fromCharCode(39) + 'editor' + String.fromCharCode(39)) ? 'editor' : values[2]
                const existing = this.collaborators.find(item => item.collection_id === collectionId && item.user_id === userId)
                if (existing) existing.role = role
                else this.collaborators.push({ collection_id: collectionId, user_id: userId, role })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('INSERT INTO collection_invitations')) {
                this.invitations.push({ token_hash: values[0], collection_id: Number(values[1]), invited_by: Number(values[2]), role: values[3], expires_at: values[4], created_at: values[5], used_at: null })
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE collection_invitations SET used_at')) {
                const item = this.invitations.find(invite => invite.token_hash === values[1] && !invite.used_at)
                if (item) item.used_at = values[0]
                return { meta: { changes: item ? 1 : 0 } }
            }
            if (sql.includes('DELETE FROM collection_collaborators')) {
                const before = this.collaborators.length
                if (sql.includes('user_id != ?')) this.collaborators = this.collaborators.filter(item => item.collection_id !== Number(values[0]) || item.user_id === Number(values[1]))
                else this.collaborators = this.collaborators.filter(item => item.collection_id !== Number(values[0]) || item.user_id !== Number(values[1]))
                return { meta: { changes: before - this.collaborators.length } }
            }
            if (sql.includes('UPDATE collections SET user_id')) {
                const item = this.collections.find(collection => collection.id === Number(values[2]) && collection.user_id === Number(values[3]))
                if (item) item.user_id = Number(values[0])
                return { meta: { changes: item ? 1 : 0 } }
            }
            if (sql.includes('UPDATE collections SET title')) {
                const item = this.collections.find(collection => collection.id === Number(values[6]) && collection.user_id === Number(values[7]))
                if (item) Object.assign(item, { title: values[0], parent_id: values[1], slug: values[2], is_public: Number(values[3]), view: values[4], updated_at: values[5] })
                return { meta: { changes: item ? 1 : 0 } }
            }
            if (sql.includes('INSERT INTO published_snapshots')) {
                const item = { content_id: values[0], collection_id: Number(values[1]), bookmark_id: Number(values[2]), published_by: Number(values[3]), published_at: values[4], revoked_at: null }
                const existing = this.published.find(snapshot => snapshot.content_id === item.content_id)
                if (existing) Object.assign(existing, item)
                else this.published.push(item)
                return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE published_snapshots SET revoked_at')) {
                const item = this.published.find(snapshot => snapshot.content_id === values[1] && snapshot.collection_id === Number(values[2]) && !snapshot.revoked_at)
                if (item) item.revoked_at = values[0]
                return { meta: { changes: item ? 1 : 0 } }
            }
            return { meta: { changes: 1 } }
        }
        return { bind: (...next) => { values = next; return { first, all, run } } }
    }
}

const envFor = db => ({
    DB: db,
    SESSION_SECRET: 'sharing-test-secret',
    API_ORIGIN: 'https://api.example.test',
    APP_ORIGIN: 'https://app.example.test',
    CORS_ORIGINS: 'https://app.example.test',
    ENVIRONMENT: 'local',
    VERSION: 'test'
})

const request = (path, options = {}) => new Request('https://api.example.test' + path, options)
const jsonRequest = (path, method, body, cookie = 'rd_session=test') => request(path, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
})

test('collaboration invitations, role inheritance, and explicit ownership transfer work', async () => {
    const db = new SharingDatabase()
    const env = envFor(db)
    const rootResponse = await worker.fetch(jsonRequest('/v1/collection', 'POST', { title: 'Shared Root' }), env)
    assert.equal(rootResponse.status, 201)
    const rootId = (await rootResponse.json()).item._id
    const childResponse = await worker.fetch(jsonRequest('/v1/collection', 'POST', { title: 'Child', parentId: rootId }), env)
    const childId = (await childResponse.json()).item._id

    const inviteResponse = await worker.fetch(jsonRequest(`/v1/collection/${rootId}/sharing`, 'POST', { role: 'editor' }), env)
    assert.equal(inviteResponse.status, 201)
    const invite = await inviteResponse.json()
    assert.match(invite.link, /\/join\/[^/]+$/)
    const token = invite.link.split('/').pop()

    db.sessionUserId = 2
    const joined = await worker.fetch(request('/v1/collaborators/join?token=' + encodeURIComponent(token), { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(joined.status, 200)
    assert.equal((await joined.json()).role, 'editor')

    const child = await worker.fetch(request('/v1/collection/' + childId, { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal(child.status, 200)
    assert.equal((await child.json()).item.access.role, 'editor')

    db.sessionUserId = 1
    const childViewer = await worker.fetch(jsonRequest(`/v1/collection/${childId}/sharing/2`, 'PUT', { role: 'viewer' }), env)
    assert.equal(childViewer.status, 200)
    db.sessionUserId = 2
    const inherited = await worker.fetch(request('/v1/collection/' + childId, { headers: { Cookie: 'rd_session=test' } }), env)
    assert.equal((await inherited.json()).item.access.role, 'editor')

    db.sessionUserId = 1
    const transfer = await worker.fetch(jsonRequest(`/v1/collection/${rootId}/transfer`, 'POST', { userId: 2 }), env)
    assert.equal(transfer.status, 200)
    assert.equal(db.collections.find(item => item.id === rootId).user_id, 2)
})

test('public links keep the numeric ID, hide private snapshots, and expose only published cleared snapshots', async () => {
    const db = new SharingDatabase()
    const env = envFor(db)
    const created = await worker.fetch(jsonRequest('/v1/collection', 'POST', { title: 'Public Root', slug: 'public-root' }), env)
    const collectionId = (await created.json()).item._id
    db.bookmarks.push({ id: 1, user_id: 1, collection_id: collectionId, url: 'https://example.test/public', title: 'Public bookmark', description: 'metadata', tags: '["tag"]', created_at: 1, updated_at: 1, removed_at: null })
    db.contents.push({ id: 'snapshot-1', user_id: 1, bookmark_id: 1, kind: 'snapshot', status: 'cleared', object_key: 'content/1/snapshot-1', filename: 'page.html', content_type: 'text/html', size_bytes: 14 })
    db.collections.push(
        { id: 2, user_id: 1, title: 'Second', parent_id: null, view: 'list', is_public: 0, removed_at: null },
        { id: 3, user_id: 1, title: 'Removed', parent_id: null, view: 'grid', is_public: 0, removed_at: 1 },
        { id: 4, user_id: 2, title: 'Foreign', parent_id: null, view: 'grid', is_public: 0, removed_at: null }
    )

    const enabled = await worker.fetch(jsonRequest('/v1/collection/' + collectionId, 'PUT', { public: true, slug: 'public-root', view: 'grid' }), env)
    assert.equal(enabled.status, 200)
    const enabledBody = await enabled.json()
    const publicLink = enabledBody.item.publicLink
    assert.equal(enabledBody.item.view, 'grid')
    assert.match(publicLink, /\/public\/public-root-\d+$/)

    const before = await worker.fetch(request(`/v1/public/collections/${collectionId}/public-root`), env)
    assert.equal(before.status, 200)
    const beforeBody = await before.json()
    assert.equal(beforeBody.collection.view, 'grid')
    assert.equal(beforeBody.items[0].publishedSnapshots.length, 0)
    assert.equal(beforeBody.items[0].note, undefined)

    const invalidView = await worker.fetch(jsonRequest('/v1/collection/' + collectionId, 'PUT', { view: 'cards' }), env)
    assert.equal(invalidView.status, 400)
    assert.equal((await invalidView.json()).error, 'validation_failed')

    const allViews = await worker.fetch(jsonRequest('/v1/collections', 'PUT', { view: 'masonry' }), env)
    assert.equal(allViews.status, 200)
    assert.equal((await allViews.json()).view, 'masonry')
    assert.equal(db.collections.find(item => item.id === 1).view, 'masonry')
    assert.equal(db.collections.find(item => item.id === 2).view, 'masonry')
    assert.equal(db.collections.find(item => item.id === 3).view, 'grid')
    assert.equal(db.collections.find(item => item.id === 4).view, 'grid')
    const bulkView = await worker.fetch(request(`/public/public-root-${collectionId}`), env)
    assert.equal((await bulkView.json()).collection.view, 'masonry')

    const published = await worker.fetch(jsonRequest(`/v1/collection/${collectionId}/published-snapshots`, 'POST', { contentId: 'snapshot-1' }), env)
    assert.equal(published.status, 200)
    const after = await worker.fetch(request(`/public/public-root-${collectionId}`), env)
    assert.equal(after.status, 200)
    const afterBody = await after.json()
    assert.equal(afterBody.items[0].publishedSnapshots[0].contentId, 'snapshot-1')

    const slugChanged = await worker.fetch(jsonRequest('/v1/collection/' + collectionId, 'PUT', { title: 'Renamed Public Root', slug: 'renamed' }), env)
    assert.equal(slugChanged.status, 200)
    const renamed = (await slugChanged.json()).item
    assert.equal(renamed._id, collectionId)
    assert.match(renamed.publicLink, new RegExp('renamed-' + collectionId + '$'))

    const object = { objects: new Map([['content/1/snapshot-1', new TextEncoder().encode('<html>ok</html>')]]) }
    env.CONTENT_BUCKET = {
        get: async key => ({ body: new Blob([object.objects.get(key)]).stream(), size: object.objects.get(key).byteLength })
    }
    const download = await worker.fetch(request('/public/content/snapshot-1'), env)
    assert.equal(download.status, 200)
    assert.equal(await download.text(), '<html>ok</html>')

    await worker.fetch(jsonRequest(`/v1/collection/${collectionId}/published-snapshots/snapshot-1`, 'DELETE', undefined), env)
    assert.equal((await worker.fetch(request(`/v1/public/collections/${collectionId}/renamed`), env)).status, 200)
    assert.equal((await (await worker.fetch(request('/public/content/snapshot-1'), env)).json()).error, 'content_not_found')
})
