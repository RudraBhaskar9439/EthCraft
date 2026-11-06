CREATE TABLE IF NOT EXISTS discovery_records (
  namespace text NOT NULL,
  entity_key text NOT NULL,
  record_id text NOT NULL,
  version bigint NOT NULL,
  owner text NOT NULL,
  kind text NOT NULL,
  job_id text NOT NULL,
  digest text NOT NULL,
  envelope jsonb NOT NULL,
  expires_at_ms bigint NOT NULL,
  withdrawn boolean NOT NULL,
  PRIMARY KEY(namespace,entity_key),
  UNIQUE(namespace,record_id,version)
);
CREATE TABLE IF NOT EXISTS discovery_heads (
  namespace text NOT NULL,
  record_id text NOT NULL,
  version bigint NOT NULL,
  owner text NOT NULL,
  kind text NOT NULL,
  job_id text NOT NULL,
  digest text NOT NULL,
  entity_key text NOT NULL,
  expires_at_ms bigint NOT NULL,
  withdrawn boolean NOT NULL,
  PRIMARY KEY(namespace,record_id)
);
CREATE TABLE IF NOT EXISTS discovery_fixture_entities (
  entity_key text PRIMARY KEY,
  owner text NOT NULL,
  envelope jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_publications (
  digest text PRIMARY KEY, operation_id uuid UNIQUE NOT NULL, owner text NOT NULL,
  envelope jsonb NOT NULL, entity_key text, transaction_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
