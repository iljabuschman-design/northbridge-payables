'use strict';

/**
 * Database access for SQLite (local development: a file in ./data) and
 * Postgres (Vercel: Neon, whenever DATABASE_URL is set). The app writes one
 * SQL dialect: "?" placeholders and Postgres-style "::type" casts where
 * Postgres needs a parameter's type; for SQLite the casts are stripped.
 * All calls are async. Queries inside transaction(fn) automatically run on
 * that transaction's connection (via AsyncLocalStorage).
 */

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

// Bump this whenever the schema changes incompatibly: the app's tables are
// then dropped and rebuilt (and reseeded with demo data on startup).
const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL
);

-- Legal entities. Every journal, invoice, asset and bank statement belongs to one.
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
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
  -- NULL: shared by all entities; set: only that entity can post to it (e.g. its bank accounts).
  entity_id INTEGER REFERENCES entities(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Bank details are used by the "Pay" screen for purchase invoices.
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT,
  currency TEXT NOT NULL,
  vat_number TEXT,
  sort_code TEXT,
  account_number TEXT,
  iban TEXT,
  bic TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT,
  currency TEXT NOT NULL,
  vat_number TEXT,
  sort_code TEXT,
  account_number TEXT,
  iban TEXT,
  bic TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Departments. P&L lines can carry a cost centre to split results by department.
CREATE TABLE IF NOT EXISTS cost_centers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Monthly accounting periods ('YYYY-MM'). Nothing can be posted into a closed period.
CREATE TABLE IF NOT EXISTS periods (
  period TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TEXT
);

-- Purchase and sales invoices share one table; party_id points at
-- suppliers (type = 'purchase') or customers (type = 'sale').
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('purchase', 'sale')),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  net_amount REAL NOT NULL,
  vat_rate REAL NOT NULL,
  vat_amount REAL NOT NULL,
  base_net REAL NOT NULL,
  cost_center TEXT REFERENCES cost_centers(code)
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_date TEXT NOT NULL,
  period TEXT NOT NULL REFERENCES periods(period),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  reference TEXT,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  edit_count INTEGER NOT NULL DEFAULT 0,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every change to a posted journal: what it looked like before and after.
CREATE TABLE IF NOT EXISTS journal_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  summary TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL
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
  description TEXT NOT NULL,
  cost_center TEXT REFERENCES cost_centers(code),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  -- The invoice line this entry was posted from, so a reclassification updates the invoice too.
  invoice_line_id INTEGER REFERENCES invoice_lines(id)
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
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  filename TEXT,
  bank_account TEXT NOT NULL REFERENCES accounts(code),
  statement_ref TEXT,
  iban TEXT,
  currency TEXT,
  from_date TEXT,
  to_date TEXT,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  payment_id INTEGER REFERENCES payments(id),
  auto_settled INTEGER NOT NULL DEFAULT 0
);

-- Fixed asset register. asset_type decides which investment / accumulated
-- depreciation / depreciation ledgers are used (see ASSET_TYPES in assets.js).
-- opening_depreciation is depreciation booked before these books started;
-- depreciation_start is the first period depreciated by this system.
CREATE TABLE IF NOT EXISTS fixed_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_number TEXT NOT NULL UNIQUE,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  name TEXT NOT NULL,
  description TEXT,
  asset_type TEXT NOT NULL,
  cost_center TEXT REFERENCES cost_centers(code),
  acquisition_date TEXT NOT NULL,
  acquisition_cost REAL NOT NULL,
  depreciation_rate REAL NOT NULL,
  opening_depreciation REAL NOT NULL DEFAULT 0,
  depreciation_start TEXT NOT NULL,
  acquisition_journal_id INTEGER REFERENCES journals(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS asset_depreciation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES fixed_assets(id),
  period TEXT NOT NULL REFERENCES periods(period),
  amount REAL NOT NULL,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  UNIQUE (asset_id, period)
);

