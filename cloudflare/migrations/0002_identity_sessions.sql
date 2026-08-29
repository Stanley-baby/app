CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    email_verified_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX sessions_user_active ON sessions(user_id, revoked_at, expires_at);

CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX bookmarks_user_created ON bookmarks(user_id, created_at DESC);
