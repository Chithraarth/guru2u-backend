-- 1-100% judgment of the person read. Additive and nullable: safe on a live database.
ALTER TABLE readings ADD COLUMN IF NOT EXISTS judgment jsonb;
