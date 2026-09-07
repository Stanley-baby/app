ALTER TABLE bookmarks ADD COLUMN cover TEXT NOT NULL DEFAULT '';

DROP TRIGGER IF EXISTS bookmarks_after_update;

CREATE TRIGGER bookmarks_after_update
AFTER UPDATE OF url, title, collection_id, tags, highlights, description, note, cover, removed_at, removed_batch, updated_at ON bookmarks
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

CREATE TABLE migration_mappings_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('collection', 'bookmark', 'content')),
    source_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('collection', 'bookmark', 'content')),
    resource_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('keep', 'skip')),
    created_at INTEGER NOT NULL,
    UNIQUE(archive_id, source_type, source_id),
    FOREIGN KEY (archive_id) REFERENCES migration_archives(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO migration_mappings_v3
    (id, archive_id, user_id, source_type, source_id, resource_type, resource_id, decision, created_at)
SELECT id, archive_id, user_id, source_type, source_id, resource_type, CAST(resource_id AS TEXT), decision, created_at
FROM migration_mappings;

DROP TABLE migration_mappings;
ALTER TABLE migration_mappings_v3 RENAME TO migration_mappings;

CREATE INDEX migration_mappings_archive ON migration_mappings(archive_id, source_type);
CREATE INDEX migration_mappings_user ON migration_mappings(user_id, source_type, source_id);
