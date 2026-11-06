CREATE TABLE IF NOT EXISTS ac_synthetic_stock (
  manifest_hash text PRIMARY KEY, items jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ac_synthetic_destinations (
  destination_hash text PRIMARY KEY, recipient text NOT NULL, items jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS ac_delivery_receipts (
  claim_key text PRIMARY KEY, operation_id uuid UNIQUE NOT NULL,
  job_id uuid NOT NULL REFERENCES ac_jobs(id), recipient text NOT NULL,
  destination_hash text NOT NULL, quantities jsonb NOT NULL, receipt_hash text NOT NULL,
  source_block_hash text NOT NULL, delivered_at timestamptz NOT NULL DEFAULT now()
);
