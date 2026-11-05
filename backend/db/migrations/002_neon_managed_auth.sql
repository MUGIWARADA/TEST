ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_subject TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_subject_unique_idx ON users(auth_subject) WHERE auth_subject IS NOT NULL;
