-- Up Migration

-- ---------------------------------------------------------------------------
-- custody_transfers: requests to hand evidence to another person. The
-- recipient must accept before the custodian changes. At most one pending
-- transfer per item (partial unique index), so two transfers of the same item
-- can never both be accepted.
-- ---------------------------------------------------------------------------
CREATE TABLE custody_transfers (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evidence_id    BIGINT      NOT NULL REFERENCES evidence (id),
  from_user_id   BIGINT      NOT NULL REFERENCES users (id),   -- custodian when requested
  to_user_id     BIGINT      NOT NULL REFERENCES users (id),
  requested_by   BIGINT      NOT NULL REFERENCES users (id),   -- differs from from_user_id for admin reassignment
  reason         TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by     BIGINT      REFERENCES users (id),
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT        CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  CHECK (from_user_id <> to_user_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by IS NULL))
);
CREATE UNIQUE INDEX custody_transfers_one_pending_idx ON custody_transfers (evidence_id) WHERE status = 'pending';
CREATE INDEX custody_transfers_evidence_idx ON custody_transfers (evidence_id, requested_at);
CREATE INDEX custody_transfers_to_idx       ON custody_transfers (to_user_id, status);
CREATE INDEX custody_transfers_from_idx     ON custody_transfers (from_user_id, status);

-- A decided transfer is final; a pending one may only change its decision fields.
CREATE FUNCTION custody_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'custody transfers cannot be deleted';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'custody transfer % is already %; it cannot change', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_transfers_guard
  BEFORE UPDATE OR DELETE ON custody_transfers
  FOR EACH ROW EXECUTE FUNCTION custody_transfer_guard();

-- ---------------------------------------------------------------------------
-- audit_anchors: chain heads recorded by reports and successful chain checks.
-- Each row is HMAC-signed with the audit key. The chain check requires every
-- anchored entry to still exist with the same hash, so deleting the newest
-- entries is detected. There is deliberately no foreign key to audit_log.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_anchors (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anchored_at  TIMESTAMPTZ(3) NOT NULL,
  head_seq     BIGINT NOT NULL CHECK (head_seq > 0),
  head_hash    TEXT   NOT NULL CHECK (head_hash   ~ '^[0-9a-f]{64}$'),
  reason       TEXT   NOT NULL CHECK (reason ~ '^[a-z][a-z_]*$'),
  anchor_hash  TEXT   NOT NULL CHECK (anchor_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_anchors_seq_idx ON audit_anchors (head_seq);

-- ---------------------------------------------------------------------------
-- Append-only enforcement for audit_log and audit_anchors: row triggers
-- reject UPDATE and DELETE, a statement trigger rejects TRUNCATE. These hold
-- for every role, including the owner, unless the triggers are disabled.
-- ---------------------------------------------------------------------------
CREATE FUNCTION reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

CREATE TRIGGER audit_anchors_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_anchors
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER audit_anchors_no_truncate
  BEFORE TRUNCATE ON audit_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- ---------------------------------------------------------------------------
-- Privileges for the API role.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON custody_transfers TO ev_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON custody_transfers TO ev_app;
GRANT SELECT, INSERT ON audit_anchors TO ev_app;
-- Re-stated for clarity: on audit_log the app role has only SELECT and INSERT.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ev_app;

-- Down Migration

DROP TRIGGER audit_anchors_no_truncate      ON audit_anchors;
DROP TRIGGER audit_anchors_no_update_delete ON audit_anchors;
DROP TRIGGER audit_log_no_truncate          ON audit_log;
DROP TRIGGER audit_log_no_update_delete     ON audit_log;
DROP FUNCTION reject_append_only_change();
DROP TABLE audit_anchors;
DROP TABLE custody_transfers;
DROP FUNCTION custody_transfer_guard();
