-- Dekkingsmeting van FMP per land (NL, BE, CA, AU): één rij per meting, resultaat als JSON.
CREATE TABLE IF NOT EXISTS fmp_coverage (
  id serial PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL
);
