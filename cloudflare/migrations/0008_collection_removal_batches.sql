ALTER TABLE collections ADD COLUMN removed_batch TEXT;

UPDATE collections
SET removed_batch = lower(hex(randomblob(16)))
WHERE removed_at IS NOT NULL;

CREATE INDEX collections_removed_batch ON collections(user_id, removed_batch);
