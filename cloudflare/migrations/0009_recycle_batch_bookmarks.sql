ALTER TABLE bookmarks ADD COLUMN removed_batch TEXT;

UPDATE collections
SET removed_batch = CAST(removed_at AS TEXT)
WHERE removed_at IS NOT NULL;

UPDATE bookmarks
SET removed_batch = CAST(removed_at AS TEXT)
WHERE removed_at IS NOT NULL;

CREATE INDEX bookmarks_removed_batch ON bookmarks(user_id, removed_batch);

DROP TRIGGER IF EXISTS bookmarks_after_update;

CREATE TRIGGER bookmarks_after_update
AFTER UPDATE OF url, title, collection_id, tags, highlights, description, note, removed_at, removed_batch, updated_at ON bookmarks
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
