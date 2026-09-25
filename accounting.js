'use strict';

const { db, round2, transaction, nowText } = require('./db');

const CURRENCIES = ['GBP', 'EUR', 'USD'];

/**
 * Reporting categories. Every ledger account is mapped to exactly one of
 * these (editable in Setup -> Chart of accounts), which drives where it
 * appears on the balance sheet / P&L and how it flows into the cash flow
 * statement.
 *   side:     asset / liability / equity (balance sheet), income / expense (P&L)
 *   cashflow: section of the (indirect-method) cash flow statement
 */
const CATEGORIES = [
  { key: 'fixed_assets', name: 'Fixed assets', statement: 'BS', side: 'asset', cashflow: 'investing' },
  // Contra-asset: shown (negative) under assets; its movement is depreciation, a non-cash item.
  { key: 'accumulated_depreciation', name: 'Accumulated depreciation', statement: 'BS', side: 'asset', cashflow: 'operating', cf_label: 'Add back: depreciation (non-cash)' },
  { key: 'receivables', name: 'Trade receivables', statement: 'BS', side: 'asset', cashflow: 'operating' },
  { key: 'other_current_assets', name: 'Other current assets', statement: 'BS', side: 'asset', cashflow: 'operating' },
  { key: 'cash', name: 'Cash & bank', statement: 'BS', side: 'asset', cashflow: 'cash' },
  { key: 'equity', name: 'Equity', statement: 'BS', side: 'equity', cashflow: 'financing' },
  { key: 'payables', name: 'Trade payables', statement: 'BS', side: 'liability', cashflow: 'operating' },
  { key: 'other_current_liabilities', name: 'Other current liabilities', statement: 'BS', side: 'liability', cashflow: 'operating' },
  { key: 'revenue', name: 'Revenue', statement: 'PL', side: 'income', cashflow: null },
  { key: 'cost_of_sales', name: 'Cost of sales', statement: 'PL', side: 'expense', cashflow: null },
  { key: 'overheads', name: 'Overheads', statement: 'PL', side: 'expense', cashflow: null },
  { key: 'depreciation', name: 'Depreciation', statement: 'PL', side: 'expense', cashflow: null },
  { key: 'financial_income', name: 'Financial income', statement: 'PL', side: 'income', cashflow: null },
  { key: 'financial_expenses', name: 'Financial expenses', statement: 'PL', side: 'expense', cashflow: null },
];
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

