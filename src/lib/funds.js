'use strict';

// Bekende hedge funds en investeerders met hun SEC CIK (13F-filer).
// Aanvullen kan hier; bij de volgende start worden ze in de database gezet.
module.exports = [
  { cik: '0001067983', name: 'Berkshire Hathaway', manager: 'Warren Buffett', style: 'Value' },
  { cik: '0001649339', name: 'Scion Asset Management', manager: 'Michael Burry', style: 'Contrarian' },
  { cik: '0001336528', name: 'Pershing Square Capital', manager: 'Bill Ackman', style: 'Activist' },
  { cik: '0001350694', name: 'Bridgewater Associates', manager: 'Ray Dalio', style: 'Macro' },
  { cik: '0001037389', name: 'Renaissance Technologies', manager: 'Jim Simons', style: 'Quant' },
  { cik: '0001656456', name: 'Appaloosa', manager: 'David Tepper', style: 'Distressed / value' },
  { cik: '0001536411', name: 'Duquesne Family Office', manager: 'Stanley Druckenmiller', style: 'Macro' },
  { cik: '0001061768', name: 'Baupost Group', manager: 'Seth Klarman', style: 'Value' },
  { cik: '0001040273', name: 'Third Point', manager: 'Dan Loeb', style: 'Activist' },
  { cik: '0000921669', name: 'Icahn Capital', manager: 'Carl Icahn', style: 'Activist' },
  { cik: '0001079114', name: 'Greenlight Capital', manager: 'David Einhorn', style: 'Value / short' },
  { cik: '0001167483', name: 'Tiger Global Management', manager: 'Chase Coleman', style: 'Growth' },
  { cik: '0001061165', name: 'Lone Pine Capital', manager: 'Stephen Mandel', style: 'Growth' },
  { cik: '0001135730', name: 'Coatue Management', manager: 'Philippe Laffont', style: 'Tech growth' },
  { cik: '0001791786', name: 'Elliott Investment Management', manager: 'Paul Singer', style: 'Activist' },
  { cik: '0001709323', name: 'Himalaya Capital', manager: 'Li Lu', style: 'Value' },
  { cik: '0001549575', name: 'Dalal Street (Pabrai Funds)', manager: 'Mohnish Pabrai', style: 'Value' },
  { cik: '0001569205', name: 'Fundsmith', manager: 'Terry Smith', style: 'Quality' },
  { cik: '0001029160', name: 'Soros Fund Management', manager: 'George Soros', style: 'Macro' },
  { cik: '0001103804', name: 'Viking Global Investors', manager: 'Andreas Halvorsen', style: 'Long/short' },
  { cik: '0001697748', name: 'ARK Investment Management', manager: 'Cathie Wood', style: 'Disruptive growth' },
  { cik: '0001112520', name: 'Akre Capital Management', manager: 'Chuck Akre', style: 'Quality' },
  { cik: '0001166559', name: 'Gates Foundation Trust', manager: 'Bill & Melinda Gates Foundation', style: 'Foundation' },
];
