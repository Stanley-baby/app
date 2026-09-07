CREATE TABLE connected_identities (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(provider, provider_subject),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX connected_identities_user ON connected_identities(user_id);

CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    user_id INTEGER,
    redirect_path TEXT NOT NULL,
    admission_granted INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE account_deletions (
    user_id INTEGER PRIMARY KEY,
    requested_at INTEGER NOT NULL,
    purge_after INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- This guard is intentionally limited to deletion. Issue #11 owns collaborator management.
CREATE TABLE collection_collaborators (
    collection_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
    PRIMARY KEY(collection_id, user_id),
    FOREIGN KEY (collection_id) REFERENCES collections(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

ALTER TABLE users ADD COLUMN federated_only INTEGER NOT NULL DEFAULT 0;
