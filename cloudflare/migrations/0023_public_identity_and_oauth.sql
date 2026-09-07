CREATE TABLE user_tfa (
    user_id INTEGER PRIMARY KEY,
    secret_encrypted TEXT NOT NULL,
    recovery_code_hash TEXT,
    recovery_used_at INTEGER,
    enabled_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE tfa_login_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    redirect_path TEXT NOT NULL DEFAULT '/',
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX tfa_login_challenges_active ON tfa_login_challenges(token_hash, used_at, expires_at);

CREATE TABLE developer_tokens (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX developer_tokens_user_created ON developer_tokens(user_id, created_at DESC);
CREATE INDEX developer_tokens_active ON developer_tokens(token_hash, revoked_at, expires_at);

CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    redirect_uris TEXT NOT NULL,
    client_secret_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX oauth_clients_user_created ON oauth_clients(user_id, created_at DESC);
CREATE INDEX oauth_clients_active ON oauth_clients(id, revoked_at);

CREATE TABLE oauth_authorization_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX oauth_authorization_codes_active ON oauth_authorization_codes(code_hash, client_id, used_at, expires_at);

CREATE TABLE oauth_access_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    scopes TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX oauth_access_tokens_active ON oauth_access_tokens(token_hash, revoked_at, expires_at);
CREATE INDEX oauth_access_tokens_user_client ON oauth_access_tokens(user_id, client_id, revoked_at);

CREATE TABLE oauth_refresh_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    scopes TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX oauth_refresh_tokens_active ON oauth_refresh_tokens(token_hash, revoked_at, expires_at);
