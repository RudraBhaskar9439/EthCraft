CREATE TABLE IF NOT EXISTS ac_human_provisioning (
  agreement_hash text PRIMARY KEY REFERENCES ac_human_demos(agreement_hash),
  chain_instance text NOT NULL,
  requester text NOT NULL,
  builder text NOT NULL,
  cred_amount numeric(78,0) NOT NULL CHECK(cred_amount BETWEEN 0 AND 9000000000000000000),
  builder_gas_wei numeric(78,0) NOT NULL CHECK(builder_gas_wei BETWEEN 0 AND 200000000000000),
  cred_operation uuid UNIQUE NOT NULL,
  gas_operation uuid UNIQUE NOT NULL,
  created_at_ms bigint NOT NULL
);
CREATE OR REPLACE FUNCTION protect_human_provisioning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'HUMAN_PROVISIONING_PLAN_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS human_provisioning_immutability ON ac_human_provisioning;
CREATE TRIGGER human_provisioning_immutability BEFORE UPDATE ON ac_human_provisioning
FOR EACH ROW EXECUTE FUNCTION protect_human_provisioning();
