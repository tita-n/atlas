-- Audit log v4: the fail-closed degraded state needs its own vocabulary.
--
-- v3 taught the audit row to record isolation, and gave `gate_path` enough
-- words to say what really decided. Two values were still missing, both for
-- the state this stage introduces:
--
--   * `sandbox_backend = 'refusing'` - no sandbox is available, so Atlas
--     refuses to run an arbitrary command on the host. Before this, that
--     situation was indistinguishable from a deliberate full-access session
--     (`'local'`), which is the exact confusion the row exists to prevent.
--   * `gate_path = 'refused-degraded'` - the command was refused because there
--     was no sandbox and it was not provably read-only. That is neither
--     `hard-block` (a configuration refusal) nor `denied-hard-floor` (the
--     unconditional floor), and recording it as either would misattribute the
--     decision.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt and every row
-- is copied across verbatim. Nothing is discarded and no historical value is
-- rewritten: a row that already says `local` cannot be told apart from a real
-- full-access row after the fact, and guessing would corrupt the record. The
-- vocabulary is widened for the future; history is left exactly as written.

CREATE TABLE audit_log_v4 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,

  event_kind TEXT NOT NULL DEFAULT 'command'
    CHECK (event_kind IN ('command', 'self-modification')),

  command TEXT NOT NULL,
  summary TEXT,

  gate_path TEXT
    CHECK (gate_path IN (
      'text-safe-word', 'voice-paired', 'hard-block', 'denied-hard-floor',
      'denied-by-user', 'auto-allow', 'auto-allow-sandboxed',
      'escalated-out-of-sandbox', 'refused-degraded'
    )),

  autonomy TEXT
    CHECK (autonomy IS NULL OR autonomy IN (
      'confirm-everything', 'scoped-approval', 'unattended'
    )),

  sandbox_backend TEXT
    CHECK (sandbox_backend IS NULL OR sandbox_backend IN ('local', 'bwrap', 'refusing')),
  sandbox_profile TEXT
    CHECK (sandbox_profile IS NULL OR sandbox_profile IN ('read-only', 'workspace-write', 'full-access')),
  sandbox_writable_roots TEXT,   -- JSON array
  sandbox_network INTEGER CHECK (sandbox_network IS NULL OR sandbox_network IN (0, 1)),
  escalated INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0, 1)),

  risk_tier INTEGER NOT NULL CHECK (risk_tier BETWEEN 0 AND 3),
  matched_rule TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('allowed', 'asked-approved', 'asked-denied', 'blocked', 'previewed')),
  outcome TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER
);

INSERT INTO audit_log_v4
  (id, timestamp, event_kind, command, summary, gate_path, autonomy,
   sandbox_backend, sandbox_profile, sandbox_writable_roots,
   sandbox_network, escalated,
   risk_tier, matched_rule, decision, outcome, exit_code, duration_ms)
SELECT
  id, timestamp, event_kind, command, summary, gate_path, autonomy,
  sandbox_backend, sandbox_profile, sandbox_writable_roots,
  sandbox_network, escalated,
  risk_tier, matched_rule, decision, outcome, exit_code, duration_ms
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v4 RENAME TO audit_log;

CREATE INDEX audit_log_timestamp_idx ON audit_log(timestamp DESC, id DESC);
CREATE INDEX audit_log_tier_timestamp_idx ON audit_log(risk_tier, timestamp DESC);
CREATE INDEX audit_log_gate_path_idx ON audit_log(gate_path, timestamp DESC);
CREATE INDEX audit_log_outcome_idx ON audit_log(outcome, timestamp DESC);
CREATE INDEX audit_log_escalated_idx ON audit_log(escalated, timestamp DESC);
CREATE INDEX audit_log_autonomy_idx ON audit_log(autonomy, timestamp DESC);