// Accounts the app posts to automatically, looked up by role rather than code
// so the codes/names can be changed in the chart of accounts.
const ROLES = {
  AP: 'accounts_payable',
  AR: 'accounts_receivable',
  VAT_IN: 'vat_recoverable',
  VAT_OUT: 'vat_payable',
  FX_GAIN: 'fx_gain',
  FX_LOSS: 'fx_loss',
  MACHINERY_COST: 'machinery_cost',
  MACHINERY_ACCUM: 'machinery_accumulated_depreciation',
  MACHINERY_DEPR: 'machinery_depreciation',
  INVENTORY_COST: 'inventory_cost',
  INVENTORY_ACCUM: 'inventory_accumulated_depreciation',
  INVENTORY_DEPR: 'inventory_depreciation',
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function getCompany() {
  return (await db.get('SELECT * FROM company WHERE id = 1'));
}

// ---------- Entities ----------

async function listEntities() {
  return (await db.all('SELECT * FROM entities ORDER BY id'));
}

async function getEntity(id) {
  return (await db.get('SELECT * FROM entities WHERE id = ?', Number(id)));
}

async function requireEntity(id) {
  const e = id ? (await getEntity(id)) : null;
  if (!e) throw httpError(400, 'Choose an entity');
  return e;
}

async function createEntity({ code, name }) {
  code = String(code || '').trim().toUpperCase();
  name = String(name || '').trim();
  if (!/^[A-Z0-9-]{1,10}$/.test(code)) throw httpError(400, 'Entity code must be 1-10 letters/digits');
  if (!name) throw httpError(400, 'Entity name is required');
  const info = (await db.run('INSERT INTO entities (code, name) VALUES (?, ?)', code, name));
  return (await getEntity(Number(info.lastInsertRowid)));
}

/** Entity filter from a request: null means all entities together (no intercompany elimination). */
const entityOf = (v) => (v === undefined || v === null || v === '' || v === 'all' ? null : Number(v));

/** An account restricted to one entity (e.g. its bank account) can't be used by another. */
async function assertAccountForEntity(account, entityId) {
  if (account.entity_id && account.entity_id !== Number(entityId)) {
    const e = (await getEntity(account.entity_id));
    throw httpError(400, `${account.code} ${account.name} belongs to ${e ? e.name : 'another entity'}`);
  }
}

// ---------- Chart of accounts ----------

function decorateAccount(a) {
  const cat = CATEGORY_BY_KEY[a.category];
  return { ...a, category_name: cat ? cat.name : a.category, statement: cat ? cat.statement : null, side: cat ? cat.side : null, cashflow: cat ? cat.cashflow : null };
}

async function listAccounts(entityId) {
  const E = entityOf(entityId);
  const rows = (await db.all(`SELECT a.*, COALESCE(SUM(l.debit), 0) AS total_debit, COALESCE(SUM(l.credit), 0) AS total_credit
       FROM accounts a LEFT JOIN ledger_entries l ON l.account_code = a.code AND (?::int IS NULL OR l.entity_id = ?)
       GROUP BY a.code ORDER BY a.code`, E, E));
  return rows.map((r) => ({ ...decorateAccount(r), balance: round2(r.total_debit - r.total_credit) }));
}

async function getAccount(code) {
  const a = (await db.get('SELECT * FROM accounts WHERE code = ?', code));
  return a ? decorateAccount(a) : null;
}

async function accountByRole(role) {
  const a = (await db.get('SELECT * FROM accounts WHERE role = ?', role));
  if (!a) throw httpError(500, `No account is set up for role "${role}"`);
  return a;
}

async function listBankAccounts() {
  return (await db.all("SELECT * FROM accounts WHERE category = 'cash' AND bank_currency IS NOT NULL ORDER BY code"));
}

async function createAccount({ code, name, category, bank_currency, iban, role, entity_id }) {
  code = String(code || '').trim();
  name = String(name || '').trim();
  if (!/^[0-9A-Za-z-]{1,10}$/.test(code)) throw httpError(400, 'Account code must be 1-10 letters/digits');
  if (!name) throw httpError(400, 'Account name is required');
  if (!CATEGORY_BY_KEY[category]) throw httpError(400, 'Unknown category');
  if ((await getAccount(code))) throw httpError(400, `Account ${code} already exists`);
  if (category === 'cash') {
    if (!CURRENCIES.includes(bank_currency)) throw httpError(400, 'A bank account needs a currency');
  } else {
    bank_currency = null;
  }
  if (entity_id) (await requireEntity(entity_id));
  (await db.run('INSERT INTO accounts (code, name, category, role, bank_currency, iban, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)', code,
    name,
    category,
    role || null,
    bank_currency,
    normaliseIban(iban),
    entity_id ? Number(entity_id) : null));
  return (await getAccount(code));
}

async function updateAccount(code, { name, category, iban }) {
  const existing = (await getAccount(code));
  if (!existing) throw httpError(404, 'Account not found');
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Account name is required');
  if (category !== undefined && !CATEGORY_BY_KEY[category]) throw httpError(400, 'Unknown category');
  if (category !== undefined && existing.bank_currency && category !== 'cash') {
    throw httpError(400, 'Bank accounts must stay in the Cash & bank category');
  }
  (await db.run('UPDATE accounts SET name = ?, category = ?, iban = ? WHERE code = ?', name !== undefined ? String(name).trim() : existing.name,
    category !== undefined ? category : existing.category,
    iban !== undefined ? normaliseIban(iban) : existing.iban,
    code));
  return (await getAccount(code));
}

function normaliseIban(iban) {
  const v = String(iban || '').replace(/\s+/g, '').toUpperCase();
  return v || null;
}

async function requireAccount(code) {
  const a = (await getAccount(code));
  if (!a) throw httpError(400, `Unknown account ${code}`);
  return a;
}

// ---------- Customers & suppliers ----------

const PARTY_TABLE = { supplier: 'suppliers', customer: 'customers' };

async function listParties(kind) {
  return (await db.all(`SELECT * FROM ${PARTY_TABLE[kind]} ORDER BY name`));
}

async function getParty(kind, id) {
  return (await db.get(`SELECT * FROM ${PARTY_TABLE[kind]} WHERE id = ?`, id));
}

const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

function partyFields({ name, country, currency, vat_number, sort_code, account_number, iban, bic }) {
  if (!name || !String(name).trim()) throw httpError(400, 'Name is required');
  if (!CURRENCIES.includes(currency)) throw httpError(400, 'Unsupported currency');
  const sortDigits = clean(sort_code) ? clean(sort_code).replace(/[^0-9]/g, '') : null;
  if (sortDigits && sortDigits.length !== 6) throw httpError(400, 'A UK sort code has 6 digits');
  const accNo = clean(account_number) ? clean(account_number).replace(/\s+/g, '') : null;
  if (accNo && !/^\d{8}$/.test(accNo)) throw httpError(400, 'A UK account number has 8 digits');
  return [
    String(name).trim(),
    clean(country),
    currency,
    clean(vat_number),
    sortDigits ? sortDigits.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3') : null,
    accNo,
    clean(iban) ? clean(iban).replace(/\s+/g, '').toUpperCase() : null,
    clean(bic) ? clean(bic).toUpperCase() : null,
  ];
}

async function createParty(kind, data) {
  const info = (await db.run(`INSERT INTO ${PARTY_TABLE[kind]} (name, country, currency, vat_number, sort_code, account_number, iban, bic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ...partyFields(data)));
  return (await getParty(kind, Number(info.lastInsertRowid)));
}

async function updateParty(kind, id, data) {
  if (!(await getParty(kind, id))) throw httpError(404, `${kind} not found`);
  (await db.run(`UPDATE ${PARTY_TABLE[kind]} SET name = ?, country = ?, currency = ?, vat_number = ?, sort_code = ?, account_number = ?, iban = ?, bic = ? WHERE id = ?`, ...partyFields(data), id));
  return (await getParty(kind, id));
}

// ---------- Cost centres ----------

async function listCostCenters() {
  return (await db.all('SELECT * FROM cost_centers ORDER BY code'));
}

async function createCostCenter({ code, name }) {
  code = String(code || '').trim();
  name = String(name || '').trim();
  if (!/^[0-9A-Za-z-]{1,10}$/.test(code)) throw httpError(400, 'Cost centre code must be 1-10 letters/digits');
  if (!name) throw httpError(400, 'Cost centre name is required');
  if ((await db.get('SELECT 1 FROM cost_centers WHERE code = ?', code))) throw httpError(400, `Cost centre ${code} already exists`);
  (await db.run('INSERT INTO cost_centers (code, name) VALUES (?, ?)', code, name));
  return (await db.get('SELECT * FROM cost_centers WHERE code = ?', code));
}

async function updateCostCenter(code, { name, active }) {
  const cc = (await db.get('SELECT * FROM cost_centers WHERE code = ?', code));
  if (!cc) throw httpError(404, 'Cost centre not found');
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Cost centre name is required');
  (await db.run('UPDATE cost_centers SET name = ?, active = ? WHERE code = ?', name !== undefined ? String(name).trim() : cc.name,
    active !== undefined ? (active ? 1 : 0) : cc.active,
    code));
  return (await db.get('SELECT * FROM cost_centers WHERE code = ?', code));
}

/**
 * Cost centres only apply to P&L accounts; on a balance sheet account the
 * value is dropped. An unknown or inactive code is an error.
 */
async function resolveCostCenter(account, code) {
  if (!code || CATEGORY_BY_KEY[account.category].statement !== 'PL') return null;
  const cc = (await db.get('SELECT * FROM cost_centers WHERE code = ?', code));
  if (!cc) throw httpError(400, `Unknown cost centre ${code}`);
  if (!cc.active) throw httpError(400, `Cost centre ${code} ${cc.name} is inactive`);
  return cc.code;
}

// ---------- Periods ----------

const periodOf = (date) => String(date).slice(0, 7);

function periodBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start_date: `${period}-01`, end_date: `${period}-${String(last).padStart(2, '0')}` };
}

function nextPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

async function ensurePeriod(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw httpError(400, `Invalid period ${period}`);
  const existing = (await db.get('SELECT * FROM periods WHERE period = ?', period));
  if (existing) return existing;
  const { start_date, end_date } = periodBounds(period);
  // Another request (or function instance) may create it at the same moment.
  await db.run('INSERT INTO periods (period, start_date, end_date) VALUES (?, ?, ?) ON CONFLICT (period) DO NOTHING', period, start_date, end_date);
  return (await db.get('SELECT * FROM periods WHERE period = ?', period));
}

/** Make sure every month from `from` to `to` (inclusive) exists as a period. */
async function ensurePeriods(from, to) {
  for (let p = from; p <= to; p = nextPeriod(p)) (await ensurePeriod(p));
}

async function listPeriods() {
  return (await db.all(`SELECT p.*,
         (SELECT COUNT(*) FROM journals j WHERE j.period = p.period) AS journal_count,
         (SELECT COALESCE(SUM(amount), 0) FROM asset_depreciation d WHERE d.period = p.period) AS depreciation
       FROM periods p ORDER BY p.period DESC`))
    .map((p) => ({ ...p, depreciation: round2(p.depreciation) }));
}

async function setPeriodStatus(period, status) {
  const p = (await db.get('SELECT * FROM periods WHERE period = ?', period));
  if (!p) throw httpError(404, 'Period not found');
  if (status === 'closed') {
    // Close in order, so nothing can still be posted "behind" a closed month.
    const earlierOpen = (await db.get("SELECT period FROM periods WHERE period < ? AND status = 'open' AND period IN (SELECT DISTINCT period FROM journals) ORDER BY period LIMIT 1", period));
    if (earlierOpen) throw httpError(400, `Close ${earlierOpen.period} first`);
    (await db.run("UPDATE periods SET status = 'closed', closed_at = ? WHERE period = ?", nowText(), period));
  } else {
    const laterClosed = (await db.get("SELECT period FROM periods WHERE period > ? AND status = 'closed' ORDER BY period DESC LIMIT 1", period));
    if (laterClosed) throw httpError(400, `Reopen ${laterClosed.period} first`);
    (await db.run("UPDATE periods SET status = 'open', closed_at = NULL WHERE period = ?", period));
  }
  return (await db.get('SELECT * FROM periods WHERE period = ?', period));
}

async function assertPeriodOpen(date) {
  const p = (await ensurePeriod(periodOf(date)));
  if (p.status === 'closed') throw httpError(400, `Period ${p.period} is closed - reopen it in Setup to post on ${date}`);
  return p.period;
}

// ---------- Journals ----------

/**
 * Post a balanced journal. Lines carry base-currency (GBP) debit/credit.
 * Throws (and so rolls back the surrounding transaction) if it doesn't balance.
 */
async function postJournal({ entity_id, journal_date, reference, description, source_type, source_id, lines }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(journal_date || '')) throw httpError(400, 'Journal date is required');
  const entity = (await requireEntity(entity_id));
  const period = (await assertPeriodOpen(journal_date));
  const posted = lines
    .map((l) => ({ ...l, debit: round2(l.debit || 0), credit: round2(l.credit || 0) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  if (posted.length < 2) throw httpError(400, 'A journal needs at least two non-zero lines');
  (await checkJournalLines(posted, entity.id));

  const info = (await db.run('INSERT INTO journals (journal_date, period, entity_id, reference, description, source_type, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)', journal_date, period, entity.id, reference || null, description, source_type, source_id ?? null));
  const journalId = Number(info.lastInsertRowid);
  (await insertLedgerLines(journalId, entity.id, journal_date, description, posted));
  return journalId;
}

/** Validate non-zero journal lines (accounts, entity, cost centres, amounts) and that they balance. */
async function checkJournalLines(posted, entityId) {
  if (posted.length < 2) throw httpError(400, 'A journal needs at least two non-zero lines');
  for (const l of posted) {
    const account = (await requireAccount(l.account_code));
    (await assertAccountForEntity(account, entityId));
    l.cost_center = (await resolveCostCenter(account, l.cost_center));
    if (l.debit < 0 || l.credit < 0) throw httpError(400, 'Debit and credit amounts cannot be negative');
    if (l.debit && l.credit) throw httpError(400, 'A line can have a debit or a credit, not both');
  }
  const dr = round2(posted.reduce((s, l) => s + l.debit, 0));
  const cr = round2(posted.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.001) throw httpError(400, `Journal does not balance: debits ${dr.toFixed(2)} vs credits ${cr.toFixed(2)}`);
}

async function insertLedgerLines(journalId, entityId, date, description, posted) {
  const insert = db.statement(`INSERT INTO ledger_entries (journal_id, entity_id, entry_date, account_code, debit, credit, currency, fx_note, description, cost_center, invoice_line_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of posted) {
    (await insert.run(journalId, entityId, date, l.account_code, l.debit, l.credit, l.currency || null, l.fx_note || null, l.description || description, l.cost_center, l.invoice_line_id || null));
  }
}

/**
 * Manual journal entered by the user. Amounts are in the journal's currency
 * and translated to GBP at the given rate; any 1p rounding difference from the
 * translation is absorbed by the largest line so the GBP journal still balances.
 */
async function createManualJournal({ entity_id, journal_date, reference, description, currency, exchange_rate, lines }) {
  const company = (await getCompany());
  currency = currency || company.base_currency;
  if (!CURRENCIES.includes(currency)) throw httpError(400, 'Unsupported currency');
  exchange_rate = currency === company.base_currency ? 1 : Number(exchange_rate);
  if (!(exchange_rate > 0)) throw httpError(400, 'Exchange rate must be a positive number');
  if (!description || !String(description).trim()) throw httpError(400, 'Description is required');
  if (!Array.isArray(lines)) throw httpError(400, 'Journal lines are required');

  const parsed = lines.map((l) => ({
    account_code: l.account_code,
    description: l.description ? String(l.description).trim() : null,
    cost_center: l.cost_center || null,
    debit: round2(Number(l.debit) || 0),
    credit: round2(Number(l.credit) || 0),
  }));
  for (const l of parsed) {
    if (l.debit && l.credit) throw httpError(400, 'A line can have a debit or a credit, not both');
  }
  const dr = round2(parsed.reduce((s, l) => s + l.debit, 0));
  const cr = round2(parsed.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.001) throw httpError(400, `Journal does not balance: debits ${dr.toFixed(2)} vs credits ${cr.toFixed(2)}`);

  const baseLines = parsed.map((l) => ({
    ...l,
    debit: round2(l.debit * exchange_rate),
    credit: round2(l.credit * exchange_rate),
    currency,
    fx_note: currency === company.base_currency ? null : `${(l.debit || l.credit).toFixed(2)} ${currency} @ ${exchange_rate}`,
  }));
  const diff = round2(baseLines.reduce((s, l) => s + l.debit - l.credit, 0));
  if (diff !== 0) {
    const side = diff > 0 ? 'credit' : 'debit';
    const target = baseLines.filter((l) => l[side] > 0).sort((a, b) => b[side] - a[side])[0];
    target[side] = round2(target[side] + Math.abs(diff));
  }

  return transaction(async () => {
    const id = (await postJournal({
      entity_id,
      journal_date,
      reference,
      description: String(description).trim(),
      source_type: 'manual',
      source_id: null,
      lines: baseLines,
    }));
    return (await getJournal(id));
  });
}

// Journals of these types can be changed in full; the others follow their source
// document (invoice, payment, bank line, asset, depreciation) and can only be reclassified.
const FULL_EDIT_SOURCES = ['manual', 'opening'];
const SOURCE_NAMES = { invoice: 'an invoice', payment: 'a payment', bank: 'a bank statement line', asset: 'an asset purchase', depreciation: 'the depreciation run' };

async function getJournal(id) {
  const j = (await db.get(`SELECT j.*, e.code AS entity_code, e.name AS entity_name, p.status AS period_status
       FROM journals j JOIN entities e ON e.id = j.entity_id JOIN periods p ON p.period = j.period WHERE j.id = ?`, id));
  if (!j) return null;
  const history = (await db.all('SELECT id, changed_at, summary FROM journal_audit WHERE journal_id = ? ORDER BY id DESC', id));
  return {
    ...j,
    edit_mode: j.period_status === 'closed' ? 'locked' : FULL_EDIT_SOURCES.includes(j.source_type) ? 'full' : 'reclassify',
    lines: (await ledgerEntriesForJournal(id)),
    history,
  };
}

async function ledgerEntriesForJournal(journalId) {
  return (await db.all(`SELECT l.*, a.name AS account_name FROM ledger_entries l JOIN accounts a ON a.code = l.account_code
       WHERE l.journal_id = ? ORDER BY l.id`, journalId));
}

async function listJournals(entityId) {
  const E = entityOf(entityId);
  return (await db.all(`SELECT j.*, e.code AS entity_code, COALESCE(SUM(l.debit), 0) AS total, COUNT(l.id) AS line_count
       FROM journals j JOIN entities e ON e.id = j.entity_id LEFT JOIN ledger_entries l ON l.journal_id = j.id
       WHERE (?::int IS NULL OR j.entity_id = ?)
       GROUP BY j.id, e.code ORDER BY j.journal_date DESC, j.id DESC`, E, E))
    .map((j) => ({ ...j, total: round2(j.total) }));
}

async function listLedgerEntries(entityId) {
  const E = entityOf(entityId);
  return (await db.all(`SELECT l.*, a.name AS account_name, j.source_type, j.reference, e.code AS entity_code
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id
       JOIN entities e ON e.id = l.entity_id
       WHERE (?::int IS NULL OR l.entity_id = ?)
       ORDER BY l.entry_date, l.id`, E, E));
}

async function trialBalance(entityId) {
  const E = entityOf(entityId);
  return (await db.all(`SELECT l.account_code, a.name AS account_name, a.category, SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code
       WHERE (?::int IS NULL OR l.entity_id = ?)
       GROUP BY l.account_code, a.name, a.category ORDER BY l.account_code`, E, E))
    .map((r) => ({
      account_code: r.account_code,
      account_name: r.account_name,
      category: r.category,
      debit: round2(r.debit),
      credit: round2(r.credit),
      balance: round2(r.debit - r.credit),
    }));
}

// ---------- Invoices ----------

const INVOICE_KIND = { purchase: 'supplier', sale: 'customer' };

/**
 * Create a purchase or sales invoice with one or more lines and post it:
 *   purchase: Dr each line's account (net), Dr VAT Recoverable, Cr Accounts Payable
 *   sale:     Dr Accounts Receivable, Cr each line's account (net), Cr VAT Payable
 * GBP amounts are translated per line; the GBP total is the sum of the
 * translated parts so the journal always balances to the penny.
 */
async function createInvoice({ entity_id, type, party_id, invoice_number, invoice_date, currency, exchange_rate, notes, lines }) {
  if (!INVOICE_KIND[type]) throw httpError(400, 'Invoice type must be purchase or sale');
  const entity = (await requireEntity(entity_id));
  const company = (await getCompany());
  const party = (await getParty(INVOICE_KIND[type], party_id));
  if (!party) throw httpError(400, `Unknown ${INVOICE_KIND[type]}`);
  if (!invoice_number || !invoice_date) throw httpError(400, 'Invoice number and date are required');
  const dup = (await db.get('SELECT 1 FROM invoices WHERE entity_id = ? AND type = ? AND party_id = ? AND invoice_number = ?', entity.id, type, party_id, String(invoice_number).trim()));
  if (dup) throw httpError(400, `Invoice ${invoice_number} from/to ${party.name} is already booked in ${entity.name}`);
  if (!CURRENCIES.includes(currency)) throw httpError(400, 'Unsupported currency');
  exchange_rate = currency === company.base_currency ? 1 : Number(exchange_rate);
  if (!(exchange_rate > 0)) throw httpError(400, 'Exchange rate must be a positive number');
  if (!Array.isArray(lines) || lines.length === 0) throw httpError(400, 'An invoice needs at least one line');

  const parsed = [];
  for (const [i, l] of lines.entries()) {
    const net = round2(Number(l.net_amount));
    if (!(net >= 0)) throw httpError(400, `Line ${i + 1}: net amount must be zero or more`);
    // A VAT code decides the rate and the VAT account; a bare rate (older callers) is matched to its code.
    let vatCode = null;
    if (l.vat_code) {
      vatCode = await getVatCode(l.vat_code);
      if (!vatCode) throw httpError(400, `Line ${i + 1}: unknown VAT code ${l.vat_code}`);
      if (!vatCode.active) throw httpError(400, `Line ${i + 1}: VAT code ${vatCode.code} is no longer in use`);
    } else {
      vatCode = await db.get('SELECT * FROM vat_codes WHERE rate = ? AND active = 1 ORDER BY code LIMIT 1', Number(l.vat_rate ?? 0));
    }
    const vatRate = vatCode ? vatCode.rate : Number(l.vat_rate ?? 0);
    if (!(vatRate >= 0 && vatRate <= 100)) throw httpError(400, `Line ${i + 1}: VAT rate must be between 0 and 100`);
    const acc = (await requireAccount(l.account_code));
    if (acc.role === ROLES.AP || acc.role === ROLES.AR || acc.category === 'cash') {
      throw httpError(400, `Line ${i + 1}: ${acc.code} ${acc.name} can't be used on an invoice line`);
    }
    parsed.push({
      description: l.description ? String(l.description).trim() : null,
      account_code: acc.code,
      cost_center: await resolveCostCenter(acc, l.cost_center),
      net_amount: net,
      vat_code: vatCode ? vatCode.code : null,
      vat_account: vatCode ? (type === 'purchase' ? vatCode.purchase_account : vatCode.sales_account) : null,
      vat_rate: vatRate,
      vat_amount: round2((net * vatRate) / 100),
      base_net: round2(net * exchange_rate),
    });
  }

  // VAT per VAT code (each has its own GL account), translated to GBP per code.
  const vatGroups = [];
  for (const l of parsed) {
    const key = l.vat_code || '';
    let g = vatGroups.find((x) => x.key === key);
    if (!g) vatGroups.push((g = { key, code: l.vat_code, account: l.vat_account, amount: 0 }));
    g.amount = round2(g.amount + l.vat_amount);
  }
  for (const g of vatGroups) g.base = round2(g.amount * exchange_rate);

  const net_amount = round2(parsed.reduce((s, l) => s + l.net_amount, 0));
  const vat_amount = round2(parsed.reduce((s, l) => s + l.vat_amount, 0));
  const total_amount = round2(net_amount + vat_amount);
  const base_net = round2(parsed.reduce((s, l) => s + l.base_net, 0));
  const base_vat = round2(vatGroups.reduce((s, g) => s + g.base, 0));
  const base_total = round2(base_net + base_vat);
  if (!(total_amount > 0)) throw httpError(400, 'Invoice total must be more than zero');

  return transaction(async () => {
    const info = (await db.run(`INSERT INTO invoices (type, entity_id, party_id, invoice_number, invoice_date, currency, net_amount, vat_amount, total_amount, exchange_rate, base_net, base_vat, base_total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, type, entity.id, party_id, String(invoice_number).trim(), invoice_date, currency, net_amount, vat_amount, total_amount, exchange_rate, base_net, base_vat, base_total, notes || null));
    const invoiceId = Number(info.lastInsertRowid);
    const insertLine = db.statement(`INSERT INTO invoice_lines (invoice_id, description, account_code, net_amount, vat_rate, vat_amount, base_net, cost_center, vat_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of parsed) {
      l.id = Number((await insertLine.run(invoiceId, l.description, l.account_code, l.net_amount, l.vat_rate, l.vat_amount, l.base_net, l.cost_center, l.vat_code)).lastInsertRowid);
    }

    const isPurchase = type === 'purchase';
    const foreign = currency !== company.base_currency;
    const note = (amt) => (foreign ? `${amt.toFixed(2)} ${currency} @ ${exchange_rate}` : null);
    const desc = `${isPurchase ? 'Purchase' : 'Sales'} invoice ${invoice_number} - ${party.name}`;
    const journalLines = parsed.map((l) => ({
      account_code: l.account_code,
      cost_center: l.cost_center,
      invoice_line_id: l.id,
      [isPurchase ? 'debit' : 'credit']: l.base_net,
      currency,
      fx_note: note(l.net_amount),
      description: l.description ? `${desc} - ${l.description}` : desc,
    }));
    for (const g of vatGroups) {
      if (!(g.base > 0)) continue;
      journalLines.push({
        // Without a VAT code (none set up yet) VAT goes to the general VAT account.
        account_code: g.account || (await accountByRole(isPurchase ? ROLES.VAT_IN : ROLES.VAT_OUT)).code,
        [isPurchase ? 'debit' : 'credit']: g.base,
        currency,
        fx_note: note(g.amount),
        description: `${desc} - ${isPurchase ? 'input' : 'output'} VAT${g.code ? ` (${g.code})` : ''}`,
      });
    }
    journalLines.push({
      account_code: (await accountByRole(isPurchase ? ROLES.AP : ROLES.AR)).code,
      [isPurchase ? 'credit' : 'debit']: base_total,
      currency,
      fx_note: note(total_amount),
      description: desc,
    });
    (await postJournal({ entity_id: entity.id, journal_date: invoice_date, reference: invoice_number, description: desc, source_type: 'invoice', source_id: invoiceId, lines: journalLines }));
    return (await getInvoice(invoiceId));
  });
}

// Invoices with party, entity and payment totals in one query.
function invoiceSelect(where) {
  return `SELECT i.*, COALESCE(s.name, c.name) AS party_name, e.code AS entity_code, e.name AS entity_name,
            COALESCE(p.paid, 0) AS sum_paid, COALESCE(p.paid_base, 0) AS sum_paid_base,
            COALESCE(p.relieved, 0) AS sum_relieved, COALESCE(p.fx, 0) AS sum_fx
          FROM invoices i
          JOIN entities e ON e.id = i.entity_id
          LEFT JOIN suppliers s ON i.type = 'purchase' AND s.id = i.party_id
          LEFT JOIN customers c ON i.type = 'sale' AND c.id = i.party_id
          LEFT JOIN (
            SELECT invoice_id, SUM(amount) AS paid, SUM(base_cash) AS paid_base, SUM(base_relief) AS relieved, SUM(fx_gain_loss) AS fx
            FROM payments GROUP BY invoice_id
          ) p ON p.invoice_id = i.id
          ${where}`;
}

async function getInvoice(id) {
  const invoice = await db.get(invoiceSelect('WHERE i.id = ?'), id);
  return invoice ? attachComputed(invoice) : null;
}

async function listInvoices(type, entityId) {
  const E = entityOf(entityId);
  return (
    await db.all(
      invoiceSelect('WHERE (?::text IS NULL OR i.type = ?) AND (?::int IS NULL OR i.entity_id = ?) ORDER BY i.invoice_date DESC, i.id DESC'),
      type || null,
      type || null,
      E,
      E
    )
  ).map(attachComputed);
}

/** Status and open amounts from the payment totals selected by invoiceSelect. */
function attachComputed(row) {
  const { sum_paid, sum_paid_base, sum_relieved, sum_fx, ...invoice } = row;
  const remaining = round2(invoice.total_amount - sum_paid);
  let status = 'Open';
  if (remaining <= 0.005) status = 'Paid';
  else if (sum_paid > 0.005) status = 'Partially Paid';
  return {
    ...invoice,
    paid_amount: round2(sum_paid),
    paid_base: round2(sum_paid_base),
    remaining_amount: remaining,
    // Remaining liability/receivable at the rate it was booked at.
    remaining_base: round2(invoice.base_total - sum_relieved),
    realised_fx: round2(sum_fx),
    status,
  };
}

async function invoiceLines(invoiceId) {
  return (await db.all(`SELECT il.*, a.name AS account_name FROM invoice_lines il JOIN accounts a ON a.code = il.account_code
       WHERE il.invoice_id = ? ORDER BY il.id`, invoiceId));
}

async function invoiceDetail(id) {
  const invoice = (await getInvoice(id));
  if (!invoice) return null;
  const payments = (await listPaymentsForInvoice(id));
  const journals = await db.all(
    `SELECT id FROM journals
     WHERE (source_type = 'invoice' AND source_id = ?) OR (source_type = 'payment' AND source_id IN (SELECT id FROM payments WHERE invoice_id = ?))
     ORDER BY journal_date, id`,
    id,
    id
  );
  const ledger = (await Promise.all(journals.map((j) => ledgerEntriesForJournal(j.id)))).flat();
  return { invoice, lines: await invoiceLines(id), payments, ledger };
}

// ---------- Payments & receipts ----------

/**
 * Record a (full or partial) settlement of an invoice from/into any bank account.
 *   amount       part of the invoice settled, in invoice currency
 *   bank_amount  what actually moved in the bank account, in the bank's currency
 *   bank_rate    bank currency -> GBP on the payment date
 * The invoice's AP/AR balance is relieved at the rate it was booked at; the
 * bank leg is recorded at what the cash was actually worth in GBP. The
 * difference is a realised FX gain or loss, posted to its own account.
 *
 *   purchase: Dr AP (booked)  / Cr Bank (actual)  / FX gain (Cr) or loss (Dr)
 *   sale:     Dr Bank (actual) / Cr AR (booked)   / FX gain (Cr) or loss (Dr)
 */
async function createPayment({ invoice_id, payment_date, amount, bank_account, bank_amount, bank_rate, notes }) {
  const company = (await getCompany());
  const invoice = (await getInvoice(invoice_id));
  if (!invoice) throw httpError(400, 'Unknown invoice');
  if (!payment_date) throw httpError(400, 'Payment date is required');
  const bank = (await getAccount(bank_account));
  if (!bank || !bank.bank_currency) throw httpError(400, 'Choose a bank account');
  (await assertAccountForEntity(bank, invoice.entity_id));
  amount = round2(Number(amount));
  if (!(amount > 0)) throw httpError(400, 'Amount settled must be a positive number');
  if (amount > invoice.remaining_amount + 0.005) {
    throw httpError(400, `Amount of ${amount.toFixed(2)} ${invoice.currency} exceeds remaining balance of ${invoice.remaining_amount.toFixed(2)} ${invoice.currency}`);
  }
  // Paying from an account in the invoice's own currency moves exactly the invoice amount.
  bank_amount = bank.bank_currency === invoice.currency ? amount : round2(Number(bank_amount));
  if (!(bank_amount > 0)) throw httpError(400, `Enter the amount in ${bank.bank_currency} that went through the bank`);
  bank_rate = bank.bank_currency === company.base_currency ? 1 : Number(bank_rate);
  if (!(bank_rate > 0)) throw httpError(400, 'Exchange rate must be a positive number');

  const settlesInFull = Math.abs(amount - invoice.remaining_amount) <= 0.005;
  // A final settlement clears exactly what is left on AP/AR, so no pennies are stranded.
  const base_relief = settlesInFull ? invoice.remaining_base : round2(amount * invoice.exchange_rate);
  const base_cash = round2(bank_amount * bank_rate);
  const isPurchase = invoice.type === 'purchase';
  const fx_gain_loss = round2(isPurchase ? base_relief - base_cash : base_cash - base_relief);

  return transaction(async () => {
    const info = (await db.run(`INSERT INTO payments (invoice_id, payment_date, amount, bank_account, bank_currency, bank_amount, bank_rate, base_relief, base_cash, fx_gain_loss, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, invoice_id, payment_date, amount, bank.code, bank.bank_currency, bank_amount, bank_rate, base_relief, base_cash, fx_gain_loss, notes || null));
    const paymentId = Number(info.lastInsertRowid);

    const desc = `${isPurchase ? 'Payment' : 'Receipt'} ${amount.toFixed(2)} ${invoice.currency} - ${isPurchase ? 'purchase' : 'sales'} invoice ${invoice.invoice_number} (${invoice.party_name})`;
    const partyAcc = (await accountByRole(isPurchase ? ROLES.AP : ROLES.AR)).code;
    const reliefNote = invoice.currency === company.base_currency ? null : `${amount.toFixed(2)} ${invoice.currency} @ ${invoice.exchange_rate} (booked rate)`;
    const cashNote = bank.bank_currency === company.base_currency ? null : `${bank_amount.toFixed(2)} ${bank.bank_currency} @ ${bank_rate}`;
    const lines = [
      { account_code: partyAcc, [isPurchase ? 'debit' : 'credit']: base_relief, currency: invoice.currency, fx_note: reliefNote, description: desc },
      { account_code: bank.code, [isPurchase ? 'credit' : 'debit']: base_cash, currency: bank.bank_currency, fx_note: cashNote, description: desc },
    ];
    if (fx_gain_loss > 0) {
      lines.push({ account_code: (await accountByRole(ROLES.FX_GAIN)).code, credit: fx_gain_loss, description: `${desc} - FX gain` });
    } else if (fx_gain_loss < 0) {
      lines.push({ account_code: (await accountByRole(ROLES.FX_LOSS)).code, debit: -fx_gain_loss, description: `${desc} - FX loss` });
    }
    const journalId = (await postJournal({
      entity_id: invoice.entity_id,
      journal_date: payment_date,
      reference: invoice.invoice_number,
      description: desc,
      source_type: 'payment',
      source_id: paymentId,
      lines,
    }));
    return { payment: (await db.get('SELECT * FROM payments WHERE id = ?', paymentId)), journal_id: journalId, invoice: (await getInvoice(invoice_id)) };
  });
}

async function listPaymentsForInvoice(invoice_id) {
  return (await db.all(`SELECT p.*, a.name AS bank_account_name FROM payments p JOIN accounts a ON a.code = p.bank_account
       WHERE p.invoice_id = ? ORDER BY p.payment_date, p.id`, invoice_id));
}

// ---------- Financial statements ----------

function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// The opening-balance journal is always "brought forward": part of the opening
// position of any period it falls in, never a movement within it (otherwise the
// assets and capital taken over would show up as investments and financing).
// Both expect the parameters (from, to).
const OPENING_SQL = "(l.entry_date < ? OR (j.source_type = 'opening' AND l.entry_date <= ?))";
const MOVEMENT_SQL = "(l.entry_date >= ? AND l.entry_date <= ? AND j.source_type <> 'opening')";

function checkRange(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw httpError(400, 'from and to must be dates (YYYY-MM-DD)');
  if (from > to) throw httpError(400, '"From" date must be before "to" date');
}

// SQL condition + parameter for a cost centre filter; 'none' means lines without one.
function costCenterFilter(costCenter) {
  if (!costCenter) return { sql: '', params: [] };
  if (costCenter === 'none') return { sql: ' AND l.cost_center IS NULL', params: [] };
  return { sql: ' AND l.cost_center = ?', params: [costCenter] };
}

/** P&L subtotals from category totals (natural sign: income and expenses both positive). */
function plTotals(t) {
  const gross_profit = round2(t.revenue - t.cost_of_sales);
  const ebitda = round2(gross_profit - t.overheads);
  const operating_result = round2(ebitda - t.depreciation);
  const net_result = round2(operating_result + t.financial_income - t.financial_expenses);
  return { gross_profit, ebitda, operating_result, net_result };
}

/**
 * Balance sheet (opening and closing), P&L for the period and an
 * indirect-method cash flow statement, all grouped by account category.
 * Amounts are shown with their natural sign (assets/expenses as debits,
 * liabilities/equity/income as credits). A cost centre filter narrows the
 * P&L only; the balance sheet and cash flow always cover the whole company.
 */
async function financialStatements({ from, to, cost_center, entity_id }) {
  checkRange(from, to);
  const E = entityOf(entity_id);

  const rows = (await db.all(`SELECT a.code, a.name, a.category,
         COALESCE(SUM(CASE WHEN ${OPENING_SQL} THEN l.debit - l.credit END), 0) AS opening,
         COALESCE(SUM(CASE WHEN ${MOVEMENT_SQL} THEN l.debit - l.credit END), 0) AS movement
       FROM accounts a LEFT JOIN ledger_entries l ON l.account_code = a.code AND (?::int IS NULL OR l.entity_id = ?)
       LEFT JOIN journals j ON j.id = l.journal_id
       GROUP BY a.code ORDER BY a.code`, from, to, from, to, E, E))
    .map((r) => ({ ...r, opening: round2(r.opening), movement: round2(r.movement), closing: round2(r.opening + r.movement) }));

  const signFor = (cat) => (cat.side === 'asset' || cat.side === 'expense' ? 1 : -1);
  const group = (cat, pick) => {
    const s = signFor(cat);
    const accounts = rows
      .filter((r) => r.category === cat.key)
      .map((r) => ({ code: r.code, name: r.name, amount: round2(s * pick(r)) }))
      .filter((a) => a.amount !== 0);
    return { key: cat.key, name: cat.name, accounts, total: round2(accounts.reduce((t, a) => t + a.amount, 0)) };
  };
  const cats = (pred) => CATEGORIES.filter(pred);

  // P&L for the period (optionally for one cost centre)
  const plCats = cats((c) => c.statement === 'PL');
  const pl = {};
  let plMovement = (r) => r.movement;
  if (cost_center) {
    const f = costCenterFilter(cost_center);
    const filtered = Object.fromEntries(
      (await db.all(`SELECT l.account_code AS code, SUM(l.debit - l.credit) AS movement FROM ledger_entries l
           WHERE l.entry_date >= ? AND l.entry_date <= ? AND (?::int IS NULL OR l.entity_id = ?)${f.sql} GROUP BY l.account_code`, from, to, E, E, ...f.params))
        .map((r) => [r.code, round2(r.movement)])
    );
    plMovement = (r) => filtered[r.code] || 0;
  }
  for (const cat of plCats) pl[cat.key] = group(cat, plMovement);
  const totals = plTotals(Object.fromEntries(plCats.map((c) => [c.key, pl[c.key].total])));
  // The cash flow needs the whole-company result, whatever the P&L filter.
  const companyPl = Object.fromEntries(plCats.map((c) => [c.key, group(c, (r) => r.movement).total]));
  const net_result = plTotals(companyPl).net_result;

  // Balance sheet at the start and end of the period. P&L accounts are not
  // closed off to retained earnings, so the cumulative result is shown as
  // its own line within equity.
  const plRows = rows.filter((r) => CATEGORY_BY_KEY[r.category].statement === 'PL');
  const balanceSheet = (pick) => {
    const assets = cats((c) => c.side === 'asset').map((c) => group(c, pick));
    const equity = group(CATEGORY_BY_KEY.equity, pick);
    const result = round2(-plRows.reduce((t, r) => t + pick(r), 0));
    equity.accounts.push({ code: '', name: 'Result to date (not yet appropriated)', amount: result });
    equity.total = round2(equity.total + result);
    const liabilities = cats((c) => c.side === 'liability').map((c) => group(c, pick));
    const total_assets = round2(assets.reduce((t, g) => t + g.total, 0));
    const total_equity_liabilities = round2(equity.total + liabilities.reduce((t, g) => t + g.total, 0));
    return { assets, equity, liabilities, total_assets, total_equity_liabilities, balanced: Math.abs(total_assets - total_equity_liabilities) < 0.01 };
  };

  // Cash flow (indirect): start from the result and reverse out the
  // non-cash balance sheet movements of the period.
  const cfGroup = (cat) => {
    const accounts = rows
      .filter((r) => r.category === cat.key)
      .map((r) => ({ code: r.code, name: r.name, amount: round2(-r.movement) }))
      .filter((a) => a.amount !== 0);
    return { key: cat.key, name: cat.cf_label || `Change in ${cat.name.toLowerCase()}`, accounts, total: round2(accounts.reduce((t, a) => t + a.amount, 0)) };
  };
  const operatingItems = cats((c) => c.cashflow === 'operating').map(cfGroup);
  const operating = round2(net_result + operatingItems.reduce((t, g) => t + g.total, 0));
  const investingItems = cats((c) => c.cashflow === 'investing').map(cfGroup);
  const investing = round2(investingItems.reduce((t, g) => t + g.total, 0));
  const financingItems = cats((c) => c.cashflow === 'financing').map(cfGroup);
  const financing = round2(financingItems.reduce((t, g) => t + g.total, 0));
  const cashRows = rows.filter((r) => r.category === 'cash');
  const opening_cash = round2(cashRows.reduce((t, r) => t + r.opening, 0));
  const closing_cash = round2(cashRows.reduce((t, r) => t + r.closing, 0));
  const net_change = round2(operating + investing + financing);

  return {
    from,
    to,
    opening_date: dayBefore(from),
    cost_center: cost_center || null,
    entity: E ? (await getEntity(E)) : null,
    profit_and_loss: {
      ...pl,
      ...totals,
    },
    balance_sheet: {
      opening: balanceSheet((r) => r.opening),
      closing: balanceSheet((r) => r.closing),
    },
    cash_flow: {
      net_result,
      operating_items: operatingItems,
      operating,
      investing_items: investingItems,
      investing,
      financing_items: financingItems,
      financing,
      net_change,
      opening_cash,
      closing_cash,
      cash_accounts: cashRows.map((r) => ({ code: r.code, name: r.name, opening: r.opening, closing: r.closing })),
      reconciles: Math.abs(opening_cash + net_change - closing_cash) < 0.01,
    },
  };
}

/**
 * P&L per cost centre for a period: one column per cost centre (plus
 * "unallocated"), one row per P&L category, with the subtotals.
 */
async function costCenterReport({ from, to, entity_id }) {
  checkRange(from, to);
  const E = entityOf(entity_id);
  const rows = (await db.all(`SELECT COALESCE(l.cost_center, '') AS cc, a.category, SUM(l.debit - l.credit) AS movement
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code
       WHERE l.entry_date >= ? AND l.entry_date <= ? AND (?::int IS NULL OR l.entity_id = ?)
       GROUP BY cc, a.category`, from, to, E, E));
  const plCats = CATEGORIES.filter((c) => c.statement === 'PL');
  const columns = [...(await listCostCenters()).map((c) => ({ code: c.code, name: c.name })), { code: '', name: 'Unallocated' }];
  const byCc = {};
  for (const col of columns) byCc[col.code] = Object.fromEntries(plCats.map((c) => [c.key, 0]));
  for (const r of rows) {
    const cat = CATEGORY_BY_KEY[r.category];
    if (!cat || cat.statement !== 'PL' || !byCc[r.cc]) continue;
    byCc[r.cc][cat.key] = round2(byCc[r.cc][cat.key] + (cat.side === 'expense' ? r.movement : -r.movement));
  }
  const result = columns.map((col) => ({ ...col, ...byCc[col.code], ...plTotals(byCc[col.code]) }));
  // Hide cost centres (and "unallocated") with nothing on them in the period.
  const used = result.filter((c) => plCats.some((cat) => c[cat.key] !== 0));
  return { from, to, categories: plCats.map((c) => ({ key: c.key, name: c.name })), cost_centers: used };
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

const ratio = (a, b) => (b ? Math.round((a / b) * 10000) / 10000 : null);

/**
 * Financial KPIs for a period: profitability, liquidity, solvency and
 * working capital, plus a monthly trend and costs per cost centre.
 */
async function kpis({ from, to, entity_id }) {
  const E = entityOf(entity_id);
  const fs = await financialStatements({ from, to, entity_id: E });
  const fxGainCode = (await accountByRole(ROLES.FX_GAIN)).code;
  const fxLossCode = (await accountByRole(ROLES.FX_LOSS)).code;
  const pl = fs.profit_and_loss;
  const bs = fs.balance_sheet.closing;
  const cat = (list, key) => (list.find((g) => g.key === key) || { total: 0 }).total;
  const cash = cat(bs.assets, 'cash');
  const receivables = cat(bs.assets, 'receivables');
  const current_assets = round2(receivables + cat(bs.assets, 'other_current_assets') + cash);
  const current_liabilities = round2(bs.liabilities.reduce((t, g) => t + g.total, 0));
  const payables = cat(bs.liabilities, 'payables');
  const equity = bs.equity.total;
  const days = daysBetween(from, to);

  // Invoiced amounts (incl. VAT, in GBP) for the period, to compare with AR/AP balances.
  const invoiced = async (type) =>
    (await db.get('SELECT COALESCE(SUM(base_total), 0) AS t FROM invoices WHERE type = ? AND invoice_date >= ? AND invoice_date <= ? AND (?::int IS NULL OR entity_id = ?)', type, from, to, E, E)).t;
  const salesInvoiced = (await invoiced('sale'));
  const purchasesInvoiced = (await invoiced('purchase'));

  // Monthly trend
  const monthRows = (await db.all(`SELECT substr(l.entry_date, 1, 7) AS period, a.category, SUM(l.debit - l.credit) AS movement
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id
       WHERE ${MOVEMENT_SQL} AND (?::int IS NULL OR l.entity_id = ?)
       GROUP BY substr(l.entry_date, 1, 7), a.category`, from, to, E, E));
  const cashBefore = (await db.get(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS t FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id
       WHERE a.category = 'cash' AND ${OPENING_SQL} AND (?::int IS NULL OR l.entity_id = ?)`, from, to, E, E)).t;
  const plCats = CATEGORIES.filter((c) => c.statement === 'PL');
  const months = [];
  let runningCash = cashBefore;
  for (let p = periodOf(from); p <= periodOf(to); p = nextPeriod(p)) {
    const t = Object.fromEntries(plCats.map((c) => [c.key, 0]));
    let cashMove = 0;
    for (const r of monthRows.filter((m) => m.period === p)) {
      const c = CATEGORY_BY_KEY[r.category];
      if (c.key === 'cash') cashMove += r.movement;
      else if (c.statement === 'PL') t[c.key] = round2(t[c.key] + (c.side === 'expense' ? r.movement : -r.movement));
    }
    runningCash = round2(runningCash + cashMove);
    months.push({ period: p, revenue: t.revenue, costs: round2(t.cost_of_sales + t.overheads + t.depreciation), ...plTotals(t), cash: runningCash });
  }

  // Operating costs (cost of sales, overheads, depreciation) per cost centre
  const ccReport = (await costCenterReport({ from, to, entity_id: E }));
  const cost_by_cost_center = ccReport.cost_centers
    .map((c) => ({ code: c.code, name: c.name, costs: round2(c.cost_of_sales + c.overheads + c.depreciation) }))
    .filter((c) => c.costs !== 0)
    .sort((a, b) => b.costs - a.costs);

  return {
    from,
    to,
    days,
    revenue: pl.revenue.total,
    gross_profit: pl.gross_profit,
    ebitda: pl.ebitda,
    operating_result: pl.operating_result,
    net_result: pl.net_result,
    depreciation: pl.depreciation.total,
    fx_result: round2(
      (pl.financial_income.accounts.find((a) => a.code === fxGainCode)?.amount || 0) -
        (pl.financial_expenses.accounts.find((a) => a.code === fxLossCode)?.amount || 0)
    ),
    gross_margin: ratio(pl.gross_profit, pl.revenue.total),
    ebitda_margin: ratio(pl.ebitda, pl.revenue.total),
    net_margin: ratio(pl.net_result, pl.revenue.total),
    overhead_ratio: ratio(pl.overheads.total, pl.revenue.total),
    cash,
    working_capital: round2(current_assets - current_liabilities),
    current_ratio: ratio(current_assets, current_liabilities),
    quick_ratio: ratio(round2(cash + receivables), current_liabilities),
    solvency: ratio(equity, bs.total_assets),
    return_on_equity: ratio(pl.net_result, equity),
    dso: salesInvoiced ? Math.round((receivables / salesInvoiced) * days) : null,
    dpo: purchasesInvoiced ? Math.round((payables / purchasesInvoiced) * days) : null,
    months,
    cost_by_cost_center,
  };
}

// ---------- VAT codes ----------

async function listVatCodes() {
  return db.all(
    `SELECT v.*, pa.name AS purchase_account_name, sa.name AS sales_account_name,
       (SELECT COUNT(*) FROM invoice_lines il WHERE il.vat_code = v.code) AS used_on_lines
     FROM vat_codes v JOIN accounts pa ON pa.code = v.purchase_account JOIN accounts sa ON sa.code = v.sales_account
     ORDER BY v.rate DESC, v.code`
  );
}

async function getVatCode(code) {
  return db.get('SELECT * FROM vat_codes WHERE code = ?', String(code || '').trim().toUpperCase());
}

async function checkVatAccounts(purchase_account, sales_account) {
  const pa = await getAccount(purchase_account);
  const sa = await getAccount(sales_account);
  if (!pa || pa.statement !== 'BS') throw httpError(400, 'Choose a balance sheet account for input VAT (purchases)');
  if (!sa || sa.statement !== 'BS') throw httpError(400, 'Choose a balance sheet account for output VAT (sales)');
}

async function createVatCode({ code, description, rate, purchase_account, sales_account }) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(code)) throw httpError(400, 'VAT code: 2-12 letters/digits, e.g. VAT5');
  if (await getVatCode(code)) throw httpError(400, `VAT code ${code} already exists`);
  rate = Number(rate);
  if (!(rate >= 0 && rate <= 100)) throw httpError(400, 'Rate must be between 0 and 100');
  if (!String(description || '').trim()) throw httpError(400, 'Description is required');
  await checkVatAccounts(purchase_account, sales_account);
  await db.run(
    'INSERT INTO vat_codes (code, description, rate, purchase_account, sales_account) VALUES (?, ?, ?, ?, ?)',
    code, String(description).trim(), rate, purchase_account, sales_account
  );
  return getVatCode(code);
}

/** Description, accounts and active flag can change; the rate only while the code is unused. */
async function updateVatCode(code, { description, rate, purchase_account, sales_account, active }) {
  const v = await getVatCode(code);
  if (!v) throw httpError(404, 'VAT code not found');
  if (rate !== undefined && Number(rate) !== v.rate) {
    const used = (await db.get('SELECT COUNT(*) AS n FROM invoice_lines WHERE vat_code = ?', v.code)).n;
    if (used) throw httpError(400, `${v.code} is used on ${used} invoice line(s): create a new code for a new rate`);
    if (!(Number(rate) >= 0 && Number(rate) <= 100)) throw httpError(400, 'Rate must be between 0 and 100');
  }
  const pa = purchase_account || v.purchase_account;
  const sa = sales_account || v.sales_account;
  await checkVatAccounts(pa, sa);
  await db.run(
    'UPDATE vat_codes SET description = ?, rate = ?, purchase_account = ?, sales_account = ?, active = ? WHERE code = ?',
    description !== undefined && String(description).trim() ? String(description).trim() : v.description,
    rate !== undefined ? Number(rate) : v.rate,
    pa,
    sa,
    active !== undefined ? (active ? 1 : 0) : v.active,
    v.code
  );
  return getVatCode(v.code);
}

/**
 * One-off set-up of VAT codes on an existing database (safe to run every start):
 * VAT20 and VAT0 with their own GL accounts; existing invoice lines get their
 * code, and VAT that invoices booked on the general VAT accounts moves to the
 * accounts of their code.
 */
async function setUpVatCodes() {
  await db.addColumn('invoice_lines', 'vat_code', 'TEXT');
  if (!(await getCompany())) return; // empty database: seeding comes first
  if ((await db.get('SELECT COUNT(*) AS n FROM vat_codes')).n > 0) return;
  await transaction(async () => {
    await db.lock(424243);
    if ((await db.get('SELECT COUNT(*) AS n FROM vat_codes')).n > 0) return;
    const accounts = [
      { code: '1210', name: 'Input VAT 20% (VAT20)', category: 'other_current_assets' },
      { code: '1220', name: 'Input VAT 0% (VAT0)', category: 'other_current_assets' },
      { code: '2210', name: 'Output VAT 20% (VAT20)', category: 'other_current_liabilities' },
      { code: '2220', name: 'Output VAT 0% (VAT0)', category: 'other_current_liabilities' },
    ];
    for (const a of accounts) if (!(await getAccount(a.code))) await createAccount(a);
    await db.run("INSERT INTO vat_codes (code, description, rate, purchase_account, sales_account) VALUES ('VAT20', 'Standard rate 20%', 20, '1210', '2210')");
    await db.run("INSERT INTO vat_codes (code, description, rate, purchase_account, sales_account) VALUES ('VAT0', 'Zero rate 0%', 0, '1220', '2220')");
    await db.run("UPDATE invoice_lines SET vat_code = 'VAT20' WHERE vat_code IS NULL AND vat_rate = 20");
    await db.run("UPDATE invoice_lines SET vat_code = 'VAT0' WHERE vat_code IS NULL AND vat_rate = 0");
    // Invoices whose lines are all VAT20/VAT0: their VAT is all 20%, so it moves to the VAT20 accounts.
    const moved = `journal_id IN (
        SELECT j.id FROM journals j WHERE j.source_type = 'invoice'
          AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id = j.source_id AND il.vat_code IS NULL))`;
    const vatIn = (await accountByRole(ROLES.VAT_IN)).code;
    const vatOut = (await accountByRole(ROLES.VAT_OUT)).code;
    await db.run(`UPDATE ledger_entries SET account_code = '1210', description = description || ' (VAT20)' WHERE account_code = ? AND ${moved}`, vatIn);
    await db.run(`UPDATE ledger_entries SET account_code = '2210', description = description || ' (VAT20)' WHERE account_code = ? AND ${moved}`, vatOut);
  });
}

/** Every account VAT is booked on, for purchases (input) or sales (output): the general one plus each code's. */
async function vatAccounts(side) {
  const general = (await accountByRole(side === 'input' ? ROLES.VAT_IN : ROLES.VAT_OUT)).code;
  const col = side === 'input' ? 'purchase_account' : 'sales_account';
  const codes = (await db.all(`SELECT DISTINCT ${col} AS code FROM vat_codes`)).map((r) => r.code);
  return [...new Set([general, ...codes])];
}

// ---------- Editing posted journals ----------

function journalSnapshot(j) {
  return {
    journal_date: j.journal_date,
    reference: j.reference,
    description: j.description,
    lines: j.lines.map((l) => ({ id: l.id, account_code: l.account_code, cost_center: l.cost_center, description: l.description, debit: l.debit, credit: l.credit })),
  };
}

function describeChanges(before, after) {
  const changes = [];
  if (before.journal_date !== after.journal_date) changes.push(`date ${before.journal_date} → ${after.journal_date}`);
  if ((before.reference || '') !== (after.reference || '')) changes.push('reference');
  if (before.description !== after.description) changes.push('description');
  const key = (l) => `${l.account_code}|${l.cost_center || ''}|${l.debit}|${l.credit}`;
  const b = before.lines.map(key).sort().join(';');
  const a = after.lines.map(key).sort().join(';');
  if (b !== a) {
    const byId = Object.fromEntries(before.lines.map((l) => [l.id, l]));
    for (const l of after.lines) {
      const old = byId[l.id];
      if (!old) continue;
      if (old.account_code !== l.account_code) changes.push(`account ${old.account_code} → ${l.account_code}`);
      if ((old.cost_center || '') !== (l.cost_center || '')) changes.push(`cost centre ${old.cost_center || '-'} → ${l.cost_center || '-'}`);
    }
    if (!changes.some((c) => c.startsWith('account') || c.startsWith('cost centre')) || before.lines.length !== after.lines.length) changes.push('lines/amounts');
  }
  return changes.length ? `Changed ${[...new Set(changes)].join(', ')}` : 'Saved without changes';
}

/**
 * Change a posted journal (never in a closed period; every change is logged).
 *   manual / opening journals: everything - date, reference, description and
 *     the lines (GBP amounts), which must still balance.
 *   journals from invoices, payments, bank lines, assets and depreciation:
 *     their amounts and dates follow the source document, so only the
 *     description can change and P&L lines can move to another P&L account
 *     and/or cost centre (a reclassification). An invoice line follows along.
 */
async function editJournal(id, data, editedBy = null) {
  const j = (await getJournal(id));
  if (!j) throw httpError(404, 'Journal not found');
  if (j.edit_mode === 'locked') throw httpError(400, `Period ${j.period} is closed - reopen it in Setup to change this journal`);
  const before = journalSnapshot(j);
  const description = data.description !== undefined ? String(data.description).trim() : j.description;
  if (!description) throw httpError(400, 'Description is required');

  return transaction(async () => {
    if (j.edit_mode === 'full') {
      const date = data.journal_date || j.journal_date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, 'Journal date is required');
      const period = (await assertPeriodOpen(date));
      if (!Array.isArray(data.lines)) throw httpError(400, 'Journal lines are required');
      const oldById = Object.fromEntries(j.lines.map((l) => [l.id, l]));
      const posted = data.lines
        .map((l) => {
          const debit = round2(Number(l.debit) || 0);
          const credit = round2(Number(l.credit) || 0);
          const old = l.id ? oldById[l.id] : null;
          // Keep the original currency note only while the amount is unchanged.
          const keepFx = old && old.debit === debit && old.credit === credit && old.account_code === l.account_code;
          return {
            account_code: l.account_code,
            cost_center: l.cost_center || null,
            description: l.description ? String(l.description).trim() : null,
            debit,
            credit,
            currency: keepFx ? old.currency : null,
            fx_note: keepFx ? old.fx_note : null,
          };
        })
        .filter((l) => l.debit !== 0 || l.credit !== 0);
      (await checkJournalLines(posted, j.entity_id));
      (await db.run('DELETE FROM ledger_entries WHERE journal_id = ?', id));
      (await insertLedgerLines(id, j.entity_id, date, description, posted));
      (await db.run('UPDATE journals SET journal_date = ?, period = ?, reference = ?, description = ? WHERE id = ?', date,
        period,
        data.reference !== undefined ? String(data.reference).trim() || null : j.reference,
        description,
        id));
    } else {
      const byId = Object.fromEntries(j.lines.map((l) => [l.id, l]));
      for (const change of data.lines || []) {
        const line = byId[change.id];
        if (!line) throw httpError(400, 'Unknown journal line');
        const oldAcc = (await getAccount(line.account_code));
        const newAcc = (await requireAccount(change.account_code || line.account_code));
        if (newAcc.code !== oldAcc.code && (oldAcc.statement !== 'PL' || newAcc.statement !== 'PL')) {
          throw httpError(400, `This journal comes from ${SOURCE_NAMES[j.source_type] || 'a source document'}: only its P&L lines can move to another P&L account, ${oldAcc.code} ${oldAcc.name} follows the document`);
        }
        (await assertAccountForEntity(newAcc, j.entity_id));
        const cc = (await resolveCostCenter(newAcc, change.cost_center));
        (await db.run('UPDATE ledger_entries SET account_code = ?, cost_center = ? WHERE id = ?', newAcc.code, cc, line.id));
        if (line.invoice_line_id) {
          (await db.run('UPDATE invoice_lines SET account_code = ?, cost_center = ? WHERE id = ?', newAcc.code, cc, line.invoice_line_id));
        }
      }
      (await db.run('UPDATE journals SET description = ? WHERE id = ?', description, id));
    }
    const after = journalSnapshot((await getJournal(id)));
    (await db.run("UPDATE journals SET edit_count = edit_count + 1, edited_at = ? WHERE id = ?", nowText(), id));
    (await db.run('INSERT INTO journal_audit (journal_id, summary, before_json, after_json) VALUES (?, ?, ?, ?)', id,
      describeChanges(before, after) + (editedBy ? ` (by ${editedBy})` : ''),
      JSON.stringify(before),
      JSON.stringify(after)));
    return (await getJournal(id));
  });
}

// ---------- Account overview ----------

/**
 * Everything booked on one ledger account in a period: opening balance, each
 * entry with a running balance, and totals per month and per cost centre.
 * Amounts are also given with the account's natural sign (debit-positive for
 * assets and costs, credit-positive for liabilities, equity and income).
 */
async function accountDetail(code, { from, to, entity_id, cost_center }) {
  const account = (await getAccount(code));
  if (!account) throw httpError(404, 'Account not found');
  checkRange(from, to);
  const E = entityOf(entity_id);
  const f = costCenterFilter(cost_center);
  const sign = account.side === 'asset' || account.side === 'expense' ? 1 : -1;
  const opening = round2(
    (await db.get(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS t FROM ledger_entries l JOIN journals j ON j.id = l.journal_id
         WHERE l.account_code = ? AND ${OPENING_SQL} AND (?::int IS NULL OR l.entity_id = ?)${f.sql}`, code, from, to, E, E, ...f.params)).t
  );
  const entries = (await db.all(`SELECT l.id, l.journal_id, l.entry_date, l.debit, l.credit, l.description, l.cost_center, l.fx_note,
              j.reference, j.source_type, e.code AS entity_code
       FROM ledger_entries l JOIN journals j ON j.id = l.journal_id JOIN entities e ON e.id = l.entity_id
       WHERE l.account_code = ? AND ${MOVEMENT_SQL} AND (?::int IS NULL OR l.entity_id = ?)${f.sql}
       ORDER BY l.entry_date, l.id`, code, from, to, E, E, ...f.params));
  let running = opening;
  for (const e of entries) {
    running = round2(running + e.debit - e.credit);
    e.balance = running;
  }
  const debit = round2(entries.reduce((t, e) => t + e.debit, 0));
  const credit = round2(entries.reduce((t, e) => t + e.credit, 0));
  const group = (keyOf) => {
    const out = {};
    for (const e of entries) {
      const k = keyOf(e);
      out[k] = out[k] || { key: k, debit: 0, credit: 0 };
      out[k].debit = round2(out[k].debit + e.debit);
      out[k].credit = round2(out[k].credit + e.credit);
    }
    return Object.values(out).map((g) => ({ ...g, net: round2(sign * (g.debit - g.credit)) }));
  };
  const ccNames = Object.fromEntries((await listCostCenters()).map((c) => [c.code, c.name]));
  return {
    account,
    from,
    to,
    entity: E ? (await getEntity(E)) : null,
    cost_center: cost_center || null,
    sign,
    opening,
    debit,
    credit,
    closing: round2(opening + debit - credit),
    entries,
    by_month: group((e) => e.entry_date.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    by_cost_center: group((e) => e.cost_center || '')
      .map((g) => ({ ...g, name: g.key ? `${g.key} ${ccNames[g.key] || ''}` : 'Unallocated' }))
      .sort((a, b) => b.net - a.net),
  };
}

// ---------- Dashboard ----------

async function dashboardSummary(entityId) {
  const E = entityOf(entityId);
  const company = (await getCompany());
  const invoices = (await listInvoices(null, E));
  const summarise = (type) => {
    const list = invoices.filter((i) => i.type === type);
    const open = list.filter((i) => i.status !== 'Paid');
    const by_currency = {};
    for (const cur of CURRENCIES) by_currency[cur] = { outstanding_foreign: 0, outstanding_base: 0, open_invoices: 0 };
    for (const inv of open) {
      const b = by_currency[inv.currency];
      b.outstanding_foreign = round2(b.outstanding_foreign + inv.remaining_amount);
      b.outstanding_base = round2(b.outstanding_base + inv.remaining_base);
      b.open_invoices += 1;
    }
    return { total_invoices: list.length, open_invoices: open.length, outstanding_base: round2(open.reduce((s, i) => s + i.remaining_base, 0)), by_currency };
  };
  const tb = (await trialBalance(E));
  const tbDebit = round2(tb.reduce((s, r) => s + r.debit, 0));
  const tbCredit = round2(tb.reduce((s, r) => s + r.credit, 0));
  const cash = round2(tb.filter((r) => r.category === 'cash').reduce((s, r) => s + r.balance, 0));
  const realisedFx = (await db.get('SELECT COALESCE(SUM(p.fx_gain_loss), 0) AS t FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE (?::int IS NULL OR i.entity_id = ?)', E, E)).t;
  return {
    company,
    entity: E ? (await getEntity(E)) : null,
    payables: summarise('purchase'),
    receivables: summarise('sale'),
    cash_balance: cash,
    realised_fx_total: round2(realisedFx),
    trial_balance: tb,
    trial_balance_balanced: Math.abs(tbDebit - tbCredit) < 0.01,
  };
}

module.exports = {
  CURRENCIES,
  CATEGORIES,
  ROLES,
  httpError,
  getCompany,
  listEntities,
  getEntity,
  requireEntity,
  createEntity,
  entityOf,
  assertAccountForEntity,
  editJournal,
  accountDetail,
  listVatCodes,
  getVatCode,
  createVatCode,
  updateVatCode,
  setUpVatCodes,
  vatAccounts,
  listAccounts,
  getAccount,
  listBankAccounts,
  createAccount,
  updateAccount,
  listParties,
  getParty,
  createParty,
  updateParty,
  listCostCenters,
  createCostCenter,
  updateCostCenter,
  periodOf,
  periodBounds,
  nextPeriod,
  ensurePeriod,
  ensurePeriods,
  listPeriods,
  setPeriodStatus,
  accountByRole,
  postJournal,
  createManualJournal,
  getJournal,
  listJournals,
  listLedgerEntries,
  trialBalance,
  createInvoice,
  getInvoice,
  listInvoices,
  invoiceDetail,
  createPayment,
  financialStatements,
  costCenterReport,
  kpis,
  dashboardSummary,
};
