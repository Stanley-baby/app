CREATE TABLE usage_counters (
    user_id INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    units INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, window_start),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE rate_limits (
    scope_key TEXT NOT NULL,
    route_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_key, route_key, window_start)
);

CREATE TABLE audit_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    route TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX usage_counters_user_window ON usage_counters(user_id, window_start);
CREATE INDEX rate_limits_window ON rate_limits(window_start);
CREATE INDEX audit_records_user_created ON audit_records(user_id, created_at);
CREATE INDEX alerts_user_created ON alerts(user_id, created_at);
