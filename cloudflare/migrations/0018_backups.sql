CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('manual', 'daily', 'monthly')),
    period_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'succeeded', 'failed')),
    object_key TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX backups_period ON backups(user_id, kind, period_key);
CREATE INDEX backups_user_created ON backups(user_id, created_at DESC);
CREATE INDEX backups_retention ON backups(user_id, kind, status, created_at DESC);
