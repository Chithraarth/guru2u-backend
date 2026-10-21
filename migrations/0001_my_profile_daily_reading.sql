-- Your details (profile) + personal daily reading + "you and them".
-- Additive and nullable only: safe to run on a live database.
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_time text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_place text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS self_face_profile text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS self_palm_profile text;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS daily jsonb;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS compatibility text;
