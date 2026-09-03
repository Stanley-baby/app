CREATE TABLE ai_providers (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
