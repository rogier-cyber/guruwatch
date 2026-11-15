-- Cijferhistorie per aandeel bijhouden: symbolen die pas later bij ons kwamen misten oude kwartalen.
ALTER TABLE symbol_sync ADD COLUMN IF NOT EXISTS earnings_at timestamptz;
