ALTER TABLE bookmarks ADD COLUMN change_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE bookmark_changes (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    bookmark_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('create', 'update', 'remove')),
    changed_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id)
);

CREATE INDEX bookmark_changes_user_version ON bookmark_changes(user_id, version);

CREATE TRIGGER bookmarks_after_insert
AFTER INSERT ON bookmarks
BEGIN
    INSERT INTO bookmark_changes (user_id, bookmark_id, action, changed_at)
    VALUES (NEW.user_id, NEW.id, 'create', NEW.updated_at);
    UPDATE bookmarks
    SET change_version = last_insert_rowid()
    WHERE id = NEW.id;
END;

CREATE TRIGGER bookmarks_after_update
AFTER UPDATE OF url, title, collection_id, tags, removed_at, updated_at ON bookmarks
WHEN NEW.change_version = OLD.change_version
BEGIN
    INSERT INTO bookmark_changes (user_id, bookmark_id, action, changed_at)
    VALUES (
        NEW.user_id,
        NEW.id,
        CASE WHEN NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN 'remove' ELSE 'update' END,
        NEW.updated_at
    );
    UPDATE bookmarks
    SET change_version = last_insert_rowid()
    WHERE id = NEW.id;
END;
