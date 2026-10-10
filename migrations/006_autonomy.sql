-- Autonomy level per audited action.
--
-- Makes an unattended or scoped run reviewable after the fact: without this,
-- a row recorded while Atlas was running unsupervised is indistinguishable from
-- one recorded while the user watched every prompt.
ALTER TABLE audit_log ADD COLUMN autonomy TEXT
  CHECK (autonomy IN ('confirm-everything', 'scoped-approval', 'unattended'));

-- Historic rows predate the setting, and were all written at the default level.
UPDATE audit_log SET autonomy = 'confirm-everything' WHERE autonomy IS NULL;

CREATE INDEX audit_log_autonomy_idx ON audit_log(autonomy, timestamp DESC);
