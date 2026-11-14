-- Indexsamenstelling (S&P 500, Nasdaq 100, Dow Jones; later Europese indices via Infront).
CREATE TABLE index_members (
  index_key  text NOT NULL,
  symbol     text NOT NULL,
  name       text,
  sector     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_key, symbol)
);
CREATE INDEX index_members_symbol_idx ON index_members (symbol);
