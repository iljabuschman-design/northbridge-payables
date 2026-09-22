'use strict';

const { db, round2 } = require('./db');

const ACCOUNTS = {
  PURCHASES: 'Purchases (Expense)',
  VAT_RECOVERABLE: 'VAT Recoverable (Input VAT)',
  ACCOUNTS_PAYABLE: 'Accounts Payable',
  FX_GAIN: 'Realised FX Gain',
  FX_LOSS: 'Realised FX Loss',
  bank(currency) {
    return `Bank - ${currency}`;
  },
};

function getCompany() {
  const row = db.prepare('SELECT * FROM company WHERE id = 1').get();
  return row;
}

function insertLedgerEntry({ entry_date, account, debit = 0, credit = 0, currency = null, fx_note = null, description, source_type, source_id }) {
  db.prepare(
    `INSERT INTO ledger_entries (entry_date, account, debit, credit, currency, fx_note, description, source_type, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entry_date, account, round2(debit), round2(credit), currency, fx_note, description, source_type, source_id);
}

function getSupplier(id) {
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

function listSuppliers() {
  return db.prepare('SELECT * FROM suppliers ORDER BY name').all();
}

function createSupplier({ name, country, currency, vat_number }) {
  const info = db
    .prepare('INSERT INTO suppliers (name, country, currency, vat_number) VALUES (?, ?, ?, ?)')
    .run(name, country || null, currency, vat_number || null);
  return getSupplier(Number(info.lastInsertRowid));
}

/**
 * Create a supplier invoice and post the corresponding journal entry:
 *   Dr Purchases            base_net
 *   Dr VAT Recoverable      base_vat
 *   Cr Accounts Payable     base_total
 * base_total is derived as base_net + base_vat (not independently rounded)
 * so the entry always balances exactly, even after 2dp rounding.
 */
function createInvoice({ supplier_id, invoice_number, invoice_date, currency, net_amount, vat_amount, exchange_rate, notes }) {
  const company = getCompany();
  const supplier = getSupplier(supplier_id);
  if (!supplier) throw httpError(400, 'Unknown supplier');
  if (!invoice_number || !invoice_date) throw httpError(400, 'Invoice number and date are required');
  if (!['GBP', 'EUR', 'USD'].includes(currency)) throw httpError(400, 'Unsupported currency');
  net_amount = Number(net_amount);
  vat_amount = Number(vat_amount);
  exchange_rate = Number(exchange_rate);
  if (!(net_amount >= 0) || !(vat_amount >= 0)) throw httpError(400, 'Net and VAT amounts must be non-negative numbers');
  if (!(exchange_rate > 0)) throw httpError(400, 'Exchange rate must be a positive number');
  if (currency === company.base_currency && exchange_rate !== 1) {
    exchange_rate = 1; // base currency always translates 1:1
  }

  const total_amount = round2(net_amount + vat_amount);
  const base_net = round2(net_amount * exchange_rate);
  const base_vat = round2(vat_amount * exchange_rate);
  const base_total = round2(base_net + base_vat);

  const info = db
    .prepare(
      `INSERT INTO invoices (supplier_id, invoice_number, invoice_date, currency, net_amount, vat_amount, total_amount, exchange_rate, base_net, base_vat, base_total, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(supplier_id, invoice_number, invoice_date, currency, net_amount, vat_amount, total_amount, exchange_rate, base_net, base_vat, base_total, notes || null);
  const invoiceId = Number(info.lastInsertRowid);

  const desc = `Invoice ${invoice_number} - ${supplier.name}`;
  insertLedgerEntry({
    entry_date: invoice_date,
    account: ACCOUNTS.PURCHASES,
    debit: base_net,
    currency,
    fx_note: currency === company.base_currency ? null : `${net_amount.toFixed(2)} ${currency} @ ${exchange_rate}`,
    description: desc,
    source_type: 'invoice',
    source_id: invoiceId,
  });
  if (base_vat > 0) {
    insertLedgerEntry({
      entry_date: invoice_date,
      account: ACCOUNTS.VAT_RECOVERABLE,
      debit: base_vat,
      currency,
      fx_note: currency === company.base_currency ? null : `${vat_amount.toFixed(2)} ${currency} @ ${exchange_rate}`,
      description: `${desc} - input VAT`,
      source_type: 'invoice',
      source_id: invoiceId,
    });
  }
  insertLedgerEntry({
    entry_date: invoice_date,
    account: ACCOUNTS.ACCOUNTS_PAYABLE,
    credit: base_total,
    currency,
    fx_note: currency === company.base_currency ? null : `${total_amount.toFixed(2)} ${currency} @ ${exchange_rate}`,
    description: desc,
    source_type: 'invoice',
    source_id: invoiceId,
  });

  return getInvoice(invoiceId);
}

function getInvoice(id) {
  const invoice = db
    .prepare(
      `SELECT i.*, s.name AS supplier_name, s.currency AS supplier_currency, s.country AS supplier_country
       FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?`
    )
    .get(id);
  if (!invoice) return null;
  return attachComputed(invoice);
}

function attachComputed(invoice) {
  const paid = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = ?')
    .get(invoice.id).total;
  const paidBase = db
    .prepare('SELECT COALESCE(SUM(base_cash), 0) AS total FROM payments WHERE invoice_id = ?')
    .get(invoice.id).total;
  const fxTotal = db
    .prepare('SELECT COALESCE(SUM(fx_gain_loss), 0) AS total FROM payments WHERE invoice_id = ?')
    .get(invoice.id).total;
  const remaining = round2(invoice.total_amount - paid);
  const remaining_base = round2(remaining * invoice.exchange_rate);
  let status = 'Open';
  if (remaining <= 0.005) status = 'Paid';
  else if (paid > 0.005) status = 'Partially Paid';
  return {
    ...invoice,
    paid_amount: round2(paid),
    paid_base: round2(paidBase),
    remaining_amount: remaining,
    remaining_base,
    realised_fx: round2(fxTotal),
    status,
  };
}

function listInvoices() {
  const rows = db
    .prepare(
      `SELECT i.*, s.name AS supplier_name, s.currency AS supplier_currency, s.country AS supplier_country
       FROM invoices i JOIN suppliers s ON s.id = i.supplier_id ORDER BY i.invoice_date DESC, i.id DESC`
    )
    .all();
  return rows.map(attachComputed);
}

/**
 * Record a (full or partial) payment against an invoice and post:
 *   Dr Accounts Payable   amount * invoice.exchange_rate   (relieves the liability at its original booked rate)
 *   Cr Bank - <currency>  amount * payment exchange_rate   (actual base-currency cash effect)
 *   Dr/Cr Realised FX Loss/Gain for the difference, so the entry always balances exactly.
 */
function createPayment({ invoice_id, payment_date, amount, exchange_rate, notes }) {
  const invoice = getInvoice(invoice_id);
  if (!invoice) throw httpError(400, 'Unknown invoice');
  if (!payment_date) throw httpError(400, 'Payment date is required');
  amount = Number(amount);
  exchange_rate = Number(exchange_rate);
  if (!(amount > 0)) throw httpError(400, 'Payment amount must be a positive number');
  if (!(exchange_rate > 0)) throw httpError(400, 'Exchange rate must be a positive number');
  const company = getCompany();
  if (invoice.currency === company.base_currency && exchange_rate !== 1) exchange_rate = 1;
  if (amount > invoice.remaining_amount + 0.01) {
    throw httpError(400, `Payment of ${amount.toFixed(2)} ${invoice.currency} exceeds remaining balance of ${invoice.remaining_amount.toFixed(2)} ${invoice.currency}`);
  }

  const base_ap_relief = round2(amount * invoice.exchange_rate);
  const base_cash = round2(amount * exchange_rate);
  const fx_gain_loss = round2(base_ap_relief - base_cash);

  const info = db
    .prepare(
      `INSERT INTO payments (invoice_id, payment_date, amount, exchange_rate, base_ap_relief, base_cash, fx_gain_loss, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(invoice_id, payment_date, amount, exchange_rate, base_ap_relief, base_cash, fx_gain_loss, notes || null);
  const paymentId = Number(info.lastInsertRowid);

  const desc = `Payment ${amount.toFixed(2)} ${invoice.currency} - Invoice ${invoice.invoice_number} (${invoice.supplier_name})`;
  const rateNote =
    invoice.currency === company.base_currency
      ? null
      : `${amount.toFixed(2)} ${invoice.currency} @ ${exchange_rate} (booked @ ${invoice.exchange_rate})`;

  insertLedgerEntry({
    entry_date: payment_date,
    account: ACCOUNTS.ACCOUNTS_PAYABLE,
    debit: base_ap_relief,
    currency: invoice.currency,
    fx_note: rateNote,
    description: desc,
    source_type: 'payment',
    source_id: paymentId,
  });
  insertLedgerEntry({
    entry_date: payment_date,
    account: ACCOUNTS.bank(invoice.currency),
    credit: base_cash,
    currency: invoice.currency,
    fx_note: rateNote,
    description: desc,
    source_type: 'payment',
    source_id: paymentId,
  });
  if (fx_gain_loss > 0.001) {
    insertLedgerEntry({
      entry_date: payment_date,
      account: ACCOUNTS.FX_GAIN,
      credit: fx_gain_loss,
      currency: invoice.currency,
      fx_note: `Rate moved ${invoice.exchange_rate} -> ${exchange_rate}`,
      description: `${desc} - FX gain on settlement`,
      source_type: 'payment',
      source_id: paymentId,
    });
  } else if (fx_gain_loss < -0.001) {
    insertLedgerEntry({
      entry_date: payment_date,
      account: ACCOUNTS.FX_LOSS,
      debit: -fx_gain_loss,
      currency: invoice.currency,
      fx_note: `Rate moved ${invoice.exchange_rate} -> ${exchange_rate}`,
      description: `${desc} - FX loss on settlement`,
      source_type: 'payment',
      source_id: paymentId,
    });
  }

  return { payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId), invoice: getInvoice(invoice_id) };
}

function listPaymentsForInvoice(invoice_id) {
  return db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date, id').all(invoice_id);
}

function listLedgerEntries({ source_type, source_id } = {}) {
  if (source_type && source_id) {
    return db
      .prepare('SELECT * FROM ledger_entries WHERE source_type = ? AND source_id = ? ORDER BY id')
      .all(source_type, source_id);
  }
  return db.prepare('SELECT * FROM ledger_entries ORDER BY entry_date, id').all();
}

function trialBalance() {
  const rows = db
    .prepare(
      `SELECT account, SUM(debit) AS debit, SUM(credit) AS credit
       FROM ledger_entries GROUP BY account ORDER BY account`
    )
    .all();
  return rows.map((r) => ({ account: r.account, debit: round2(r.debit), credit: round2(r.credit), balance: round2(r.debit - r.credit) }));
}

function dashboardSummary() {
  const company = getCompany();
  const invoices = listInvoices();
  const open = invoices.filter((i) => i.status !== 'Paid');
  const byCurrency = {};
  for (const cur of ['GBP', 'EUR', 'USD']) {
    byCurrency[cur] = { outstanding_foreign: 0, outstanding_base: 0, open_invoices: 0, invoiced_total_foreign: 0 };
  }
  for (const inv of open) {
    byCurrency[inv.currency].outstanding_foreign = round2(byCurrency[inv.currency].outstanding_foreign + inv.remaining_amount);
    byCurrency[inv.currency].outstanding_base = round2(byCurrency[inv.currency].outstanding_base + inv.remaining_base);
    byCurrency[inv.currency].open_invoices += 1;
  }
  for (const inv of invoices) {
    byCurrency[inv.currency].invoiced_total_foreign = round2(byCurrency[inv.currency].invoiced_total_foreign + inv.total_amount);
  }
  const totalOutstandingBase = round2(open.reduce((s, i) => s + i.remaining_base, 0));
  const realisedFx = db.prepare('SELECT COALESCE(SUM(fx_gain_loss),0) AS t FROM payments').get().t;
  const tb = trialBalance();
  const tbDebit = round2(tb.reduce((s, r) => s + r.debit, 0));
  const tbCredit = round2(tb.reduce((s, r) => s + r.credit, 0));
  return {
    company,
    total_invoices: invoices.length,
    open_invoices: open.length,
    total_outstanding_base: totalOutstandingBase,
    realised_fx_total: round2(realisedFx),
    by_currency: byCurrency,
    trial_balance: tb,
    trial_balance_balanced: Math.abs(tbDebit - tbCredit) < 0.01,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  ACCOUNTS,
  getCompany,
  listSuppliers,
  createSupplier,
  getSupplier,
  createInvoice,
  getInvoice,
  listInvoices,
  createPayment,
  listPaymentsForInvoice,
  listLedgerEntries,
  trialBalance,
  dashboardSummary,
  httpError,
};

