CREATE TABLE IF NOT EXISTS users (
 id bigint PRIMARY KEY, login text NOT NULL, name text, avatar_url text,
 consent_at timestamptz, allocation_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 tokens integer NOT NULL DEFAULT 0, cosmetics integer NOT NULL DEFAULT 0, normal_matches integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_states (
 state_hash text PRIMARY KEY, origin text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), csrf_hash text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS repositories (
 id bigint PRIMARY KEY, owner_id bigint, owner_login text NOT NULL, name text NOT NULL,
 url text NOT NULL, description text, metadata jsonb NOT NULL, visible boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS allocations (
 user_id bigint NOT NULL REFERENCES users(id), repo_id bigint NOT NULL REFERENCES repositories(id),
 position integer NOT NULL, bucket text NOT NULL CHECK (bucket IN ('initial','personal','public')),
 PRIMARY KEY(user_id,repo_id), UNIQUE(user_id,position)
);
CREATE TABLE IF NOT EXISTS seasons (id integer PRIMARY KEY, active boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO seasons(id,active) VALUES (1,true) ON CONFLICT DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_season ON seasons(active) WHERE active;
CREATE TABLE IF NOT EXISTS card_versions (
 repo_id bigint NOT NULL REFERENCES repositories(id), season_id integer NOT NULL REFERENCES seasons(id),
 status text NOT NULL CHECK (status IN ('pending','ready','error')),
 card jsonb, grade jsonb, classification jsonb, reason text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(repo_id,season_id)
);
CREATE TABLE IF NOT EXISTS pool_memberships (
 repo_id bigint NOT NULL REFERENCES repositories(id), pool text NOT NULL, active boolean NOT NULL DEFAULT false,
 weight integer NOT NULL DEFAULT 1 CHECK (weight > 0), source text NOT NULL, PRIMARY KEY(repo_id,pool)
);
CREATE TABLE IF NOT EXISTS user_cards (
 user_id bigint NOT NULL REFERENCES users(id), repo_id bigint NOT NULL REFERENCES repositories(id),
 source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,repo_id)
);
CREATE TABLE IF NOT EXISTS decks (
 user_id bigint PRIMARY KEY REFERENCES users(id), repo_ids bigint[] NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
 id bigserial PRIMARY KEY, kind text NOT NULL, key text NOT NULL UNIQUE, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz, last_error text
);
CREATE TABLE IF NOT EXISTS matches (
 id uuid PRIMARY KEY, player0 bigint NOT NULL REFERENCES users(id), player1 bigint NOT NULL REFERENCES users(id),
 state jsonb NOT NULL, seq integer NOT NULL DEFAULT 0, deadline timestamptz NOT NULL,
 actions0 integer NOT NULL DEFAULT 0, actions1 integer NOT NULL DEFAULT 0,
 rewarded boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
);
CREATE TABLE IF NOT EXISTS match_commands (
 match_id uuid NOT NULL REFERENCES matches(id), user_id bigint NOT NULL REFERENCES users(id),
 command_id uuid NOT NULL, seq integer NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(match_id,user_id,command_id)
);
CREATE TABLE IF NOT EXISTS queue_entries (
 user_id bigint PRIMARY KEY REFERENCES users(id), deck_kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reward_grants (
 user_id bigint NOT NULL REFERENCES users(id), grant_key text NOT NULL, repo_id bigint, kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,grant_key)
);
CREATE TABLE IF NOT EXISTS normal_opponents (
 user_id bigint NOT NULL REFERENCES users(id), opponent_id bigint NOT NULL REFERENCES users(id),
 day date NOT NULL, count integer NOT NULL DEFAULT 0, PRIMARY KEY(user_id,opponent_id,day)
);
CREATE TABLE IF NOT EXISTS discoveries (
 id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id),
 options bigint[] NOT NULL, chosen bigint, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,chosen)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_discovery ON discoveries(user_id) WHERE chosen IS NULL;
