'use strict';

// Eén aandelenklasse per bedrijf (zoals in de indexlijsten): GOOGL telt mee bij GOOG, LEN-B bij LEN, enz.
// ratio = hoeveel aandelen van de hoofdklasse één aandeel van de andere klasse waard is.
const CLASS_MAP = {
  GOOGL: ['GOOG', 1], FOXA: ['FOX', 1], NWSA: ['NWS', 1], 'BRK-A': ['BRK-B', 1500], 'LEN-B': ['LEN', 1],
  'BF-A': ['BF-B', 1], 'HEI-A': ['HEI', 1], LBRDA: ['LBRDK', 1], LSXMA: ['LSXMK', 1], FWONA: ['FWONK', 1],
  'UHAL-B': ['UHAL', 1], 'MOG-B': ['MOG-A', 1], ZG: ['Z', 1], UA: ['UAA', 1], LILA: ['LILAK', 1], BATRA: ['BATRK', 1],
};

function canonical(symbol) {
  const m = symbol && CLASS_MAP[String(symbol).toUpperCase()];
  return m ? { symbol: m[0], ratio: m[1] } : null;
}

module.exports = { CLASS_MAP, canonical };
