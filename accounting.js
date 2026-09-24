'use strict';

const { db, round2, transaction } = require('./db');

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

function getCompany() {
  return db.prepare('SELECT * FROM company WHERE id = 1').get();
}

// ---------- Chart of accounts ----------

function decorateAccount(a) {
  const cat = CATEGORY_BY_KEY[a.category];
  return { ...a, category_name: cat ? cat.name : a.category, statement: cat ? cat.statement : null, side: cat ? cat.side : null };
}

function listAccounts() {
  const rows = db
    .prepare(
      `SELECT a.*, COALESCE(SUM(l.debit), 0) AS total_debit, COALESCE(SUM(l.credit), 0) AS total_credit
       FROM accounts a LEFT JOIN ledger_entries l ON l.account_code = a.code
       GROUP BY a.code ORDER BY a.code`
    )
    .all();
  return rows.map((r) => ({ ...decorateAccount(r), balance: round2(r.total_debit - r.total_credit) }));
}

function getAccount(code) {
  const a = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  return a ? decorateAccount(a) : null;
}

function accountByRole(role) {
  const a = db.prepare('SELECT * FROM accounts WHERE role = ?').get(role);
  if (!a) throw httpError(500, `No account is set up for role "${role}"`);
  return a;
}

function listBankAccounts() {
  return db.prepare("SELECT * FROM accounts WHERE category = 'cash' AND bank_currency IS NOT NULL ORDER BY code").all();
}

function createAccount({ code, name, category, bank_currency, iban, role }) {
  code = String(code || '').trim();
  name = String(name || '').trim();
  if (!/^[0-9A-Za-z-]{1,10}$/.test(code)) throw httpError(400, 'Account code must be 1-10 letters/digits');
  if (!name) throw httpError(400, 'Account name is required');
  if (!CATEGORY_BY_KEY[category]) throw httpError(400, 'Unknown category');
  if (getAccount(code)) throw httpError(400, `Account ${code} already exists`);
  if (category === 'cash') {
    if (!CURRENCIES.includes(bank_currency)) throw httpError(400, 'A bank account needs a currency');
  } else {
    bank_currency = null;
  }
  db.prepare('INSERT INTO accounts (code, name, category, role, bank_currency, iban) VALUES (?, ?, ?, ?, ?, ?)').run(
    code,
    name,
    category,
    role || null,
    bank_currency,
    normaliseIban(iban)
  );
  return getAccount(code);
}

function updateAccount(code, { name, category, iban }) {
  const existing = getAccount(code);
  if (!existing) throw httpError(404, 'Account not found');
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Account name is required');
  if (category !== undefined && !CATEGORY_BY_KEY[category]) throw httpError(400, 'Unknown category');
  if (category !== undefined && existing.bank_currency && category !== 'cash') {
    throw httpError(400, 'Bank accounts must stay in the Cash & bank category');
  }
  db.prepare('UPDATE accounts SET name = ?, category = ?, iban = ? WHERE code = ?').run(
    name !== undefined ? String(name).trim() : existing.name,
    category !== undefined ? category : existing.category,
    iban !== undefined ? normaliseIban(iban) : existing.iban,
    code
  );
  return getAccount(code);
}

function normaliseIban(iban) {
  const v = String(iban || '').replace(/\s+/g, '').toUpperCase();
  return v || null;
}

function requireAccount(code) {
  const a = getAccount(code);
  if (!a) throw httpError(400, `Unknown account ${code}`);
  return a;
}

// ---------- Customers & suppliers ----------

const PARTY_TABLE = { supplier: 'suppliers', customer: 'customers' };

function listParties(kind) {
  return db.prepare(`SELECT * FROM ${PARTY_TABLE[kind]} ORDER BY name`).all();
}

