-- Guru's: korte bio, quant-fondsen (veel posities) en historie van 13F-kwartalen.
ALTER TABLE funds
  ADD COLUMN bio text,
  ADD COLUMN quant boolean NOT NULL DEFAULT false,
  ADD COLUMN quarters int,
  ADD COLUMN last_error text;
CREATE INDEX fund_holdings_period_idx ON fund_holdings (cik, period DESC, value DESC);
