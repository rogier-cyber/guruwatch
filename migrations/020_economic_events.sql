-- Economische kalender (FMP, met EODHD als reserve): verwachting, vorige en actuele waarde.
CREATE TABLE IF NOT EXISTS economic_events (
  at timestamptz NOT NULL,
  country text NOT NULL,
  event text NOT NULL,
  period text NOT NULL DEFAULT '',
  currency text,
  impact text NOT NULL DEFAULT 'Low',
  previous double precision,
  estimate double precision,
  actual double precision,
  unit text,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (at, country, event)
);
CREATE INDEX IF NOT EXISTS economic_events_at ON economic_events (at);
