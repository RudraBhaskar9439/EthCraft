-- Internal, nonconvertible game currency. No EVM wallet or Minecraft token bridge.
CREATE TABLE IF NOT EXISTS ac_game_players (
  player_id uuid PRIMARY KEY,
  player_name text NOT NULL,
  name_key text NOT NULL UNIQUE,
  available bigint NOT NULL DEFAULT 100 CHECK (available >= 0),
  held bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  joined_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ac_game_events (
  operation_id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES ac_game_players(player_id),
  payload jsonb NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ac_game_transfers (
  transfer_id uuid PRIMARY KEY REFERENCES ac_game_events(operation_id),
  sender_id uuid NOT NULL REFERENCES ac_game_players(player_id),
  recipient_id uuid NOT NULL REFERENCES ac_game_players(player_id),
  amount bigint NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'confirmed')),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK (sender_id <> recipient_id)
);

CREATE TABLE IF NOT EXISTS ac_game_ledger (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL,
  player_id uuid NOT NULL REFERENCES ac_game_players(player_id),
  kind text NOT NULL CHECK (kind IN ('starter_grant', 'transfer', 'sale_reward')),
  delta_available bigint NOT NULL,
  delta_held bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_key, player_id),
  CHECK (delta_available <> 0 OR delta_held <> 0)
);

ALTER TABLE ac_game_ledger DROP CONSTRAINT IF EXISTS ac_game_ledger_kind_check;
ALTER TABLE ac_game_ledger ADD CONSTRAINT ac_game_ledger_kind_check
  CHECK (kind IN ('starter_grant', 'transfer', 'sale_reward'));

-- Finite, disclosed shop funding. Available+held moves to player balances only
-- after the authoritative inventory receiver confirms the exact item removal.
CREATE TABLE IF NOT EXISTS ac_game_shop_treasury (
  id text PRIMARY KEY CHECK (id='shop'),
  available bigint NOT NULL CHECK (available >= 0),
  held bigint NOT NULL DEFAULT 0 CHECK (held >= 0)
);

CREATE TABLE IF NOT EXISTS ac_game_sales (
  sale_id uuid PRIMARY KEY REFERENCES ac_game_events(operation_id),
  player_id uuid NOT NULL REFERENCES ac_game_players(player_id),
  inventory_player_id uuid NOT NULL,
  item text NOT NULL,
  count integer NOT NULL CHECK (count BETWEEN 1 AND 64),
  reward bigint NOT NULL CHECK (reward > 0),
  receiving_operation_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','completed','cancelled')),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ac_game_sales ADD COLUMN IF NOT EXISTS inventory_player_id uuid;
UPDATE ac_game_sales SET inventory_player_id=player_id WHERE inventory_player_id IS NULL;
ALTER TABLE ac_game_sales ALTER COLUMN inventory_player_id SET NOT NULL;

CREATE OR REPLACE FUNCTION protect_game_sale_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sale_id IS DISTINCT FROM OLD.sale_id OR NEW.player_id IS DISTINCT FROM OLD.player_id
    OR NEW.inventory_player_id IS DISTINCT FROM OLD.inventory_player_id OR NEW.item IS DISTINCT FROM OLD.item
    OR NEW.count IS DISTINCT FROM OLD.count OR NEW.reward IS DISTINCT FROM OLD.reward
    OR NEW.receiving_operation_id IS DISTINCT FROM OLD.receiving_operation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
    OR (OLD.state <> 'prepared' AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'GAME_SALE_TERMS_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS game_sale_terms_immutable ON ac_game_sales;
CREATE TRIGGER game_sale_terms_immutable BEFORE UPDATE ON ac_game_sales
FOR EACH ROW EXECUTE FUNCTION protect_game_sale_terms();

CREATE TABLE IF NOT EXISTS ac_game_shop_ledger (
  operation_key text PRIMARY KEY,
  sale_id uuid REFERENCES ac_game_sales(sale_id),
  kind text NOT NULL CHECK (kind IN ('operator_seed','reserve','settle','cancel')),
  delta_available bigint NOT NULL,
  delta_held bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH seeded AS (
  INSERT INTO ac_game_shop_treasury(id,available,held) VALUES('shop',10000,0)
  ON CONFLICT DO NOTHING RETURNING id
)
INSERT INTO ac_game_shop_ledger(operation_key,kind,delta_available,delta_held)
SELECT 'shop-operator-seed','operator_seed',10000,0 FROM seeded;
