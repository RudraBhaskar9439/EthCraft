CREATE TABLE IF NOT EXISTS ac_human_demos (
  agreement_hash text PRIMARY KEY REFERENCES agreement_records(agreement_hash),
  job_id uuid UNIQUE NOT NULL REFERENCES ac_jobs(id),
  chain_instance text NOT NULL,
  identity_server_id text NOT NULL,
  identities jsonb NOT NULL,
  operation_ids jsonb NOT NULL,
  quote jsonb,
  inspection jsonb,
  created_at_ms bigint NOT NULL
);

CREATE OR REPLACE FUNCTION protect_human_demo_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agreement_hash IS DISTINCT FROM OLD.agreement_hash OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.chain_instance IS DISTINCT FROM OLD.chain_instance OR NEW.identity_server_id IS DISTINCT FROM OLD.identity_server_id
    OR NEW.identities IS DISTINCT FROM OLD.identities OR NEW.operation_ids IS DISTINCT FROM OLD.operation_ids
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms
    OR (OLD.quote IS NOT NULL AND NEW.quote IS DISTINCT FROM OLD.quote)
    OR (OLD.inspection IS NOT NULL AND NEW.inspection IS DISTINCT FROM OLD.inspection) THEN
    RAISE EXCEPTION 'HUMAN_DEMO_BINDING_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS human_demo_binding_immutability ON ac_human_demos;
CREATE TRIGGER human_demo_binding_immutability BEFORE UPDATE ON ac_human_demos
FOR EACH ROW EXECUTE FUNCTION protect_human_demo_binding();

CREATE OR REPLACE FUNCTION protect_pinned_human_agreement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ac_human_demos WHERE agreement_hash=OLD.agreement_hash) AND
    (NEW.domain IS DISTINCT FROM OLD.domain OR NEW.terms IS DISTINCT FROM OLD.terms
      OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.allocations IS DISTINCT FROM OLD.allocations
      OR NEW.required_signers IS DISTINCT FROM OLD.required_signers OR NEW.state='superseded') THEN
    RAISE EXCEPTION 'PINNED_HUMAN_AGREEMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS human_agreement_immutability ON agreement_records;
CREATE TRIGGER human_agreement_immutability BEFORE UPDATE ON agreement_records
FOR EACH ROW EXECUTE FUNCTION protect_pinned_human_agreement();
