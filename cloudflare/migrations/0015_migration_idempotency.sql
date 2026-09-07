ALTER TABLE collections ADD COLUMN migration_key TEXT;
ALTER TABLE bookmarks ADD COLUMN migration_key TEXT;
ALTER TABLE content_objects ADD COLUMN migration_key TEXT;
ALTER TABLE migration_archives ADD COLUMN asset_count INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX collections_migration_key ON collections(user_id, migration_key)
WHERE migration_key IS NOT NULL;
CREATE UNIQUE INDEX bookmarks_migration_key ON bookmarks(user_id, migration_key)
WHERE migration_key IS NOT NULL;
CREATE UNIQUE INDEX content_objects_migration_key ON content_objects(user_id, migration_key)
WHERE migration_key IS NOT NULL;

CREATE TABLE migration_mappings_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('collection', 'bookmark', 'content')),
    source_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('collection', 'bookmark', 'content')),
    resource_id INTEGER NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('keep', 'skip')),
    created_at INTEGER NOT NULL,
    UNIQUE(archive_id, source_type, source_id),
    FOREIGN KEY (archive_id) REFERENCES migration_archives(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO migration_mappings_v2
    (id, archive_id, user_id, source_type, source_id, resource_type, resource_id, decision, created_at)
SELECT id, archive_id, user_id, source_type, source_id, resource_type, resource_id, decision, created_at
FROM migration_mappings;

DROP TABLE migration_mappings;
ALTER TABLE migration_mappings_v2 RENAME TO migration_mappings;

CREATE INDEX migration_mappings_archive ON migration_mappings(archive_id, source_type);
CREATE INDEX migration_mappings_user ON migration_mappings(user_id, source_type, source_id);
