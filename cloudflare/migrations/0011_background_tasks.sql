CREATE TABLE background_tasks (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    bookmark_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('metadata_enrichment')),
    status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'retrying', 'succeeded', 'dead_letter')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
    retry_count INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE,
    source_url TEXT NOT NULL,
    result_metadata TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    error_message TEXT,
    next_retry_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id)
);

CREATE INDEX background_tasks_user_created ON background_tasks(user_id, created_at DESC);
CREATE INDEX background_tasks_bookmark ON background_tasks(bookmark_id, type, created_at DESC);
CREATE INDEX background_tasks_status_retry ON background_tasks(status, next_retry_at);
