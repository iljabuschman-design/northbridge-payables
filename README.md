# Northbridge Payables

A small multi-currency supplier invoice & payment application, built as a
practical demonstration for one fictional company (Northbridge Trading Ltd,
base currency GBP) with dummy suppliers and transactions.

## What it does

- Record supplier invoices (supplier, invoice number, date, currency, net,
  VAT, total) in GBP, EUR or USD.
- Record full or partial payments against an invoice and see the remaining
  balance, in both the original currency and its GBP equivalent.
- Post a full double-entry journal for every invoice and payment (Purchases,
  VAT Recoverable, Accounts Payable, one Bank account per currency, and
  Realised FX Gain/Loss), viewable in the Ledger tab together with a live
  trial balance.
- Recognise realised foreign-exchange gains/losses when the rate at payment
  date differs from the rate booked at invoice date.
- Persist everything server-side in SQLite, so data survives refreshes and
  is visible from any browser hitting the deployed URL.

See the in-app Assumptions tab for the full accounting/VAT/FX assumptions
made.

## Running locally

npm install (no third-party dependencies; this is a no-op), then npm start.

Requires Node.js 22.5+ (uses the built-in node:sqlite module - no native
build step, no external database needed). The app seeds a small set of
dummy suppliers/invoices/payments on first run if the database is empty.

By default the SQLite file lives at ./data/app.db. Override with the
DB_PATH environment variable (e.g. to point at a mounted persistent
volume in production) and PORT for the HTTP port.

## Stack

Plain Node.js (http, node:sqlite) on the backend, a single-page vanilla
HTML/CSS/JS frontend - no build step, no framework, no external
dependencies at all, to keep the app easy to read, run and deploy anywhere
that runs a recent Node.js.