function getParty(kind, id) {
  return db.prepare(`SELECT * FROM ${PARTY_TABLE[kind]} WHERE id = ?`).get(id);
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

function createParty(kind, data) {
  const info = db
    .prepare(`INSERT INTO ${PARTY_TABLE[kind]} (name, country, currency, vat_number, sort_code, account_number, iban, bic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(...partyFields(data));
  return getParty(kind, Number(info.lastInsertRowid));
}

function updateParty(kind, id, data) {
  if (!getParty(kind, id)) throw httpError(404, `${kind} not found`);
  db.prepare(
    `UPDATE ${PARTY_TABLE[kind]} SET name = ?, country = ?, currency = ?, vat_number = ?, sort_code = ?, account_number = ?, iban = ?, bic = ? WHERE id = ?`
  ).run(...partyFields(data), id);
  return getParty(kind, id);
}

// ---------- Cost centres ----------

function listCostCenters() {
  return db.prepare('SELECT * FROM cost_centers ORDER BY code').all();
}

function createCostCenter({ code, name }) {
  code = String(code || '').trim();
  name = String(name || '').trim();
  if (!/^[0-9A-Za-z-]{1,10}$/.test(code)) throw httpError(400, 'Cost centre code must be 1-10 letters/digits');
  if (!name) throw httpError(400, 'Cost centre name is required');
  if (db.prepare('SELECT 1 FROM cost_centers WHERE code = ?').get(code)) throw httpError(400, `Cost centre ${code} already exists`);
  db.prepare('INSERT INTO cost_centers (code, name) VALUES (?, ?)').run(code, name);
  return db.prepare('SELECT * FROM cost_centers WHERE code = ?').get(code);
}

function updateCostCenter(code, { name, active }) {
  const cc = db.prepare('SELECT * FROM cost_centers WHERE code = ?').get(code);
  if (!cc) throw httpError(404, 'Cost centre not found');
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Cost centre name is required');
  db.prepare('UPDATE cost_centers SET name = ?, active = ? WHERE code = ?').run(
    name !== undefined ? String(name).trim() : cc.name,
    active !== undefined ? (active ? 1 : 0) : cc.active,
    code
  );
  return db.prepare('SELECT * FROM cost_centers WHERE code = ?').get(code);
}

/**
 * Cost centres only apply to P&L accounts; on a balance sheet account the
 * value is dropped. An unknown or inactive code is an error.
 */
function resolveCostCenter(account, code) {
  if (!code || CATEGORY_BY_KEY[account.category].statement !== 'PL') return null;
  const cc = db.prepare('SELECT * FROM cost_centers WHERE code = ?').get(code);
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

function ensurePeriod(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw httpError(400, `Invalid period ${period}`);
  const existing = db.prepare('SELECT * FROM periods WHERE period = ?').get(period);
  if (existing) return existing;
  const { start_date, end_date } = periodBounds(period);
  db.prepare('INSERT INTO periods (period, start_date, end_date) VALUES (?, ?, ?)').run(period, start_date, end_date);
  return db.prepare('SELECT * FROM periods WHERE period = ?').get(period);
}

/** Make sure every month from `from` to `to` (inclusive) exists as a period. */
function ensurePeriods(from, to) {
  for (let p = from; p <= to; p = nextPeriod(p)) ensurePeriod(p);
}

function listPeriods() {
  return db
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM journals j WHERE j.period = p.period) AS journal_count,
         (SELECT COALESCE(SUM(amount), 0) FROM asset_depreciation d WHERE d.period = p.period) AS depreciation
       FROM periods p ORDER BY p.period DESC`
    )
    .all()
    .map((p) => ({ ...p, depreciation: round2(p.depreciation) }));
}

function setPeriodStatus(period, status) {
  const p = db.prepare('SELECT * FROM periods WHERE period = ?').get(period);
  if (!p) throw httpError(404, 'Period not found');
  if (status === 'closed') {
    // Close in order, so nothing can still be posted "behind" a closed month.
    const earlierOpen = db
      .prepare("SELECT period FROM periods WHERE period < ? AND status = 'open' AND period IN (SELECT DISTINCT period FROM journals) ORDER BY period LIMIT 1")
      .get(period);
    if (earlierOpen) throw httpError(400, `Close ${earlierOpen.period} first`);
    db.prepare("UPDATE periods SET status = 'closed', closed_at = datetime('now') WHERE period = ?").run(period);
  } else {
    const laterClosed = db.prepare("SELECT period FROM periods WHERE period > ? AND status = 'closed' ORDER BY period DESC LIMIT 1").get(period);
    if (laterClosed) throw httpError(400, `Reopen ${laterClosed.period} first`);
    db.prepare("UPDATE periods SET status = 'open', closed_at = NULL WHERE period = ?").run(period);
  }
  return db.prepare('SELECT * FROM periods WHERE period = ?').get(period);
}

function assertPeriodOpen(date) {
  const p = ensurePeriod(periodOf(date));
  if (p.status === 'closed') throw httpError(400, `Period ${p.period} is closed - reopen it in Setup to post on ${date}`);
  return p.period;
}

// ---------- Journals ----------

/**
 * Post a balanced journal. Lines carry base-currency (GBP) debit/credit.
 * Throws (and so rolls back the surrounding transaction) if it doesn't balance.
 */
function postJournal({ journal_date, reference, description, source_type, source_id, lines }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(journal_date || '')) throw httpError(400, 'Journal date is required');
  const period = assertPeriodOpen(journal_date);
  const posted = lines
    .map((l) => ({ ...l, debit: round2(l.debit || 0), credit: round2(l.credit || 0) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  if (posted.length < 2) throw httpError(400, 'A journal needs at least two non-zero lines');
  for (const l of posted) {
    const account = requireAccount(l.account_code);
    l.cost_center = resolveCostCenter(account, l.cost_center);
    if (l.debit < 0 || l.credit < 0) throw httpError(400, 'Debit and credit amounts cannot be negative');
  }
  const dr = round2(posted.reduce((s, l) => s + l.debit, 0));
  const cr = round2(posted.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.001) throw httpError(400, `Journal does not balance: debits ${dr.toFixed(2)} vs credits ${cr.toFixed(2)}`);

  const info = db
    .prepare('INSERT INTO journals (journal_date, period, reference, description, source_type, source_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(journal_date, period, reference || null, description, source_type, source_id ?? null);
  const journalId = Number(info.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO ledger_entries (journal_id, entry_date, account_code, debit, credit, currency, fx_note, description, cost_center)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const l of posted) {
    insert.run(journalId, journal_date, l.account_code, l.debit, l.credit, l.currency || null, l.fx_note || null, l.description || description, l.cost_center);
  }
  return journalId;
}

/**
 * Manual journal entered by the user. Amounts are in the journal's currency
 * and translated to GBP at the given rate; any 1p rounding difference from the
 * translation is absorbed by the largest line so the GBP journal still balances.
 */
function createManualJournal({ journal_date, reference, description, currency, exchange_rate, lines }) {
  const company = getCompany();
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

  return transaction(() => {
    const id = postJournal({
      journal_date,
      reference,
      description: String(description).trim(),
      source_type: 'manual',
      source_id: null,
      lines: baseLines,
    });
    return getJournal(id);
  });
}

function getJournal(id) {
  const j = db.prepare('SELECT * FROM journals WHERE id = ?').get(id);
  if (!j) return null;
  return { ...j, lines: ledgerEntriesForJournal(id) };
}

function ledgerEntriesForJournal(journalId) {
  return db
    .prepare(
      `SELECT l.*, a.name AS account_name FROM ledger_entries l JOIN accounts a ON a.code = l.account_code
       WHERE l.journal_id = ? ORDER BY l.id`
    )
    .all(journalId);
}

function listJournals() {
  return db
    .prepare(
      `SELECT j.*, COALESCE(SUM(l.debit), 0) AS total, COUNT(l.id) AS line_count
       FROM journals j LEFT JOIN ledger_entries l ON l.journal_id = j.id
       GROUP BY j.id ORDER BY j.journal_date DESC, j.id DESC`
    )
    .all()
    .map((j) => ({ ...j, total: round2(j.total) }));
}

function listLedgerEntries() {
  return db
    .prepare(
      `SELECT l.*, a.name AS account_name, j.source_type, j.reference
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id
       ORDER BY l.entry_date, l.id`
    )
    .all();
}

function trialBalance() {
  return db
    .prepare(
      `SELECT l.account_code, a.name AS account_name, a.category, SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code
       GROUP BY l.account_code ORDER BY l.account_code`
    )
    .all()
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
function createInvoice({ type, party_id, invoice_number, invoice_date, currency, exchange_rate, notes, lines }) {
  if (!INVOICE_KIND[type]) throw httpError(400, 'Invoice type must be purchase or sale');
  const company = getCompany();
  const party = getParty(INVOICE_KIND[type], party_id);
  if (!party) throw httpError(400, `Unknown ${INVOICE_KIND[type]}`);
  if (!invoice_number || !invoice_date) throw httpError(400, 'Invoice number and date are required');
  if (!CURRENCIES.includes(currency)) throw httpError(400, 'Unsupported currency');
  exchange_rate = currency === company.base_currency ? 1 : Number(exchange_rate);
  if (!(exchange_rate > 0)) throw httpError(400, 'Exchange rate must be a positive number');
  if (!Array.isArray(lines) || lines.length === 0) throw httpError(400, 'An invoice needs at least one line');

  const parsed = lines.map((l, i) => {
    const net = round2(Number(l.net_amount));
    const vatRate = Number(l.vat_rate ?? 0);
    if (!(net >= 0)) throw httpError(400, `Line ${i + 1}: net amount must be zero or more`);
    if (!(vatRate >= 0 && vatRate <= 100)) throw httpError(400, `Line ${i + 1}: VAT rate must be between 0 and 100`);
    const acc = requireAccount(l.account_code);
    if (acc.role === ROLES.AP || acc.role === ROLES.AR || acc.category === 'cash') {
      throw httpError(400, `Line ${i + 1}: ${acc.code} ${acc.name} can't be used on an invoice line`);
    }
    return {
      description: l.description ? String(l.description).trim() : null,
      account_code: acc.code,
      cost_center: resolveCostCenter(acc, l.cost_center),
      net_amount: net,
      vat_rate: vatRate,
      vat_amount: round2((net * vatRate) / 100),
      base_net: round2(net * exchange_rate),
    };
  });

  const net_amount = round2(parsed.reduce((s, l) => s + l.net_amount, 0));
  const vat_amount = round2(parsed.reduce((s, l) => s + l.vat_amount, 0));
  const total_amount = round2(net_amount + vat_amount);
  const base_net = round2(parsed.reduce((s, l) => s + l.base_net, 0));
  const base_vat = round2(vat_amount * exchange_rate);
  const base_total = round2(base_net + base_vat);
  if (!(total_amount > 0)) throw httpError(400, 'Invoice total must be more than zero');

  return transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO invoices (type, party_id, invoice_number, invoice_date, currency, net_amount, vat_amount, total_amount, exchange_rate, base_net, base_vat, base_total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(type, party_id, invoice_number, invoice_date, currency, net_amount, vat_amount, total_amount, exchange_rate, base_net, base_vat, base_total, notes || null);
    const invoiceId = Number(info.lastInsertRowid);
    const insertLine = db.prepare(
      `INSERT INTO invoice_lines (invoice_id, description, account_code, net_amount, vat_rate, vat_amount, base_net, cost_center)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of parsed) insertLine.run(invoiceId, l.description, l.account_code, l.net_amount, l.vat_rate, l.vat_amount, l.base_net, l.cost_center);

    const isPurchase = type === 'purchase';
    const foreign = currency !== company.base_currency;
    const note = (amt) => (foreign ? `${amt.toFixed(2)} ${currency} @ ${exchange_rate}` : null);
    const desc = `${isPurchase ? 'Purchase' : 'Sales'} invoice ${invoice_number} - ${party.name}`;
    const journalLines = parsed.map((l) => ({
      account_code: l.account_code,
      cost_center: l.cost_center,
      [isPurchase ? 'debit' : 'credit']: l.base_net,
      currency,
      fx_note: note(l.net_amount),
      description: l.description ? `${desc} - ${l.description}` : desc,
    }));
    if (base_vat > 0) {
      journalLines.push({
        account_code: accountByRole(isPurchase ? ROLES.VAT_IN : ROLES.VAT_OUT).code,
        [isPurchase ? 'debit' : 'credit']: base_vat,
        currency,
        fx_note: note(vat_amount),
        description: `${desc} - ${isPurchase ? 'input' : 'output'} VAT`,
      });
    }
    journalLines.push({
      account_code: accountByRole(isPurchase ? ROLES.AP : ROLES.AR).code,
      [isPurchase ? 'credit' : 'debit']: base_total,
      currency,
      fx_note: note(total_amount),
      description: desc,
    });
    postJournal({ journal_date: invoice_date, reference: invoice_number, description: desc, source_type: 'invoice', source_id: invoiceId, lines: journalLines });
    return getInvoice(invoiceId);
  });
}

function invoiceSelect(where) {
  return `SELECT i.*, COALESCE(s.name, c.name) AS party_name
          FROM invoices i
          LEFT JOIN suppliers s ON i.type = 'purchase' AND s.id = i.party_id
          LEFT JOIN customers c ON i.type = 'sale' AND c.id = i.party_id
          ${where}`;
}

function getInvoice(id) {
  const invoice = db.prepare(invoiceSelect('WHERE i.id = ?')).get(id);
  return invoice ? attachComputed(invoice) : null;
}

function listInvoices(type) {
  const rows = type
    ? db.prepare(invoiceSelect('WHERE i.type = ? ORDER BY i.invoice_date DESC, i.id DESC')).all(type)
    : db.prepare(invoiceSelect('ORDER BY i.invoice_date DESC, i.id DESC')).all();
  return rows.map(attachComputed);
}

function attachComputed(invoice) {
  const sums = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS paid, COALESCE(SUM(base_cash), 0) AS paid_base,
              COALESCE(SUM(base_relief), 0) AS relieved, COALESCE(SUM(fx_gain_loss), 0) AS fx
       FROM payments WHERE invoice_id = ?`
    )
    .get(invoice.id);
  const remaining = round2(invoice.total_amount - sums.paid);
  let status = 'Open';
  if (remaining <= 0.005) status = 'Paid';
  else if (sums.paid > 0.005) status = 'Partially Paid';
  return {
    ...invoice,
    paid_amount: round2(sums.paid),
    paid_base: round2(sums.paid_base),
    remaining_amount: remaining,
    // Remaining liability/receivable at the rate it was booked at.
    remaining_base: round2(invoice.base_total - sums.relieved),
    realised_fx: round2(sums.fx),
    status,
  };
}

function invoiceLines(invoiceId) {
  return db
    .prepare(
      `SELECT il.*, a.name AS account_name FROM invoice_lines il JOIN accounts a ON a.code = il.account_code
       WHERE il.invoice_id = ? ORDER BY il.id`
    )
    .all(invoiceId);
}

function invoiceDetail(id) {
  const invoice = getInvoice(id);
  if (!invoice) return null;
  const payments = listPaymentsForInvoice(id);
  const journalIds = [
    ...db.prepare("SELECT id FROM journals WHERE source_type = 'invoice' AND source_id = ?").all(id).map((r) => r.id),
    ...payments.flatMap((p) => db.prepare("SELECT id FROM journals WHERE source_type = 'payment' AND source_id = ?").all(p.id).map((r) => r.id)),
  ];
  return { invoice, lines: invoiceLines(id), payments, ledger: journalIds.flatMap(ledgerEntriesForJournal) };
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
function createPayment({ invoice_id, payment_date, amount, bank_account, bank_amount, bank_rate, notes }) {
  const company = getCompany();
  const invoice = getInvoice(invoice_id);
  if (!invoice) throw httpError(400, 'Unknown invoice');
  if (!payment_date) throw httpError(400, 'Payment date is required');
  const bank = getAccount(bank_account);
  if (!bank || !bank.bank_currency) throw httpError(400, 'Choose a bank account');
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

  return transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO payments (invoice_id, payment_date, amount, bank_account, bank_currency, bank_amount, bank_rate, base_relief, base_cash, fx_gain_loss, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(invoice_id, payment_date, amount, bank.code, bank.bank_currency, bank_amount, bank_rate, base_relief, base_cash, fx_gain_loss, notes || null);
    const paymentId = Number(info.lastInsertRowid);

    const desc = `${isPurchase ? 'Payment' : 'Receipt'} ${amount.toFixed(2)} ${invoice.currency} - ${isPurchase ? 'purchase' : 'sales'} invoice ${invoice.invoice_number} (${invoice.party_name})`;
    const partyAcc = accountByRole(isPurchase ? ROLES.AP : ROLES.AR).code;
    const reliefNote = invoice.currency === company.base_currency ? null : `${amount.toFixed(2)} ${invoice.currency} @ ${invoice.exchange_rate} (booked rate)`;
    const cashNote = bank.bank_currency === company.base_currency ? null : `${bank_amount.toFixed(2)} ${bank.bank_currency} @ ${bank_rate}`;
    const lines = [
      { account_code: partyAcc, [isPurchase ? 'debit' : 'credit']: base_relief, currency: invoice.currency, fx_note: reliefNote, description: desc },
      { account_code: bank.code, [isPurchase ? 'credit' : 'debit']: base_cash, currency: bank.bank_currency, fx_note: cashNote, description: desc },
    ];
    if (fx_gain_loss > 0) {
      lines.push({ account_code: accountByRole(ROLES.FX_GAIN).code, credit: fx_gain_loss, description: `${desc} - FX gain` });
    } else if (fx_gain_loss < 0) {
      lines.push({ account_code: accountByRole(ROLES.FX_LOSS).code, debit: -fx_gain_loss, description: `${desc} - FX loss` });
    }
    const journalId = postJournal({
      journal_date: payment_date,
      reference: invoice.invoice_number,
      description: desc,
      source_type: 'payment',
      source_id: paymentId,
      lines,
    });
    return { payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId), journal_id: journalId, invoice: getInvoice(invoice_id) };
  });
}

function listPaymentsForInvoice(invoice_id) {
  return db
    .prepare(
      `SELECT p.*, a.name AS bank_account_name FROM payments p JOIN accounts a ON a.code = p.bank_account
       WHERE p.invoice_id = ? ORDER BY p.payment_date, p.id`
    )
    .all(invoice_id);
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
function financialStatements({ from, to, cost_center }) {
  checkRange(from, to);

  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.category,
         COALESCE(SUM(CASE WHEN ${OPENING_SQL} THEN l.debit - l.credit END), 0) AS opening,
         COALESCE(SUM(CASE WHEN ${MOVEMENT_SQL} THEN l.debit - l.credit END), 0) AS movement
       FROM accounts a LEFT JOIN ledger_entries l ON l.account_code = a.code LEFT JOIN journals j ON j.id = l.journal_id
       GROUP BY a.code ORDER BY a.code`
    )
    .all(from, to, from, to)
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
      db
        .prepare(
          `SELECT l.account_code AS code, SUM(l.debit - l.credit) AS movement FROM ledger_entries l
           WHERE l.entry_date >= ? AND l.entry_date <= ?${f.sql} GROUP BY l.account_code`
        )
        .all(from, to, ...f.params)
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
function costCenterReport({ from, to }) {
  checkRange(from, to);
  const rows = db
    .prepare(
      `SELECT COALESCE(l.cost_center, '') AS cc, a.category, SUM(l.debit - l.credit) AS movement
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code
       WHERE l.entry_date >= ? AND l.entry_date <= ?
       GROUP BY cc, a.category`
    )
    .all(from, to);
  const plCats = CATEGORIES.filter((c) => c.statement === 'PL');
  const columns = [...listCostCenters().map((c) => ({ code: c.code, name: c.name })), { code: '', name: 'Unallocated' }];
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
function kpis({ from, to }) {
  const fs = financialStatements({ from, to });
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
  const invoiced = (type) =>
    db.prepare('SELECT COALESCE(SUM(base_total), 0) AS t FROM invoices WHERE type = ? AND invoice_date >= ? AND invoice_date <= ?').get(type, from, to).t;
  const salesInvoiced = invoiced('sale');
  const purchasesInvoiced = invoiced('purchase');

  // Monthly trend
  const monthRows = db
    .prepare(
      `SELECT substr(l.entry_date, 1, 7) AS period, a.category, SUM(l.debit - l.credit) AS movement
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id
       WHERE ${MOVEMENT_SQL}
       GROUP BY period, a.category`
    )
    .all(from, to);
  const cashBefore = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS t FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id
       WHERE a.category = 'cash' AND ${OPENING_SQL}`
    )
    .get(from, to).t;
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
  const ccReport = costCenterReport({ from, to });
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
      (pl.financial_income.accounts.find((a) => a.code === accountByRole(ROLES.FX_GAIN).code)?.amount || 0) -
        (pl.financial_expenses.accounts.find((a) => a.code === accountByRole(ROLES.FX_LOSS).code)?.amount || 0)
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

// ---------- Dashboard ----------

function dashboardSummary() {
  const company = getCompany();
  const invoices = listInvoices();
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
  const tb = trialBalance();
  const tbDebit = round2(tb.reduce((s, r) => s + r.debit, 0));
  const tbCredit = round2(tb.reduce((s, r) => s + r.credit, 0));
  const cash = round2(tb.filter((r) => r.category === 'cash').reduce((s, r) => s + r.balance, 0));
  const realisedFx = db.prepare('SELECT COALESCE(SUM(fx_gain_loss), 0) AS t FROM payments').get().t;
  return {
    company,
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
