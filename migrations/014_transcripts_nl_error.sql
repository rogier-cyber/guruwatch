-- Laatste foutmelding van de vertaling, om mislukte calls te kunnen nakijken. Pogingen opnieuw toestaan na de fixes.
ALTER TABLE earnings_transcripts ADD COLUMN IF NOT EXISTS nl_error text;
UPDATE earnings_transcripts SET nl_tries = 0 WHERE nl IS NULL AND nl_tries > 0;
