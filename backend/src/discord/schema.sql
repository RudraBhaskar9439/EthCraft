CREATE TABLE IF NOT EXISTS ac_discord_principals (
 principal_id uuid PRIMARY KEY, app_id text NOT NULL, privy_subject text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id,privy_subject)
);
CREATE TABLE IF NOT EXISTS ac_discord_identities (
 discord_user_id text PRIMARY KEY, principal_id uuid NOT NULL UNIQUE REFERENCES ac_discord_principals,
 verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_discord_setup_challenges (
 challenge_hash text PRIMARY KEY, discord_user_id text NOT NULL, interaction_id text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, principal_id uuid REFERENCES ac_discord_principals
);
CREATE TABLE IF NOT EXISTS ac_discord_minecraft_aliases (
 server_id text NOT NULL, player_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES ac_discord_principals,
 player_name text NOT NULL, verification text NOT NULL CHECK(verification IN ('local_connection','microsoft_pending','microsoft_verified')),
 connection_id uuid, evidence jsonb NOT NULL DEFAULT '{}', linked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(server_id,player_id), UNIQUE(server_id,principal_id)
);
CREATE TABLE IF NOT EXISTS ac_discord_wallet_aliases (
 wallet_id text PRIMARY KEY, principal_id uuid NOT NULL REFERENCES ac_discord_principals,
 address text NOT NULL, provider_account_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS ac_discord_name_reservations (
 reservation_id uuid PRIMARY KEY, server_id text NOT NULL, player_name text NOT NULL, normalized_name text NOT NULL,
 principal_id uuid NOT NULL REFERENCES ac_discord_principals, account_kind text NOT NULL CHECK(account_kind IN ('local','microsoft')),
 expires_at timestamptz NOT NULL, approved_at timestamptz, UNIQUE(server_id,normalized_name), UNIQUE(server_id,principal_id)
);
CREATE TABLE IF NOT EXISTS ac_discord_join_approvals (
 operation_id uuid PRIMARY KEY, reservation_id uuid NOT NULL REFERENCES ac_discord_name_reservations,
 principal_id uuid NOT NULL REFERENCES ac_discord_principals, server_id text NOT NULL, player_id uuid NOT NULL,
 connection_id uuid NOT NULL, player_name text NOT NULL, status text NOT NULL CHECK(status IN ('intent','approved')),
 receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(server_id,connection_id)
);
CREATE TABLE IF NOT EXISTS ac_discord_remote_grants (
 grant_id uuid PRIMARY KEY, request_id text NOT NULL UNIQUE, principal_id uuid NOT NULL REFERENCES ac_discord_principals,
 agent_id text NOT NULL, plot_id text NOT NULL, tools jsonb NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ac_discord_one_pending_join ON ac_discord_join_approvals(reservation_id) WHERE status='intent';
