CREATE TABLE IF NOT EXISTS agreement_records (
  agreement_hash text PRIMARY KEY,
  job_id text NOT NULL,
  version numeric(78,0) NOT NULL,
  domain jsonb NOT NULL,
  terms jsonb NOT NULL,
  scope jsonb NOT NULL,
  allocations jsonb NOT NULL,
  required_signers jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','approved','funded','superseded')),
  created_at_ms bigint NOT NULL,
  funded_at_ms bigint,
  funding_evidence jsonb,
  UNIQUE(job_id,version)
);

CREATE TABLE IF NOT EXISTS agreement_approvals (
  agreement_hash text NOT NULL REFERENCES agreement_records(agreement_hash),
  signer text NOT NULL,
  signature text NOT NULL,
  approved_at_ms bigint NOT NULL,
  PRIMARY KEY(agreement_hash,signer)
);

CREATE OR REPLACE FUNCTION protect_funded_agreement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'funded' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'FUNDED_TERMS_IMMUTABLE';
    END IF;
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'FUNDED_TERMS_IMMUTABLE';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agreement_funded_immutability ON agreement_records;
CREATE TRIGGER agreement_funded_immutability BEFORE UPDATE OR DELETE ON agreement_records
FOR EACH ROW EXECUTE FUNCTION protect_funded_agreement();
