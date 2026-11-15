-- Eén aandelenklasse per bedrijf in 13F-posities: GOOGL -> GOOG, BRK-A -> BRK-B (x1500), LEN-B -> LEN, enz.
CREATE TEMP TABLE sc_map (alt text, main text, ratio numeric) ON COMMIT DROP;
INSERT INTO sc_map VALUES
  ('GOOGL','GOOG',1), ('FOXA','FOX',1), ('NWSA','NWS',1), ('BRK-A','BRK-B',1500), ('LEN-B','LEN',1),
  ('BF-A','BF-B',1), ('HEI-A','HEI',1), ('LBRDA','LBRDK',1), ('LSXMA','LSXMK',1), ('FWONA','FWONK',1),
  ('UHAL-B','UHAL',1), ('MOG-B','MOG-A',1), ('ZG','Z',1), ('UA','UAA',1), ('LILA','LILAK',1), ('BATRA','BATRK',1);

-- 1. Hoofdklasse aanwezig: tel de andere klasse erbij op.
UPDATE fund_holdings m SET value = m.value + a.v, weight = m.weight + a.w, shares = m.shares + a.s
FROM (SELECT h.cik, h.period, h.put_call, s.main, sum(h.value) AS v, sum(h.weight) AS w, sum(h.shares * s.ratio) AS s
      FROM fund_holdings h JOIN sc_map s ON s.alt = h.symbol GROUP BY h.cik, h.period, h.put_call, s.main) a
WHERE m.cik = a.cik AND m.period = a.period AND m.put_call = a.put_call AND m.symbol = a.main;

-- 2. Die andere-klasse-rijen zijn nu dubbel: weg ermee.
DELETE FROM fund_holdings h USING sc_map s
WHERE s.alt = h.symbol AND EXISTS (SELECT 1 FROM fund_holdings m WHERE m.cik = h.cik AND m.period = h.period AND m.put_call = h.put_call AND m.symbol = s.main);

-- 3. Alleen de andere klasse in bezit: hernoem naar de hoofdklasse.
UPDATE fund_holdings h SET symbol = s.main, shares = h.shares * s.ratio FROM sc_map s WHERE s.alt = h.symbol;
