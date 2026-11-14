-- Dagkoersen (slot) voor eerlijke scores van koersdoelen
CREATE TABLE prices (
  symbol text NOT NULL,
  date   date NOT NULL,
  close  numeric NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- Per symbool: tot wanneer koersen en koersdoel-historie zijn opgehaald
CREATE TABLE symbol_sync (
  symbol             text PRIMARY KEY,
  prices_through     date,
  prices_synced_at   timestamptz,
  targets_backfilled_at timestamptz,
  targets_oldest     timestamptz,
  results_dirty      boolean NOT NULL DEFAULT true
);

-- Uitkomst per koersdoel (horizon 12 maanden, of tot vandaag als die nog loopt)
CREATE TABLE call_results (
  price_target_id bigint PRIMARY KEY REFERENCES price_targets(id) ON DELETE CASCADE,
  analyst_id   bigint,
  analyst_firm text,
  symbol       text NOT NULL,
  published_at timestamptz NOT NULL,
  direction    smallint NOT NULL,
  p0           numeric NOT NULL,
  target       numeric NOT NULL,
  horizon_end  date NOT NULL,
  p_end        numeric NOT NULL,
  bench_ret    numeric,
  ret          numeric NOT NULL,
  excess       numeric,
  hit          boolean NOT NULL,
  days_to_hit  int,
  complete     boolean NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_results_analyst_idx ON call_results (analyst_id);
CREATE INDEX call_results_symbol_idx ON call_results (symbol, analyst_id);
CREATE INDEX call_results_firm_idx ON call_results (analyst_firm);

-- GuruScore per analist (scope 'all') en per bank
CREATE TABLE guru_scores (
  kind        text NOT NULL CHECK (kind IN ('analyst','firm')),
  ref         text NOT NULL,
  calls       int NOT NULL,
  hit_rate    numeric,
  avg_return  numeric,
  avg_excess  numeric,
  success_rate numeric,
  score       numeric NOT NULL,
  rank        int,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref)
);
CREATE INDEX guru_scores_rank_idx ON guru_scores (kind, score DESC);

-- Snelle opzoeking: vorig koersdoel van dezelfde analist op hetzelfde aandeel
CREATE INDEX price_targets_analyst_symbol_idx ON price_targets (analyst_id, symbol, published_at DESC);
