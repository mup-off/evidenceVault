#!/bin/sh
# Runs once, on the first start of the PostgreSQL container.
# Creates two login roles and two databases:
#   ev_owner - owns the databases and runs migrations
#   ev_app   - used by the API; gets only the privileges the migrations grant it
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  CREATE ROLE ev_owner LOGIN PASSWORD '${EV_OWNER_PASSWORD}';
  CREATE ROLE ev_app   LOGIN PASSWORD '${EV_APP_PASSWORD}';

  CREATE DATABASE evidencevault      OWNER ev_owner;
  CREATE DATABASE evidencevault_test OWNER ev_owner;

  REVOKE ALL ON DATABASE evidencevault      FROM PUBLIC;
  REVOKE ALL ON DATABASE evidencevault_test FROM PUBLIC;
  GRANT CONNECT ON DATABASE evidencevault      TO ev_app;
  GRANT CONNECT ON DATABASE evidencevault_test TO ev_app;
EOSQL

for db in evidencevault evidencevault_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
    -- Only the owner may create objects; the app role may only use them.
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    ALTER SCHEMA public OWNER TO ev_owner;
    GRANT USAGE ON SCHEMA public TO ev_app;
EOSQL
done
