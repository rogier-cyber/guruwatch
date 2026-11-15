-- Eén aandelenklasse per bedrijf in de indexlijsten: GOOG, FOX en NWS (niet GOOGL, FOXA, NWSA).
DELETE FROM index_members a USING index_members b
 WHERE a.index_key = b.index_key
   AND ((a.symbol = 'GOOGL' AND b.symbol = 'GOOG') OR (a.symbol = 'FOXA' AND b.symbol = 'FOX') OR (a.symbol = 'NWSA' AND b.symbol = 'NWS'));
UPDATE index_members SET symbol = CASE symbol WHEN 'GOOGL' THEN 'GOOG' WHEN 'FOXA' THEN 'FOX' ELSE 'NWS' END
 WHERE symbol IN ('GOOGL', 'FOXA', 'NWSA');
