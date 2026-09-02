CREATE TABLE ai_action_proposals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('update', 'delete')),
    bookmark_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'applied', 'rejected', 'failed')),
    result TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER
);

CREATE INDEX ai_action_proposals_user_status ON ai_action_proposals(user_id, status, updated_at DESC);
CREATE INDEX ai_action_proposals_bookmark ON ai_action_proposals(user_id, bookmark_id, updated_at DESC);

CREATE TABLE ai_standing_approvals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    collection_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revoked_at INTEGER,
    UNIQUE(user_id, tool_name, collection_id)
);

CREATE INDEX ai_standing_approvals_active ON ai_standing_approvals(user_id, revoked_at, tool_name, collection_id);
