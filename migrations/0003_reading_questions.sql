-- Follow-up questions on readings. New table only: safe on a live database.
CREATE TABLE IF NOT EXISTS reading_questions (
  id serial PRIMARY KEY,
  reading_id integer NOT NULL,
  user_id text NOT NULL,
  question text NOT NULL,
  answer text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reading_questions_reading_idx ON reading_questions (reading_id, user_id);
