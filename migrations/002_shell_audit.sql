ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'message'
  CHECK (message_type IN ('message', 'tool_call', 'tool_result'));
ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
ALTER TABLE messages ADD COLUMN tool_name TEXT;
ALTER TABLE messages ADD COLUMN tool_arguments TEXT;
ALTER TABLE messages ADD COLUMN is_error INTEGER;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  command TEXT NOT NULL,
  risk_tier INTEGER NOT NULL CHECK (risk_tier BETWEEN 0 AND 3),
  matched_rule TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'asked-approved', 'asked-denied', 'blocked')),
  outcome TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER
);

CREATE INDEX audit_log_timestamp_idx ON audit_log(timestamp DESC, id DESC);
CREATE INDEX audit_log_tier_timestamp_idx ON audit_log(risk_tier, timestamp DESC);
