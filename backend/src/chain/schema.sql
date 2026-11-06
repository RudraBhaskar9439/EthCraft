CREATE TABLE IF NOT EXISTS ac_chain_nonces (
  chain_instance text NOT NULL, account text NOT NULL, next_nonce bigint NOT NULL,
  PRIMARY KEY(chain_instance,account)
);
CREATE TABLE IF NOT EXISTS ac_chain_intents (
  operation_id uuid PRIMARY KEY, chain_instance text NOT NULL, account text NOT NULL,
  destination text NOT NULL, calldata text NOT NULL, nonce bigint NOT NULL,
  raw_transaction text NOT NULL, transaction_hash text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'prepared', receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
