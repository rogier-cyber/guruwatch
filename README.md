# Guruwatch

Volg wat analisten, insiders en de bekendste hedge funds doen.

- **Analisten**: up- en downgrades, koersdoelen, een pagina per analist met trackrecord, en een ranglijst.
- **Insider trades**: aankopen en verkopen van bestuurders (Form 4), met filters op bedrag en "cluster buys".
- **Hedge funds**: 13F-portefeuilles van o.a. Buffett, Burry, Ackman, Dalio en Druckenmiller, met wijzigingen t.o.v. het vorige kwartaal.
- **Aandeelpagina**: koers, consensus en koersdoelen, ratings, insider trades en welke guru's het aandeel hebben.
- **Volglijst** per gebruiker. Inloggen gaat met een code per e-mail (Resend).

Stack: Node.js (Express, EJS), Postgres (Neon), data van Financial Modeling Prep met EODHD als aanvulling (logo's, koershistorie).

## Hoe de data binnenkomt

Het webproces haalt zelf op de achtergrond data op:

| Taak | Elke | Bron |
|---|---|---|
| Koersdoelen en ratings | 15 min | FMP `price-target-latest-news`, `grades-latest-news` |
| Insider trades | 15 min | FMP `insider-trading/latest` |
| Koersen (voor analist-scores) | 30 min | FMP `batch-quote-short` |
| 13F-portefeuilles | 12 uur | FMP `institutional-ownership/*` |

Bij de eerste start wordt een flinke historie binnengehaald (tot 5.000 koersdoelen, ratings en insider trades). Wanneer iemand een aandeel bekijkt, wordt de historie van dat aandeel aangevuld. Op `/status` zie je wanneer elke taak voor het laatst gelukt is en eventuele foutmeldingen.

De lijst met gevolgde fondsen staat in `src/lib/funds.js`.

**Analist-score**: telt koersdoelen van 30 tot 365 dagen oud. "Goede richting" betekent dat de koers sindsdien de voorspelde kant op ging, "doel gehaald" dat de koers nu op of voorbij het koersdoel staat.

## Omgevingsvariabelen

| Naam | Verplicht | Uitleg |
|---|---|---|
| `DATABASE_URL` | ja | Neon connection string (met `sslmode=require`) |
| `FMP_API_KEY` | ja | Financial Modeling Prep |
| `EODHD_API_KEY` | nee | Koershistorie via EODHD (anders FMP) |
| `RESEND_API_KEY` | ja (productie) | Voor de inlogcode-mails |
| `MAIL_FROM` | ja (productie) | Afzender, op een domein dat in Resend is geverifieerd, bv. `Guruwatch <login@jouwdomein.nl>` |
| `SESSION_SECRET` | ja | Lange willekeurige string |
| `ALLOWED_EMAILS` | nee | Komma-gescheiden lijst van wie mag inloggen. Leeg = iedereen |
| `INGEST_ENABLED` | nee | `false` zet de achtergrond-import uit |
| `NODE_ENV` | ja (productie) | `production` |

## Lokaal draaien

```bash
cp .env.example .env   # vul de waarden in
npm install
npm start              # http://localhost:3000
npm test
```

Zonder `RESEND_API_KEY` wordt de inlogcode in de console gelogd.

## Live zetten op Render

1. **Database**: maak in Neon een nieuw project `guruwatch` (Postgres 17, regio Frankfurt). Kopieer de connection string (pooled is prima).
2. **Web service**: in Render kies je *New → Web Service* en koppel je de repo `rogier-cyber/guruwatch`.
   - Branch: `main`
   - Region: Frankfurt
   - Runtime: Node
   - Build command: `npm ci`
   - Start command: `npm start`
   - Health check path: `/health`
   - Auto-deploy: aan
3. **Environment**: zet de variabelen uit de tabel hierboven.
4. **Deploy**. De database-tabellen worden bij het opstarten automatisch aangemaakt.
5. Open de site, log in met je e-mail, en kijk op `/status` of de eerste import loopt.

Draai één instance: de achtergrond-import zit in het webproces.
