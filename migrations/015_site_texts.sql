-- Teksten van IEX Media (disclaimer, privacyverklaring) die Guruwatch overneemt; dagelijks ververst.
CREATE TABLE IF NOT EXISTS site_texts (
  key text PRIMARY KEY,
  paras jsonb NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
