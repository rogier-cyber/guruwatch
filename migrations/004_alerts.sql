-- Mijn GuruWatch: persoonlijke meldingen en de ochtendbriefing.

CREATE TABLE user_settings (
  user_id        bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  briefing       boolean NOT NULL DEFAULT true,   -- ochtendbriefing om 08:00
  instant_email  boolean NOT NULL DEFAULT true,   -- belangrijke meldingen direct mailen
  last_briefing_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_rules (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_rules_user_idx ON alert_rules (user_id);

CREATE TABLE alerts (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id    bigint REFERENCES alert_rules(id) ON DELETE SET NULL,
  kind       text NOT NULL,
  symbol     text,
  title      text NOT NULL,
  body       text,
  url        text,
  tone       text,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz,
  seen_at    timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX alerts_user_idx ON alerts (user_id, created_at DESC);
