-- Phase 3: voice correction log.
--
-- This table only accumulates data for later personalization phases. Nothing in
-- Phase 3 reads these rows back to adapt behaviour. Audio is referenced by
-- path so biometric-adjacent recordings are never inlined in the database.

CREATE TABLE IF NOT EXISTS voice_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  heard_transcript TEXT NOT NULL,
  corrected_transcript TEXT,
  audio_reference TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE SET NULL
);

-- Newest-entry lookups dominate: the pipeline asks for the latest
-- uncorrected row on every utterance, and `atlas voice corrections` lists
-- recent entries.
CREATE INDEX IF NOT EXISTS idx_voice_corrections_recent
  ON voice_corrections (id DESC);

CREATE INDEX IF NOT EXISTS idx_voice_corrections_uncorrected
  ON voice_corrections (id DESC)
  WHERE corrected_transcript IS NULL;

CREATE INDEX IF NOT EXISTS idx_voice_corrections_conversation
  ON voice_corrections (conversation_id);
