CREATE TABLE IF NOT EXISTS ac_playable_market_previews (
  preview_id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  request_operation_id uuid NOT NULL UNIQUE,
  request_digest text NOT NULL,
  chain_instance text NOT NULL,
  manifest_digest text NOT NULL,
  wallet_address text NOT NULL,
  token_in text NOT NULL,
  token_out text NOT NULL,
  amount_in numeric(78,0) NOT NULL CHECK (amount_in > 0),
  quoted_out numeric(78,0) NOT NULL CHECK (quoted_out > 0),
  minimum_out numeric(78,0) NOT NULL CHECK (minimum_out > 0),
  slippage_bps integer NOT NULL CHECK (slippage_bps BETWEEN 10 AND 500),
  deadline bigint NOT NULL,
  quote_block_number numeric(78,0) NOT NULL,
  quote_block_hash text NOT NULL,
  approval_operation_id uuid NOT NULL UNIQUE,
  swap_operation_id uuid NOT NULL UNIQUE,
  operation_key text NOT NULL,
  consent_at timestamptz,
  consent_player_id uuid,
  status text NOT NULL DEFAULT 'preview',
  proof jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ac_playable_market_previews ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE ac_playable_market_previews ADD COLUMN IF NOT EXISTS consent_player_id uuid;
ALTER TABLE ac_playable_market_previews ADD COLUMN IF NOT EXISTS maximum_in numeric(78,0);
ALTER TABLE ac_playable_market_previews ADD COLUMN IF NOT EXISTS swap_kind text NOT NULL DEFAULT 'exact_input'
  CHECK ((swap_kind = 'exact_input' AND maximum_in IS NULL) OR
         (swap_kind = 'exact_output' AND maximum_in IS NOT NULL AND maximum_in >= amount_in AND minimum_out = quoted_out));
CREATE INDEX IF NOT EXISTS ac_playable_market_player ON ac_playable_market_previews(player_id,created_at);

CREATE OR REPLACE FUNCTION protect_playable_market_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','proof','updated_at','consent_at','consent_player_id']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','proof','updated_at','consent_at','consent_player_id']) THEN
    RAISE EXCEPTION 'PLAYABLE_MARKET_PREVIEW_IMMUTABLE';
  END IF;
  IF OLD.consent_at IS NOT NULL AND (NEW.consent_at IS DISTINCT FROM OLD.consent_at OR NEW.consent_player_id IS DISTINCT FROM OLD.consent_player_id) THEN
    RAISE EXCEPTION 'PLAYABLE_MARKET_CONSENT_IMMUTABLE';
  END IF;
  IF (NEW.consent_at IS NULL) <> (NEW.consent_player_id IS NULL) OR
     (NEW.consent_player_id IS NOT NULL AND NEW.consent_player_id IS DISTINCT FROM NEW.player_id) THEN
    RAISE EXCEPTION 'PLAYABLE_MARKET_OWNER_CONSENT_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS playable_market_preview_immutable ON ac_playable_market_previews;
CREATE TRIGGER playable_market_preview_immutable BEFORE UPDATE ON ac_playable_market_previews
FOR EACH ROW EXECUTE FUNCTION protect_playable_market_preview();
