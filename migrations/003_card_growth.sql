ALTER TABLE users ADD COLUMN growth_points integer NOT NULL DEFAULT 0 CHECK (growth_points >= 0);
ALTER TABLE user_cards ADD COLUMN upgrade_rank integer NOT NULL DEFAULT 0 CHECK (upgrade_rank BETWEEN 0 AND 4);
CREATE TABLE growth_rewards (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id),
  day date NOT NULL,
  practice boolean NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
