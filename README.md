# Northbridge Payables

**Live demo:** https://northbridge-payables.onrender.com — hosted on Render's free tier, so the first request after a period of inactivity can take 30-50s to wake the instance up; it's fast after that.

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

