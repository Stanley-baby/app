CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    parent_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX collections_user ON collections(user_id);

ALTER TABLE bookmarks ADD COLUMN collection_id INTEGER NOT NULL DEFAULT -1;
ALTER TABLE bookmarks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bookmarks ADD COLUMN removed_at INTEGER;