CREATE INDEX IF NOT EXISTS idx_invoices_party ON invoices(type, party_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_journals_source ON journals(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal ON ledger_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_code, entry_date);
CREATE INDEX IF NOT EXISTS idx_bank_lines_statement ON bank_statement_lines(statement_id);
CREATE INDEX IF NOT EXISTS idx_journals_period ON journals(period);
CREATE INDEX IF NOT EXISTS idx_journals_entity ON journals(entity_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entity ON ledger_entries(entity_id, account_code);
CREATE INDEX IF NOT EXISTS idx_invoices_entity ON invoices(entity_id, type);
CREATE INDEX IF NOT EXISTS idx_asset_depr_period ON asset_depreciation(period);
`;

// Every table of this app, in dependency order (used to rebuild after a schema change).
const TABLES = [
  'company', 'entities', 'accounts', 'suppliers', 'customers', 'cost_centers', 'periods', 'invoices', 'invoice_lines',
  'payments', 'journals', 'journal_audit', 'ledger_entries', 'fx_rates', 'bank_statements', 'bank_statement_lines',
  'fixed_assets', 'asset_depreciation', 'schema_meta',
];

const txStore = new AsyncLocalStorage();
const USE_POSTGRES = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
let driver;

if (USE_POSTGRES) {
  const { Pool, types } = require('pg');
  // COUNT/SUM of integers and NUMERIC come back as strings by default; the app wants numbers.
  types.setTypeParser(20, Number);
  types.setTypeParser(1700, Number);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    max: 3,
    ssl: { rejectUnauthorized: false },
  });
  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  const conn = () => txStore.getStore() || pool;
  driver = {
    kind: 'postgres',
    async all(sql, params) {
      return (await conn().query(toPg(sql), params)).rows;
    },
    async exec(sql) {
      await conn().query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await txStore.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    // Serialise one-off jobs (seeding) across function instances starting at the same time.
    async lock(key) {
      await conn().query('SELECT pg_advisory_xact_lock($1)', [key]);
    },
    ddl: (sql) => sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY').replace(/ REAL\b/g, ' DOUBLE PRECISION'),
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DB_PATH || (process.env.VERCEL ? '/tmp/northbridge.db' : path.join(__dirname, 'data', 'app.db'));
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const toLite = (sql) => sql.replace(/::[a-z]+/gi, '');
  // One connection: transactions from different requests must take turns.
  let queue = Promise.resolve();
  driver = {
    kind: 'sqlite',
    async all(sql, params) {
      return sqlite.prepare(toLite(sql)).all(...params);
    },
    async exec(sql) {
      sqlite.exec(toLite(sql));
    },
    transaction(fn) {
      const run = async () => {
        sqlite.exec('BEGIN');
        try {
          const result = await txStore.run(true, fn);
          sqlite.exec('COMMIT');
          return result;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
      };
      const next = queue.then(run, run);
      queue = next.catch(() => {});
      return next;
    },
    async lock() {},
    ddl: (sql) => sql,
  };
}

const db = {
  kind: driver.kind,
  /** All rows. */
  all: (sql, ...params) => driver.all(sql, params),
  /** First row or undefined. */
  get: async (sql, ...params) => (await driver.all(sql, params))[0],
  /** Run a statement; INSERTs return the new row (as `row`) and its id (as `lastInsertRowid`). */
  run: async (sql, ...params) => {
    const isInsert = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql);
    const rows = await driver.all(isInsert ? `${sql} RETURNING *` : sql, params);
    return { row: rows[0], lastInsertRowid: rows[0] ? rows[0].id : undefined };
  },
  /** A reusable statement: statement(sql).run(...params) etc. */
  statement: (sql) => ({
    run: (...params) => db.run(sql, ...params),
    get: (...params) => db.get(sql, ...params),
    all: (...params) => db.all(sql, ...params),
  }),
  exec: (sql) => driver.exec(sql),
  lock: (key) => driver.lock(key),
};

/** Run fn in a transaction; rolls back if it throws. Nested calls join the outer transaction. */
function transaction(fn) {
  if (txStore.getStore()) return fn();
  return driver.transaction(fn);
}

/** Current time as text, the same format in both databases. */
const nowText = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

let ready = null;
/** Create the tables (rebuilding them after a schema change). Safe to call often. */
function init() {
  ready =
    ready ||
    (async () => {
      await db.exec('CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
      const row = await db.get('SELECT version FROM schema_meta WHERE id = 1');
      const legacy = db.kind === 'sqlite' && !row && (await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'company'"));
      if ((row && row.version < SCHEMA_VERSION) || legacy) {
        for (const t of [...TABLES].reverse()) {
          if (t !== 'schema_meta') await db.exec(`DROP TABLE IF EXISTS ${t}${db.kind === 'postgres' ? ' CASCADE' : ''}`);
        }
      }
      // Comments are removed first: they may contain semicolons.
      for (const stmt of driver.ddl(SCHEMA.replace(/--.*$/gm, '')).split(';').map((x) => x.trim()).filter(Boolean)) {
        await db.exec(stmt);
      }
      if (!row || row.version < SCHEMA_VERSION) {
        await db.exec(`DELETE FROM schema_meta`);
        await db.run('INSERT INTO schema_meta (id, version) VALUES (1, ?)', SCHEMA_VERSION);
      }
    })().catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

function round2(n) {
  return Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
}

module.exports = { db, init, round2, transaction, nowText };
