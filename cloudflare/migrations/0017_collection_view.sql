ALTER TABLE collections ADD COLUMN view TEXT NOT NULL DEFAULT 'list' CHECK(view IN ('list', 'grid', 'masonry', 'simple'));
