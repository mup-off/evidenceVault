-- Up Migration

-- ---------------------------------------------------------------------------
-- users: accounts and roles
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name      TEXT        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
  email          TEXT        NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash  TEXT        NOT NULL,
  role           TEXT        NOT NULL CHECK (role IN ('administrator', 'investigator', 'custodian', 'auditor')),
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  failed_logins  INTEGER     NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until   TIMESTAMPTZ,
  -- Bumped on deactivation or password reset, so older tokens stop working.
  token_version  INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- cases: investigations that group evidence
-- ---------------------------------------------------------------------------
CREATE TABLE cases (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_number  TEXT        NOT NULL UNIQUE CHECK (length(btrim(case_number)) BETWEEN 1 AND 50),
  title        TEXT        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description  TEXT        CHECK (description IS NULL OR length(description) <= 5000),
  status       TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by   BIGINT      NOT NULL REFERENCES users (id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX cases_created_by_idx ON cases (created_by);

-- ---------------------------------------------------------------------------
-- case_members: which investigators may access which case
-- ---------------------------------------------------------------------------
CREATE TABLE case_members (
  case_id   BIGINT      NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  user_id   BIGINT      NOT NULL REFERENCES users (id),
  added_by  BIGINT      NOT NULL REFERENCES users (id),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, user_id)
);
CREATE INDEX case_members_user_idx ON case_members (user_id);

-- ---------------------------------------------------------------------------
-- audit_log: append-only record of every action
-- ts is stored to the millisecond so the value read back always reproduces
-- the hash computed at write time (JavaScript dates carry milliseconds).
-- Phase 3 adds the UPDATE/DELETE/TRUNCATE triggers and chain verification.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          TIMESTAMPTZ(3) NOT NULL,
  user_id     BIGINT REFERENCES users (id),
  action      TEXT  NOT NULL CHECK (action ~ '^[A-Z][A-Z_]*$'),
  entity      TEXT,
  entity_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  prev_hash   TEXT  NOT NULL CHECK (prev_hash  ~ '^[0-9a-f]{64}$'),
  entry_hash  TEXT  NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_user_idx   ON audit_log (user_id);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

-- ---------------------------------------------------------------------------
-- alerts: security events for administrators
-- evidence_id gets its foreign key in Phase 2, when the evidence table exists.
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity         TEXT    NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  type             TEXT    NOT NULL CHECK (type ~ '^[A-Z][A-Z_]*$'),
  message          TEXT    NOT NULL,
  user_id          BIGINT  REFERENCES users (id),
  evidence_id      BIGINT,
  acknowledged     BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by  BIGINT  REFERENCES users (id),
  acknowledged_at  TIMESTAMPTZ,
  CHECK (acknowledged = (acknowledged_at IS NOT NULL))
);
CREATE INDEX alerts_open_idx ON alerts (acknowledged, created_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges for the API role (ev_app). It never owns anything.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON users        TO ev_app;
GRANT SELECT, INSERT, UPDATE         ON cases        TO ev_app;
GRANT SELECT, INSERT, DELETE         ON case_members TO ev_app;
GRANT SELECT, INSERT                 ON audit_log    TO ev_app;
GRANT SELECT, INSERT                 ON alerts       TO ev_app;
GRANT UPDATE (acknowledged, acknowledged_by, acknowledged_at) ON alerts TO ev_app;

-- Down Migration

DROP TABLE alerts;
DROP TABLE audit_log;
DROP TABLE case_members;
DROP TABLE cases;
DROP TABLE users;
