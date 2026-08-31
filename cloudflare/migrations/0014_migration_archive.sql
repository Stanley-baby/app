CREATE TABLE migration_archives (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'archive',
    archive_json TEXT NOT NULL,
    preflight_json TEXT NOT NULL DEFAULT '{}',
    review_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK(status IN ('review', 'queued', 'processing', 'retrying', 'succeeded', 'dead_letter')),
    collection_count INTEGER NOT NULL DEFAULT 0,
    bookmark_count INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    completed_items INTEGER NOT NULL DEFAULT 0,
    task_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX migration_archives_user_created ON migration_archives(user_id, created_at DESC);
CREATE INDEX migration_archives_task ON migration_archives(task_id);

CREATE TABLE migration_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('collection', 'bookmark')),
    source_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('collection', 'bookmark')),
    resource_id INTEGER NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('keep', 'skip')),
    created_at INTEGER NOT NULL,
    UNIQUE(archive_id, source_type, source_id),
    FOREIGN KEY (archive_id) REFERENCES migration_archives(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX migration_mappings_archive ON migration_mappings(archive_id, source_type);
CREATE INDEX migration_mappings_user ON migration_mappings(user_id, source_type, source_id);

CREATE TABLE background_tasks_v3 (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    bookmark_id INTEGER,
    type TEXT NOT NULL CHECK(type IN ('metadata_enrichment', 'attachment_scan', 'capture', 'migration_import')),
    status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'retrying', 'succeeded', 'dead_letter')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
    retry_count INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE,
    source_url TEXT NOT NULL DEFAULT '',
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

INSERT INTO background_tasks_v3 (
    id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key,
    source_url, content_id, payload, result_metadata, error_code, error_message,
    next_retry_at, created_at, updated_at, completed_at
)
SELECT id, user_id, bookmark_id, type, status, progress, retry_count, idempotency_key,
    source_url, content_id, payload, result_metadata, error_code, error_message,
    next_retry_at, created_at, updated_at, completed_at
FROM background_tasks;

DROP TABLE background_tasks;
ALTER TABLE background_tasks_v3 RENAME TO background_tasks;

CREATE INDEX background_tasks_user_created ON background_tasks(user_id, created_at DESC);
CREATE INDEX background_tasks_bookmark ON background_tasks(bookmark_id, type, created_at DESC);
CREATE INDEX background_tasks_status_retry ON background_tasks(status, next_retry_at);
