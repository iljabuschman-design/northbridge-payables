# Northbridge Books (northbridge-payables)

**Live demo:** https://northbridge-payables.onrender.com — hosted on Render's free tier, so the first request after a period of inactivity can take 30-50s to wake the instance up; it's fast after that.

A small multi-currency bookkeeping application (sales & purchase invoices,
bank, journals and financial statements), built as a practical demonstration
for one fictional company (Northbridge Trading Ltd, base currency GBP) with
dummy customers, suppliers and transactions.

## What it does

- **Sales and purchase invoices** in GBP, EUR or USD with any number of lines,
  each booked to its own ledger account with its own VAT rate.
- **Payments and receipts** (full or partial) from/into any bank account. The
  AP/AR balance is cleared at the rate the invoice was booked at and the bank
  leg at what actually went through the bank, with the difference posted to
  **Realised FX gain** or **Realised FX loss**. Example: a 1,000 USD invoice
  booked at 800 GBP, paid from the GBP account for 750 GBP, books a 50 GBP gain.
- **Manual journal entries** with any number of lines (in any currency), which
  must balance before they can be posted.
- **Live exchange rates** from the European Central Bank's data API, fetched on
  start-up and every 6 hours, pre-filled on invoices, payments and journals
  (always overridable).
- **Bank statement import** from CAMT.053 / .052 / .054 files, linked to a bank
  ledger account (automatically via the IBAN). Each line is booked against an
  opposing ledger account or matched to an open invoice. A sample file is in
  `public/samples/`.
- **Chart of accounts** with a reporting-category mapping per account, driving
  the **Financials** tab: profit & loss (revenue, cost of sales, gross profit,
  overheads, financial income/expenses), balance sheet (opening vs closing)
  and an indirect-method cash flow statement, for any period.
- Full double-entry ledger and live trial balance; everything persisted
  server-side in SQLite.

See the in-app Assumptions tab for the accounting/VAT/FX assumptions made.

## Hosting notes

Deployed on Render's free web-service tier, built straight from the `Dockerfile` in this
repo (pins `node:22-alpine` so `node:sqlite` is available). The free tier has no
persistent disk, so the SQLite file lives on the container's local, ephemeral
filesystem: it survives refreshes and is shared across browsers/devices for as long as
that instance keeps running, but a redeploy or a restart after a long idle period resets
it back to the seeded demo data (the app reseeds automatically on startup if the database
is empty, so it never comes up empty). For a permanent production deployment, switch
`DB_PATH` to a mounted persistent disk (or swap in Postgres) on a paid instance.

## Running locally

npm install (no third-party dependencies; this is a no-op), then npm start.

Requires Node.js 22.5+ (uses the built-in node:sqlite module - no native
build step, no external database needed). The app seeds a set of dummy
customers, suppliers, invoices, payments and journals on first run if the
database is empty. When the database schema changes (see SCHEMA_VERSION in
db.js), an older database is rebuilt and reseeded automatically.

Exchange rates are fetched from https://data-api.ecb.europa.eu, so the server
needs outbound internet access for automatic rates; without it, rates can
still be entered by hand.

By default the SQLite file lives at ./data/app.db. Override with the
DB_PATH environment variable (e.g. to point at a mounted persistent
volume in production) and PORT for the HTTP port.

## Stack

Plain Node.js (http, node:sqlite) on the backend, a single-page vanilla
HTML/CSS/JS frontend - no build step, no framework, no external
dependencies at all, to keep the app easy to read, run and deploy anywhere
that runs a recent Node.js.

