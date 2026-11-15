-- Nederlandse vertaling en samenvatting (Claude) van wat we van een earnings call tonen. Eén keer gemaakt en bewaard.
ALTER TABLE earnings_transcripts ADD COLUMN IF NOT EXISTS nl jsonb;
ALTER TABLE earnings_transcripts ADD COLUMN IF NOT EXISTS nl_at timestamptz;
ALTER TABLE earnings_transcripts ADD COLUMN IF NOT EXISTS nl_tries int NOT NULL DEFAULT 0;
