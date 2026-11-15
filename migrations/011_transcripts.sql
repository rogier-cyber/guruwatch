-- Earnings call transcripts (FMP) met onze eigen analyse: toon, onderwerpen, vragen van analisten.
CREATE TABLE IF NOT EXISTS earnings_transcripts (
  symbol     text NOT NULL,
  year       int  NOT NULL,
  quarter    int  NOT NULL,
  date       date,
  content    text NOT NULL,
  analysis   jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, year, quarter)
);
CREATE INDEX IF NOT EXISTS earnings_transcripts_date_idx ON earnings_transcripts (symbol, date DESC);

-- Wanneer de lijst met beschikbare calls per aandeel voor het laatst is opgevraagd.
ALTER TABLE symbol_sync ADD COLUMN IF NOT EXISTS transcripts_at timestamptz;
