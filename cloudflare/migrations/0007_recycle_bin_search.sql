ALTER TABLE bookmarks ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE bookmarks ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE collections ADD COLUMN removed_at INTEGER;

CREATE INDEX bookmarks_user_removed_updated ON bookmarks(user_id, removed_at, updated_at);
CREATE INDEX collections_user_removed ON collections(user_id, removed_at);

DROP TRIGGER IF EXISTS bookmarks_after_update;

CREATE TRIGGER bookmarks_after_update
AFTER UPDATE OF url, title, collection_id, tags, highlights, description, note, removed_at, updated_at ON bookmarks
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
