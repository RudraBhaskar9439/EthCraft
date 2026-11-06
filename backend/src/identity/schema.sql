CREATE TABLE IF NOT EXISTS identity_challenges (
  id uuid PRIMARY KEY,
  server_id text NOT NULL,
  player_uuid uuid NOT NULL,
  session_id text NOT NULL,
  wallet text NOT NULL,
  origin text NOT NULL,
  chain_id bigint NOT NULL,
  nonce text NOT NULL UNIQUE,
  issued_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  consumed_at_ms bigint,
  CHECK (expires_at_ms > issued_at_ms AND expires_at_ms - issued_at_ms <= 300000)
);

CREATE TABLE IF NOT EXISTS identity_links (
  server_id text NOT NULL,
  player_uuid uuid NOT NULL,
  wallet text NOT NULL,
  session_id text NOT NULL,
  challenge_id uuid NOT NULL REFERENCES identity_challenges(id),
  linked_at_ms bigint NOT NULL,
  PRIMARY KEY (server_id, player_uuid),
  UNIQUE (server_id, wallet)
);
