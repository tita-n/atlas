-- Phase 4: standing corrections learned from user feedback.
--
-- These are context-injected instructions, not model training. Each row is a
-- durable rule the assistant must follow when relevant, so a mistake corrected
-- in one session is not repeated in the next.

CREATE TABLE IF NOT EXISTS assistant_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  -- The standing instruction, phrased for the assistant ("never do X").
  instruction TEXT NOT NULL,
  -- Space-separated terms used to decide whether it is relevant to a turn.
  trigger_terms TEXT NOT NULL,
  -- Optional message that caused the correction, for provenance.
  source_message_id INTEGER,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS assistant_corrections_created_at_idx
  ON assistant_corrections (created_at, id);
