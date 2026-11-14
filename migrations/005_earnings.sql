-- Kwartaalcijfers: kalender met verwachte en werkelijke winst en omzet.

CREATE TABLE earnings (
  symbol            text NOT NULL,
  date              date NOT NULL,
  eps_actual        numeric,
  eps_estimated     numeric,
  revenue_actual    numeric,
  revenue_estimated numeric,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, date)
);
CREATE INDEX earnings_date_idx ON earnings (date);

-- Hoe ver de historische kalender al is opgehaald.
CREATE TABLE earnings_backfill (
  month      date PRIMARY KEY,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  rows       int
);
