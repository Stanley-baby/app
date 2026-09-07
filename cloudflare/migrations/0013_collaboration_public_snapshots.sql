ALTER TABLE collections ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE collections ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1));

UPDATE collections
SET slug = lower(trim(id))
WHERE slug = '';

INSERT OR IGNORE INTO collection_collaborators (collection_id, user_id, role)
SELECT id, user_id, 'owner' FROM collections;

CREATE INDEX collection_collaborators_user ON collection_collaborators(user_id, collection_id);

CREATE TABLE collection_invitations (
    token_hash TEXT PRIMARY KEY,
    collection_id INTEGER NOT NULL,
    invited_by INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('editor', 'viewer')),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    FOREIGN KEY (collection_id) REFERENCES collections(id),
    FOREIGN KEY (invited_by) REFERENCES users(id)
);

CREATE INDEX collection_invitations_collection ON collection_invitations(collection_id, expires_at);

CREATE TABLE published_snapshots (
    content_id TEXT PRIMARY KEY,
    collection_id INTEGER NOT NULL,
    bookmark_id INTEGER NOT NULL,
    published_by INTEGER NOT NULL,
    published_at INTEGER NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY (content_id) REFERENCES content_objects(id),
    FOREIGN KEY (collection_id) REFERENCES collections(id),
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id),
    FOREIGN KEY (published_by) REFERENCES users(id)
);

CREATE INDEX published_snapshots_collection ON published_snapshots(collection_id, revoked_at, published_at);
