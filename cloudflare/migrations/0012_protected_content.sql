CREATE TABLE content_objects (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    bookmark_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('attachment', 'snapshot', 'screenshot')),
    status TEXT NOT NULL CHECK(status IN ('quarantined', 'cleared')),
    object_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0 AND size_bytes <= 52428800),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    cleared_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id)
);

CREATE INDEX content_objects_user_bookmark ON content_objects(user_id, bookmark_id, created_at DESC);
CREATE INDEX content_objects_status ON content_objects(status, updated_at);

CREATE TABLE background_tasks_v2 (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    bookmark_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('metadata_enrichment', 'attachment_scan', 'capture')),
    status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'retrying', 'succeeded', 'dead_letter')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
    retry_count INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE,
    source_url TEXT NOT NULL,
    content_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    result_metadata TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    error_message TEXT,
    next_retry_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id),
    FOREIGN KEY (content_id) REFERENCES content_objects(id)
);

INSERT INTO background_tasks_v2 (
    id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key,
    source_url, result_metadata, error_code, error_message, next_retry_at,
    created_at, updated_at, completed_at
)
SELECT id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key,
    source_url, result_metadata, error_code, error_message, next_retry_at,
    created_at, updated_at, completed_at
FROM background_tasks;

DROP TABLE background_tasks;
ALTER TABLE background_tasks_v2 RENAME TO background_tasks;

CREATE INDEX background_tasks_user_created ON background_tasks(user_id, created_at DESC);
CREATE INDEX background_tasks_bookmark ON background_tasks(bookmark_id, type, created_at DESC);
CREATE INDEX background_tasks_status_retry ON background_tasks(status, next_retry_at);
