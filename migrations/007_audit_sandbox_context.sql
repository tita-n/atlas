-- Audit log v3: what the SANDBOX was doing, and which path really decided.
--
-- Two problems with v2, both of which make a post-hoc review lie:
--
--   1. The row recorded nothing about isolation. A command auto-allowed
--      because it was harmless, and a command auto-allowed because the
--      sandbox made destruction impossible, are indistinguishable in the
--      log - and the second is exactly the interesting one.
--   2. `gate_path` was written from a per-session constant derived from
--      ATLAS_TEXT_CONFIRM_MODE, so every row in a session claimed the same
--      path regardless of what actually happened. The column existed to be
--      truthful and was not.
--
-- So: record the isolation context on every row, and extend the gate-path
-- vocabulary to describe what really occurred. `denied-hard-floor` and
-- `escalated-out-of-sandbox` are the two that were previously
-- indistinguishable from an ordinary approval.
--
-- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt
-- and every existing row is copied across. Nothing is discarded: this is a
-- safety record, and dropping history to add columns to it would be exactly
-- backwards.

CREATE TABLE audit_log_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,

  event_kind TEXT NOT NULL DEFAULT 'command'
    CHECK (event_kind IN ('command', 'self-modification')),

  command TEXT NOT NULL,
  summary TEXT,

  -- Which path really decided this row.
  --   text-safe-word            the interim path: typed safe word, no voice
  --   voice-paired              the original design, once voice resumes
  --   hard-block                ATLAS_TEXT_CONFIRM_MODE=block refused it
  --   denied-hard-floor         the unconditional floor refused it, whatever
  --                             the classifier or a grant said
  --   denied-by-user            a human was asked to widen the sandbox and
  --                             declined; NOT a floor violation
  --   auto-allow                permitted without asking
  --   auto-allow-sandboxed      permitted without asking AND confined: the
  --                             blast radius was the sandbox, not the gate
  --   escalated-out-of-sandbox  an explicit grant ran it outside the sandbox
  gate_path TEXT
    CHECK (gate_path IN (
      'text-safe-word', 'voice-paired', 'hard-block', 'denied-hard-floor',
      'denied-by-user', 'auto-allow', 'auto-allow-sandboxed',
      'escalated-out-of-sandbox'
    )),

  autonomy TEXT
    CHECK (autonomy IS NULL OR autonomy IN (
      'confirm-everything', 'scoped-approval', 'unattended'
    )),

  -- Isolation in force when this row was written.
  sandbox_backend TEXT CHECK (sandbox_backend IS NULL OR sandbox_backend IN ('local', 'bwrap')),
  sandbox_profile TEXT
    CHECK (sandbox_profile IS NULL OR sandbox_profile IN ('read-only', 'workspace-write', 'full-access')),
  sandbox_writable_roots TEXT,   -- JSON array
  sandbox_network INTEGER CHECK (sandbox_network IS NULL OR sandbox_network IN (0, 1)),
  -- True when this row's command ran outside the sandbox the profile implies.
  escalated INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0, 1)),

  risk_tier INTEGER NOT NULL CHECK (risk_tier BETWEEN 0 AND 3),
  matched_rule TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('allowed', 'asked-approved', 'asked-denied', 'blocked', 'previewed')),
  outcome TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER
);

INSERT INTO audit_log_v3
  (id, timestamp, event_kind, command, summary, gate_path, autonomy,
   sandbox_backend, sandbox_profile, sandbox_writable_roots,
   sandbox_network, escalated,
   risk_tier, matched_rule, decision, outcome, exit_code, duration_ms)
SELECT
  id,
  timestamp,
  event_kind,
  command,
  summary,
  -- v2 could not distinguish a floor denial from a mode-level refusal, so
  -- every existing value is carried across unchanged. That under-claims rather
  -- than over-claims, which is the right direction for a safety record: a
  -- reviewer seeing 'hard-block' where a floor denial happened will go and
  -- check, and one seeing a floor denial recorded as a config refusal will not.
  gate_path,
  autonomy,
  -- Isolation context was not recorded before v3. NULL means "not known",
  -- which is the truth; back-filling "local" would be a guess.
  NULL, NULL, NULL, NULL,
  0,
  risk_tier,
  matched_rule,
  decision,
  outcome,
  exit_code,
  duration_ms
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v3 RENAME TO audit_log;

CREATE INDEX audit_log_timestamp_idx ON audit_log(timestamp DESC, id DESC);
CREATE INDEX audit_log_tier_timestamp_idx ON audit_log(risk_tier, timestamp DESC);
CREATE INDEX audit_log_gate_path_idx ON audit_log(gate_path, timestamp DESC);
CREATE INDEX audit_log_outcome_idx ON audit_log(outcome, timestamp DESC);
CREATE INDEX audit_log_escalated_idx ON audit_log(escalated, timestamp DESC);
-- Recreated because DROP TABLE takes every index on the table with it, and
-- 006's autonomy index is a supported query filter (`AuditQuery.autonomy`).
-- Losing it turns "rows at autonomy X" into a full scan of a table that grows
-- without bound.
CREATE INDEX audit_log_autonomy_idx ON audit_log(autonomy, timestamp DESC);
