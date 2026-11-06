CREATE TABLE IF NOT EXISTS ac_jobs (
  id uuid PRIMARY KEY, agreement_digest text NOT NULL, state text NOT NULL,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_inference_budgets (
  job_id uuid PRIMARY KEY REFERENCES ac_jobs(id), attempts integer NOT NULL DEFAULT 0,
  actions integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
  max_actions integer NOT NULL CHECK(max_actions BETWEEN 1 AND 20)
);
CREATE TABLE IF NOT EXISTS ac_inference_attempts (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES ac_jobs(id),
  status text NOT NULL DEFAULT 'reserved', result jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_decisions (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES ac_jobs(id), attempt_id uuid UNIQUE NOT NULL REFERENCES ac_inference_attempts(id),
  proposal jsonb NOT NULL, binding jsonb NOT NULL, status text NOT NULL DEFAULT 'proposed',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_outbox (
  operation_id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES ac_jobs(id),
  topic text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
  lease_owner text, lease_epoch bigint NOT NULL DEFAULT 0, lease_until timestamptz,
  receipt jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
