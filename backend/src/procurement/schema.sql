CREATE TABLE IF NOT EXISTS procurement_operations (
  operation_id uuid PRIMARY KEY,
  agreement_hash text NOT NULL REFERENCES agreement_records(agreement_hash),
  job_id text NOT NULL,
  requester text NOT NULL,
  chain_instance text NOT NULL,
  destination_hash text NOT NULL,
  kits numeric(78,0) NOT NULL CHECK (kits > 0),
  max_cred numeric(78,0) NOT NULL CHECK (max_cred > 0),
  deadline bigint NOT NULL,
  calldata text NOT NULL,
  call_binding text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','prepared','unknown','submitted','pending','confirming','reorganized','confirmed','reverted')),
  transaction_hash text,
  claim_id text,
  spent_cred numeric(78,0),
  receipt jsonb,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CHECK (spent_cred IS NULL OR (spent_cred > 0 AND spent_cred <= max_cred)),
  CHECK (status <> 'confirmed' OR (claim_id IS NOT NULL AND spent_cred IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS procurement_budget_job ON procurement_operations(agreement_hash);
