-- Gebruikers en inloggen met e-mailcode
CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE login_codes (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  code_hash  text NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_email_idx ON login_codes (email, created_at DESC);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE watchlist (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('stock','analyst','fund')),
  ref        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, ref)
);

-- Analisten: koersdoelen (price targets)
CREATE TABLE analysts (
  id         bigserial PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  firm       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_targets (
  id                 bigserial PRIMARY KEY,
  uid                text NOT NULL UNIQUE,
  symbol             text NOT NULL,
  published_at       timestamptz NOT NULL,
  analyst_id         bigint REFERENCES analysts(id),
  analyst_name       text,
  analyst_firm       text,
  price_target       numeric,
  adj_price_target   numeric,
  price_when_posted  numeric,
  news_title         text,
  news_url           text,
  news_publisher     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_targets_symbol_idx ON price_targets (symbol, published_at DESC);
CREATE INDEX price_targets_analyst_idx ON price_targets (analyst_id, published_at DESC);
CREATE INDEX price_targets_published_idx ON price_targets (published_at DESC);

-- Analisten: up-/downgrades per bank
CREATE TABLE grades (
  id                bigserial PRIMARY KEY,
  uid               text NOT NULL UNIQUE,
  symbol            text NOT NULL,
  published_at      timestamptz NOT NULL,
  grading_company   text,
  previous_grade    text,
  new_grade         text,
  action            text,
  price_when_posted numeric,
  news_title        text,
  news_url          text,
  news_publisher    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grades_symbol_idx ON grades (symbol, published_at DESC);
CREATE INDEX grades_published_idx ON grades (published_at DESC);
CREATE INDEX grades_company_idx ON grades (lower(grading_company), published_at DESC);

-- Insider trades (Form 4)
CREATE TABLE insider_trades (
  id                     bigserial PRIMARY KEY,
  uid                    text NOT NULL UNIQUE,
  symbol                 text NOT NULL,
  filing_date            timestamptz,
  transaction_date       date,
  reporting_cik          text,
  reporting_name         text,
  type_of_owner          text,
  transaction_type       text,
  acquisition_or_disposition text,
  securities_transacted  numeric,
  price                  numeric,
  securities_owned       numeric,
  security_name          text,
  form_type              text,
  url                    text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insider_symbol_idx ON insider_trades (symbol, transaction_date DESC);
CREATE INDEX insider_filing_idx ON insider_trades (filing_date DESC);
CREATE INDEX insider_reporter_idx ON insider_trades (reporting_cik, transaction_date DESC);

-- Hedge funds / 13F
CREATE TABLE funds (
  cik        text PRIMARY KEY,
  name       text NOT NULL,
  manager    text,
  slug       text NOT NULL UNIQUE,
  style      text,
  featured   boolean NOT NULL DEFAULT true,
  latest_period date,
  latest_value  numeric,
  latest_positions int,
  refreshed_at timestamptz
);

CREATE TABLE fund_holdings (
  cik          text NOT NULL REFERENCES funds(cik) ON DELETE CASCADE,
  period       date NOT NULL,
  cusip        text NOT NULL,
  put_call     text NOT NULL DEFAULT '',
  symbol       text,
  issuer       text,
  title_of_class text,
  shares       numeric,
  value        numeric,
  weight       numeric,
  filing_date  date,
  PRIMARY KEY (cik, period, cusip, put_call)
);
CREATE INDEX fund_holdings_symbol_idx ON fund_holdings (symbol, period DESC);

-- Laatste koersen (voor analist-scores)
CREATE TABLE quotes (
  symbol     text PRIMARY KEY,
  price      numeric,
  change_pct numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Status van achtergrondtaken
CREATE TABLE job_runs (
  job        text PRIMARY KEY,
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  info       jsonb
);
