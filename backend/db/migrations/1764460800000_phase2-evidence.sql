-- Up Migration

-- ---------------------------------------------------------------------------
-- Per-year counter behind evidence codes (EV-YYYY-NNNNNN). Updating the row
-- inside the registration transaction makes codes gap-free and unique.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_code_counters (
  year        INTEGER PRIMARY KEY CHECK (year BETWEEN 2000 AND 9999),
  last_value  INTEGER NOT NULL CHECK (last_value BETWEEN 1 AND 999999)
);

-- ---------------------------------------------------------------------------
-- evidence: one row per registered file. The file itself lives encrypted on
-- disk (storage_name); iv, auth_tag and key_id are needed to decrypt it.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evidence_code         TEXT   NOT NULL UNIQUE CHECK (evidence_code ~ '^EV-[0-9]{4}-[0-9]{6}$'),
  case_id               BIGINT NOT NULL REFERENCES cases (id),
  title                 TEXT   NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description           TEXT   CHECK (description IS NULL OR length(description) <= 5000),
  original_name         TEXT   NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime_type             TEXT   NOT NULL,
  size_bytes            BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256                TEXT   NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),             -- of the original file
  ciphertext_sha256     TEXT   NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),  -- of the stored file
  storage_name          TEXT   NOT NULL UNIQUE,
  key_id                TEXT   NOT NULL,
  iv                    BYTEA  NOT NULL CHECK (length(iv) = 12),
  auth_tag              BYTEA  NOT NULL CHECK (length(auth_tag) = 16),
  collection_metadata   JSONB  NOT NULL DEFAULT '{}'::jsonb,
  registered_by         BIGINT NOT NULL REFERENCES users (id),
  current_custodian_id  BIGINT NOT NULL REFERENCES users (id),
  integrity_status      TEXT   NOT NULL DEFAULT 'unverified'
                               CHECK (integrity_status IN ('unverified', 'verified', 'failed')),
  last_verified_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evidence_case_idx      ON evidence (case_id);
CREATE INDEX evidence_sha256_idx    ON evidence (sha256);
CREATE INDEX evidence_custodian_idx ON evidence (current_custodian_id);

ALTER TABLE alerts
  ADD CONSTRAINT alerts_evidence_fk FOREIGN KEY (evidence_id) REFERENCES evidence (id);

-- ---------------------------------------------------------------------------
-- Privileges for the API role. It may change only the integrity result and
-- the custodian; hashes, keys and file details are fixed once registered.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON evidence_code_counters TO ev_app;
GRANT SELECT, INSERT         ON evidence               TO ev_app;
GRANT UPDATE (integrity_status, last_verified_at, current_custodian_id) ON evidence TO ev_app;

-- Down Migration

ALTER TABLE alerts DROP CONSTRAINT alerts_evidence_fk;
DROP TABLE evidence;
DROP TABLE evidence_code_counters;
