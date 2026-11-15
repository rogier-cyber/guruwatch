-- Wekelijkse zaterdagmail met updates over je volglijst (standaard aan); dagelijkse briefing wordt een optie.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS weekly boolean NOT NULL DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_weekly_at timestamptz;
ALTER TABLE user_settings ALTER COLUMN briefing SET DEFAULT false;
