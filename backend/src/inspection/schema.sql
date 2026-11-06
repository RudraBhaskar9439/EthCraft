CREATE TABLE IF NOT EXISTS ac_synthetic_worlds (
  job_id uuid PRIMARY KEY REFERENCES ac_jobs(id), destination_hash text NOT NULL,
  revision bigint NOT NULL DEFAULT 0, placed_items jsonb NOT NULL DEFAULT '{}',
  lock_hash text, valid_until bigint, pending_acceptance uuid, report jsonb,
  build_operation uuid UNIQUE
);
