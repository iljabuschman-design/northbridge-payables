'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// Bump this whenever the schema changes incompatibly. An older database is
// dropped and rebuilt (then reseeded with demo data on startup).
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL
);

-- Chart of accounts. "category" maps each ledger account onto a line of the
-- balance sheet / P&L (see CATEGORIES in accounting.js); "role" marks the
-- accounts the app posts to automatically (AP, AR, VAT, FX gain/loss).
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  role TEXT UNIQUE,
  bank_currency TEXT,
  iban TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT,
  currency TEXT NOT NULL,
  vat_number TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT,
  currency TEXT NOT NULL,
  vat_number TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Purchase and sales invoices share one table; party_id points at
-- suppliers (type = 'purchase') or customers (type = 'sale').
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('purchase', 'sale')),
  party_id INTEGER NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  net_amount REAL NOT NULL,
  vat_amount REAL NOT NULL,
  total_amount REAL NOT NULL,
  exchange_rate REAL NOT NULL,
  base_net REAL NOT NULL,
  base_vat REAL NOT NULL,
  base_total REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  net_amount REAL NOT NULL,
  vat_rate REAL NOT NULL,
  vat_amount REAL NOT NULL,
  base_net REAL NOT NULL
);

-- A payment (purchase invoice) or receipt (sales invoice). "amount" is the
-- part of the invoice settled, in invoice currency; "bank_amount" is what
-- actually left / arrived in the bank account, in the bank's currency.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL,
  bank_account TEXT NOT NULL REFERENCES accounts(code),
  bank_currency TEXT NOT NULL,
  bank_amount REAL NOT NULL,
  bank_rate REAL NOT NULL,
  base_relief REAL NOT NULL,
  base_cash REAL NOT NULL,
  fx_gain_loss REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_date TEXT NOT NULL,
  reference TEXT,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  entry_date TEXT NOT NULL,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  currency TEXT,
  fx_note TEXT,
  description TEXT NOT NULL
);

-- Daily ECB reference rates, stored as "1 unit of currency = rate_to_base GBP".
CREATE TABLE IF NOT EXISTS fx_rates (
  rate_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  rate_to_base REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (rate_date, currency)
);

CREATE TABLE IF NOT EXISTS bank_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT,
  bank_account TEXT NOT NULL REFERENCES accounts(code),
  statement_ref TEXT,
  iban TEXT,
  currency TEXT,
  from_date TEXT,
  to_date TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES bank_statements(id),
  booking_date TEXT NOT NULL,
  amount REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('CRDT', 'DBIT')),
  currency TEXT NOT NULL,
  counterparty TEXT,
  remittance TEXT,
  reference TEXT,
  journal_id INTEGER REFERENCES journals(id),
  payment_id INTEGER REFERENCES payments(id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_party ON invoices(type, party_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_journals_source ON journals(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal ON ledger_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_code, entry_date);
CREATE INDEX IF NOT EXISTS idx_bank_lines_statement ON bank_statement_lines(statement_id);
`;

const currentVersion = db.prepare('PRAGMA user_version').get().user_version;
if (currentVersion < SCHEMA_VERSION) {
  // Old (version 1) layout: rebuild from scratch; seed.js refills it.
  db.exec('PRAGMA foreign_keys = OFF;');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
db.exec('PRAGMA foreign_keys = ON;');
db.exec(SCHEMA);

// Additive changes, applied in place so existing data is kept.
const bankLineCols = db.prepare('PRAGMA table_info(bank_statement_lines)').all().map((c) => c.name);
if (!bankLineCols.includes('auto_settled')) {
  db.exec('ALTER TABLE bank_statement_lines ADD COLUMN auto_settled INTEGER NOT NULL DEFAULT 0');
}

function round2(n) {
  return Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
}

/**
 * Run fn inside a transaction; rolls back if it throws. Nested calls join
 * the outer transaction (e.g. posting a bank line that creates a payment).
 */
let txDepth = 0;
function transaction(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    db.exec('COMMIT');
    return result;
  } catch (err) {
    txDepth--;
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, round2, transaction, DB_PATH };
