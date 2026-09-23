'use strict';

/**
 * Daily exchange rates from the European Central Bank's official data API
 * (https://data.ecb.europa.eu). ECB reference rates are quoted per EUR, so
 * rates against GBP are derived: 1 EUR = GBP/EUR, 1 USD = (GBP/EUR) / (USD/EUR).
 * Rates are published on TARGET working days around 16:00 CET; for weekends
 * and holidays the most recent earlier rate is used.
 */

const { db } = require('./db');

const ECB_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.GBP+USD.EUR.SP00.A';
const BASE = 'GBP';
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

const status = { last_attempt: null, last_success: null, last_error: null };

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** Fetch ECB rates for a date range and store them. Returns the number of days stored. */
async function fetchRange(start, end) {
  const url = `${ECB_URL}?startPeriod=${start}&endPeriod=${end}&format=csvdata&detail=dataonly`;
  status.last_attempt = new Date().toISOString();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    // The API answers 404 when there are no observations (e.g. a weekend-only range).
    if (res.status === 404) return 0;
    if (!res.ok) throw new Error(`ECB responded ${res.status}`);
    const csv = await res.text();
    const [header, ...rows] = csv.trim().split(/\r?\n/);
    const cols = header.split(',');
    const iCcy = cols.indexOf('CURRENCY');
    const iDate = cols.indexOf('TIME_PERIOD');
    const iVal = cols.indexOf('OBS_VALUE');
    if (iCcy < 0 || iDate < 0 || iVal < 0) throw new Error('Unexpected ECB response format');

    const perEur = {}; // date -> { GBP, USD }
    for (const row of rows) {
      const f = row.split(',');
      const v = Number(f[iVal]);
      if (!(v > 0)) continue;
      (perEur[f[iDate]] ||= {})[f[iCcy]] = v;
    }
    const upsert = db.prepare("INSERT OR REPLACE INTO fx_rates (rate_date, currency, rate_to_base, source) VALUES (?, ?, ?, 'ECB')");
    let days = 0;
    for (const [date, r] of Object.entries(perEur)) {
      if (!r.GBP) continue;
      upsert.run(date, 'EUR', r.GBP);
      if (r.USD) upsert.run(date, 'USD', Math.round((r.GBP / r.USD) * 1e6) / 1e6);
      days++;
    }
    status.last_success = new Date().toISOString();
    status.last_error = null;
    return days;
  } catch (err) {
    status.last_error = err.message;
    throw err;
  }
}

function storedRate(currency, date) {
  if (currency === BASE) return { currency, rate: 1, rate_date: date, source: 'base currency' };
  const row = db
    .prepare('SELECT rate_date, rate_to_base FROM fx_rates WHERE currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1')
    .get(currency, date);
  return row ? { currency, rate: row.rate_to_base, rate_date: row.rate_date, source: 'ECB' } : null;
}

/**
 * Rate for 1 unit of currency in GBP on a date: the ECB rate of that day, or
 * the last one published before it. Fetches from the ECB if it isn't stored yet.
 */
async function getRate(currency, date) {
  let r = storedRate(currency, date);
  const today = isoDate(new Date());
  const lookup = date > today ? today : date;
  // Stale if the nearest stored rate is more than a long weekend before the date asked for.
  if (!r || (r.source === 'ECB' && r.rate_date < addDays(lookup, -4))) {
    try {
      await fetchRange(addDays(lookup, -10), lookup);
    } catch (err) {
      console.error('ECB rate fetch failed:', err.message);
    }
    r = storedRate(currency, date);
  }
  return r;
}

/** Pull everything since the last stored rate (or the past ~13 months on an empty table). */
async function updateLatest() {
  const last = db.prepare('SELECT MAX(rate_date) AS d FROM fx_rates').get().d;
  const today = isoDate(new Date());
  const start = last || addDays(today, -400);
  const days = await fetchRange(start, today);
  console.log(`ECB rates updated (${days} day(s) from ${start})`);
  return days;
}

function latestRates() {
  return ['EUR', 'USD'].map((c) => storedRate(c, '9999-12-31')).filter(Boolean);
}

function getStatus() {
  const count = db.prepare('SELECT COUNT(DISTINCT rate_date) AS n, MIN(rate_date) AS first, MAX(rate_date) AS last FROM fx_rates').get();
  return { ...status, days_stored: count.n, first_date: count.first, last_date: count.last, update_every_hours: UPDATE_EVERY_MS / 3600000 };
}

/** Update now and then every few hours, so a new ECB publication is picked up the same day. */
function startScheduler() {
  const run = () => updateLatest().catch((err) => console.error('ECB rate update failed:', err.message));
  run();
  setInterval(run, UPDATE_EVERY_MS).unref();
}

module.exports = { getRate, storedRate, updateLatest, latestRates, getStatus, startScheduler };
