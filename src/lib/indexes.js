'use strict';

// Indices voor de pagina Aandelen. Voor de VS haalt FMP de samenstelling op;
// Europese indices staan klaar en vullen zich zodra er analistendata voor is (Infront).
const GROUPS = [
  { label: 'Verenigde Staten', items: [
    { key: 'sp500', label: 'S&P 500', endpoint: 'sp500-constituent' },
    { key: 'nasdaq100', label: 'Nasdaq 100', endpoint: 'nasdaq-constituent' },
    { key: 'dow', label: 'Dow Jones', endpoint: 'dowjones-constituent' },
  ] },
  { label: 'Amsterdam', items: [
    { key: 'aex', label: 'AEX' },
    { key: 'amx', label: 'AMX' },
    { key: 'ascx', label: 'AScX' },
    { key: 'ams-lokaal', label: 'Lokaal' },
  ] },
  { label: 'Brussel', items: [
    { key: 'bel20', label: 'Bel20' },
    { key: 'bel-mid', label: 'Bel-Mid' },
    { key: 'bel-small', label: 'Bel-Small' },
  ] },
  { label: 'Overig Europa', items: [
    { key: 'eu', label: 'Europa (excl. Amsterdam en Brussel)' },
    { key: 'vk', label: 'Verenigd Koninkrijk' },
  ] },
];

const ALL = GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
const byKey = (k) => ALL.find((i) => i.key === k) || null;

module.exports = { GROUPS, ALL, byKey };
