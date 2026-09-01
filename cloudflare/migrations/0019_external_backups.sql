CREATE TABLE backup_connections (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('gdrive', 'onedrive', 'webdav')),
    encrypted_credentials TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    verified_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, provider)
);

CREATE UNIQUE INDEX backup_connections_default ON backup_connections(user_id) WHERE is_default = 1;

CREATE TABLE external_backup_copies (
    backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES backup_connections(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed')),
    remote_path TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY(backup_id, connection_id)
);
