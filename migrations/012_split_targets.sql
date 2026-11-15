-- Koersdoelen van voor een aandelensplitsing op dezelfde schaal als de (split-gecorrigeerde) koers.
-- price_target wordt het gecorrigeerde doel (FMP adjPriceTarget) als dat dichter bij de koers van dat moment ligt;
-- het originele doel blijft bewaard in raw_price_target.
ALTER TABLE price_targets ADD COLUMN IF NOT EXISTS raw_price_target numeric;
UPDATE price_targets SET raw_price_target = price_target WHERE raw_price_target IS NULL;

CREATE TEMP TABLE split_fix AS
SELECT id, symbol FROM price_targets
WHERE adj_price_target > 0 AND price_target > 0 AND abs(adj_price_target / price_target - 1) > 0.01
  AND (price_when_posted IS NULL OR price_when_posted <= 0
       OR abs(ln(adj_price_target / price_when_posted)) < abs(ln(price_target / price_when_posted)));

UPDATE price_targets p SET price_target = p.adj_price_target FROM split_fix f WHERE p.id = f.id;
-- Trefkansen en rendementen van die doelen opnieuw berekenen.
DELETE FROM call_results WHERE price_target_id IN (SELECT id FROM split_fix);
UPDATE symbol_sync SET results_dirty = true WHERE symbol IN (SELECT DISTINCT symbol FROM split_fix);
DROP TABLE split_fix;
