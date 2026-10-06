-- Audit log v2.
--
-- The original table could not express three things this phase needs:
--
--   1. WHICH gate path approved a dangerous action. While voice is paused the
--      gate runs on the weaker typed-safe-word path; recording that makes the
--      interim period visible and accountable instead of invisible.
--   2. Non-command events. Self-modification is not built yet, but the schema
--      accommodates it now so that phase needs no migration.
--   3. Previews. A dry run is recorded as its own outcome, distinct from an
--      execution that happened.
--
-- SQLite cannot alter a CHECK constraint, so the table is recreated and the
-- existing rows are copied across. Nothing is discarded: this is a safety
-- record and losing history to add columns to it would be exactly backwards.

CREATE TABLE audit_log_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,

  -- What kind of thing happened, so self-modification can be recorded later
  -- without another migration.
  event_kind TEXT NOT NULL DEFAULT 'command'
    CHECK (event_kind IN ('command', 'self-modification')),

  -- What the actor asked for, verbatim.
  command TEXT NOT NULL,

  -- Plain-language description, so the record is reviewable by a human.
  summary TEXT,

  -- Which permission path produced the decision.
  --   text-safe-word   the interim path: typed safe word alone, no voice pairing
  --   voice-paired     the original design, once voice resumes
  --   hard-block       ATLAS_TEXT_CONFIRM_MODE=block refused it
  --   auto-allow       permitted without asking
  gate_path TEXT
    CHECK (gate_path IN ('text-safe-word', 'voice-paired', 'hard-block', 'auto-allow')),

  risk_tier INTEGER NOT NULL CHECK (risk_tier BETWEEN 0 AND 3),
  matched_rule TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('allowed', 'asked-approved', 'asked-denied', 'blocked', 'previewed')),

  -- succeeded | failed | denied | previewed-only
  outcome TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER
);

INSERT INTO audit_log_v2
  (id, timestamp, event_kind, command, summary, gate_path,
   risk_tier, matched_rule, decision, outcome, exit_code, duration_ms)
SELECT
  id,
  timestamp,
  'command',
  command,
  NULL,
  -- Historic rows predate gate-path tracking. Rows that were asked about are
  -- attributed to the interim text path, which is what was actually running;
  -- rows that were simply allowed are left unattributed rather than guessed.
  CASE
    WHEN decision = 'asked-approved' THEN 'text-safe-word'
    WHEN decision = 'asked-denied' THEN 'text-safe-word'
    WHEN decision = 'blocked' THEN 'hard-block'
    ELSE NULL
  END,
  risk_tier,
  matched_rule,
  decision,
  outcome,
  exit_code,
  duration_ms
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v2 RENAME TO audit_log;

CREATE INDEX audit_log_timestamp_idx ON audit_log(timestamp DESC, id DESC);
CREATE INDEX audit_log_tier_timestamp_idx ON audit_log(risk_tier, timestamp DESC);
CREATE INDEX audit_log_gate_path_idx ON audit_log(gate_path, timestamp DESC);
CREATE INDEX audit_log_outcome_idx ON audit_log(outcome, timestamp DESC);