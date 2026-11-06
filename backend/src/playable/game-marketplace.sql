-- Full-lot Minecraft stock for internal Game Coins only. No token/chain bridge.
CREATE TABLE IF NOT EXISTS ac_game_market_listings(
 listing_id uuid PRIMARY KEY,seller_id uuid NOT NULL,seller_account_id uuid NOT NULL REFERENCES ac_game_players(player_id),
 item text NOT NULL,count integer NOT NULL CHECK(count BETWEEN 1 AND 64),price bigint NOT NULL CHECK(price>0),
 source_id uuid NOT NULL,source_kind text NOT NULL,terms_digest text NOT NULL,stock_operation_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'awaiting_stock',authority_receipt jsonb,stock_receipt jsonb,custody_id text,fingerprint text,
 reserved_purchase_id uuid,cancel_operation_id uuid UNIQUE,return_operation_id uuid UNIQUE,return_receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_game_market_purchases(
 purchase_id uuid PRIMARY KEY,listing_id uuid NOT NULL REFERENCES ac_game_market_listings,seller_id uuid NOT NULL,
 seller_account_id uuid NOT NULL,buyer_id uuid NOT NULL,buyer_account_id uuid NOT NULL REFERENCES ac_game_players(player_id),
 item text NOT NULL,count integer NOT NULL,price bigint NOT NULL,terms_digest text NOT NULL,quote_digest text NOT NULL,
 delivery_operation_id uuid NOT NULL UNIQUE,custody_id text NOT NULL,fingerprint text NOT NULL,
 expires_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'quoted',delivery_receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_game_market_ledger(
 operation_key text NOT NULL,account_id uuid NOT NULL REFERENCES ac_game_players(player_id),purchase_id uuid NOT NULL REFERENCES ac_game_market_purchases,
 kind text NOT NULL CHECK(kind IN ('reserve','settle')),delta_available bigint NOT NULL,delta_held bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(operation_key,account_id)
);
CREATE OR REPLACE FUNCTION protect_game_market_listing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.listing_id,NEW.seller_id,NEW.seller_account_id,NEW.item,NEW.count,NEW.price,NEW.source_id,NEW.source_kind,NEW.terms_digest,NEW.stock_operation_id,NEW.created_at)
 IS DISTINCT FROM (OLD.listing_id,OLD.seller_id,OLD.seller_account_id,OLD.item,OLD.count,OLD.price,OLD.source_id,OLD.source_kind,OLD.terms_digest,OLD.stock_operation_id,OLD.created_at)
 OR (OLD.stock_receipt IS NOT NULL AND NEW.stock_receipt IS DISTINCT FROM OLD.stock_receipt)
 OR (OLD.return_receipt IS NOT NULL AND NEW.return_receipt IS DISTINCT FROM OLD.return_receipt)
 OR (OLD.custody_id IS NOT NULL AND NEW.custody_id IS DISTINCT FROM OLD.custody_id)
 OR (OLD.fingerprint IS NOT NULL AND NEW.fingerprint IS DISTINCT FROM OLD.fingerprint)
 OR (OLD.reserved_purchase_id IS NOT NULL AND NEW.reserved_purchase_id IS DISTINCT FROM OLD.reserved_purchase_id)
 OR (OLD.cancel_operation_id IS NOT NULL AND NEW.cancel_operation_id IS DISTINCT FROM OLD.cancel_operation_id)
 OR (OLD.return_operation_id IS NOT NULL AND NEW.return_operation_id IS DISTINCT FROM OLD.return_operation_id)
 OR (OLD.authority_receipt IS NOT NULL AND NEW.authority_receipt IS DISTINCT FROM OLD.authority_receipt)
 OR (OLD.state IN ('sold','cancelled','stock_failed') AND NEW.state IS DISTINCT FROM OLD.state)
 THEN RAISE EXCEPTION 'GAME_MARKET_LISTING_TERMS_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS game_market_listing_terms ON ac_game_market_listings;
CREATE TRIGGER game_market_listing_terms BEFORE UPDATE ON ac_game_market_listings FOR EACH ROW EXECUTE FUNCTION protect_game_market_listing();
CREATE OR REPLACE FUNCTION protect_game_market_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','delivery_receipt','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','delivery_receipt','updated_at'])
 OR (OLD.delivery_receipt IS NOT NULL AND NEW.delivery_receipt IS DISTINCT FROM OLD.delivery_receipt)
 OR (OLD.state='settled' AND NEW.state IS DISTINCT FROM OLD.state)
 THEN RAISE EXCEPTION 'GAME_MARKET_PURCHASE_TERMS_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS game_market_purchase_terms ON ac_game_market_purchases;
CREATE TRIGGER game_market_purchase_terms BEFORE UPDATE ON ac_game_market_purchases FOR EACH ROW EXECUTE FUNCTION protect_game_market_purchase();
CREATE OR REPLACE FUNCTION protect_game_market_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GAME_MARKET_LEDGER_IMMUTABLE'; END; $$;
DROP TRIGGER IF EXISTS game_market_ledger_immutable ON ac_game_market_ledger;
CREATE TRIGGER game_market_ledger_immutable BEFORE UPDATE OR DELETE ON ac_game_market_ledger FOR EACH ROW EXECUTE FUNCTION protect_game_market_ledger();
