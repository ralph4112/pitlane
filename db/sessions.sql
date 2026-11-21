CREATE TABLE IF NOT EXISTS garage.user_sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id bigint NOT NULL REFERENCES garage.users,
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON garage.user_sessions (expires_at);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON garage.user_sessions (user_id);
