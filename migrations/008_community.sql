-- Community: leden worden zelf guru met eigen koersdoelen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_idx ON users (lower(handle));

CREATE TABLE IF NOT EXISTS member_calls (
  id                bigserial PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol            text NOT NULL,
  price_target      numeric NOT NULL,
  price_when_posted numeric NOT NULL,
  note              text,
  published_at      timestamptz NOT NULL DEFAULT now(),
  -- uitkomst (zelfde methode als bij analisten, na minstens 30 dagen)
  direction         smallint,
  hit               boolean,
  ret               numeric,
  excess            numeric,
  days_to_hit       int,
  horizon_end       date,
  complete          boolean NOT NULL DEFAULT false,
  evaluated_at      timestamptz
);
CREATE INDEX IF NOT EXISTS member_calls_user_idx ON member_calls (user_id, published_at DESC);
CREATE INDEX IF NOT EXISTS member_calls_symbol_idx ON member_calls (symbol, published_at DESC);
CREATE INDEX IF NOT EXISTS member_calls_recent_idx ON member_calls (published_at DESC);

-- GuruScore ook voor leden.
ALTER TABLE guru_scores DROP CONSTRAINT IF EXISTS guru_scores_kind_check;
ALTER TABLE guru_scores ADD CONSTRAINT guru_scores_kind_check CHECK (kind IN ('analyst', 'firm', 'member'));
