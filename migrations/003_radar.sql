-- Radar en screeners: bedrijfsprofielen, winstverwachtingen en adviesverdeling door de tijd.

CREATE TABLE companies (
  symbol      text PRIMARY KEY,
  name        text,
  sector      text,
  industry    text,
  exchange    text,
  country     text,
  currency    text,
  market_cap  numeric,
  image       text,
  is_etf      boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companies_sector_idx ON companies (sector);

-- Dagelijkse momentopname van de gemiddelde winstverwachting per boekjaar,
-- zodat we zelf kunnen zien hoe de verwachtingen verschuiven.
CREATE TABLE estimate_snapshots (
  symbol       text NOT NULL,
  snap_date    date NOT NULL,
  fiscal_date  date NOT NULL,
  eps_avg      numeric,
  revenue_avg  numeric,
  analysts     int,
  PRIMARY KEY (symbol, snap_date, fiscal_date)
);

-- Maandelijkse verdeling van adviezen (kopen/houden/verkopen) per aandeel.
CREATE TABLE rating_history (
  symbol       text NOT NULL,
  date         date NOT NULL,
  strong_buy   int NOT NULL DEFAULT 0,
  buy          int NOT NULL DEFAULT 0,
  hold         int NOT NULL DEFAULT 0,
  sell         int NOT NULL DEFAULT 0,
  strong_sell  int NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, date)
);

ALTER TABLE symbol_sync
  ADD COLUMN profile_at timestamptz,
  ADD COLUMN estimates_at timestamptz,
  ADD COLUMN ratings_at timestamptz;

-- Kleine opslag voor zwaardere berekeningen (zoals de contrair-backtest).
CREATE TABLE kv_cache (
  key        text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

