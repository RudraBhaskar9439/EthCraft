CREATE TABLE IF NOT EXISTS external_wallet_intents (
  operation_id uuid PRIMARY KEY,
  chain_instance text NOT NULL,
  agreement_hash text NOT NULL REFERENCES agreement_records(agreement_hash),
  action text NOT NULL CHECK (action IN ('approve_escrow','fund','approve_procurement','buy','accept','claim','refund')),
  sender text NOT NULL,
  nonce bigint NOT NULL CHECK (nonce >= 0),
  destination text NOT NULL,
  calldata text NOT NULL,
  value numeric(78,0) NOT NULL DEFAULT 0 CHECK (value = 0),
  gas_limit numeric(78,0) NOT NULL CHECK (gas_limit > 0),
  max_fee_per_gas numeric(78,0) NOT NULL CHECK (max_fee_per_gas > 0),
  max_priority_fee_per_gas numeric(78,0) NOT NULL CHECK (max_priority_fee_per_gas >= 0),
  native_reserved numeric(78,0) NOT NULL CHECK (native_reserved > 0),
  native_spent numeric(78,0),
  max_cred numeric(78,0) NOT NULL DEFAULT 0 CHECK (max_cred >= 0),
  spent_cred numeric(78,0),
  deadline bigint NOT NULL,
  expected jsonb NOT NULL,
  request jsonb NOT NULL,
  summary jsonb NOT NULL,
  binding text NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','unknown','submitted','confirming','confirmed','reverted','reorganized','reconciliation_required')),
  transaction_hash text UNIQUE,
  receipt jsonb,
  evidence jsonb,
  receipt_block_number numeric(78,0),
  receipt_block_hash text,
  confirmations integer NOT NULL DEFAULT 0,
  canonical boolean NOT NULL DEFAULT false,
  failure_code text,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  UNIQUE(chain_instance,sender,nonce),
  CHECK (spent_cred IS NULL OR (spent_cred > 0 AND spent_cred <= max_cred))
);
CREATE INDEX IF NOT EXISTS external_wallet_agreement_action ON external_wallet_intents(agreement_hash,action);
CREATE INDEX IF NOT EXISTS external_wallet_sender ON external_wallet_intents(chain_instance,sender);

CREATE OR REPLACE FUNCTION protect_external_wallet_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'EXTERNAL_WALLET_INTENT_IMMUTABLE'; END IF;
  IF ROW(NEW.operation_id,NEW.chain_instance,NEW.agreement_hash,NEW.action,NEW.sender,NEW.nonce,
    NEW.destination,NEW.calldata,NEW.value,NEW.gas_limit,NEW.max_fee_per_gas,NEW.max_priority_fee_per_gas,
    NEW.native_reserved,NEW.max_cred,NEW.deadline,NEW.expected,NEW.request,NEW.summary,NEW.binding,NEW.created_at_ms)
    IS DISTINCT FROM
    ROW(OLD.operation_id,OLD.chain_instance,OLD.agreement_hash,OLD.action,OLD.sender,OLD.nonce,
    OLD.destination,OLD.calldata,OLD.value,OLD.gas_limit,OLD.max_fee_per_gas,OLD.max_priority_fee_per_gas,
    OLD.native_reserved,OLD.max_cred,OLD.deadline,OLD.expected,OLD.request,OLD.summary,OLD.binding,OLD.created_at_ms)
    THEN RAISE EXCEPTION 'EXTERNAL_WALLET_INTENT_IMMUTABLE'; END IF;
  IF OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash
    THEN RAISE EXCEPTION 'EXTERNAL_WALLET_HASH_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS external_wallet_intent_immutability ON external_wallet_intents;
CREATE TRIGGER external_wallet_intent_immutability BEFORE UPDATE OR DELETE ON external_wallet_intents
  FOR EACH ROW EXECUTE FUNCTION protect_external_wallet_intent();
