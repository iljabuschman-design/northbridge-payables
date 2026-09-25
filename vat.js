'use strict';

/**
 * UK VAT returns (the nine boxes) per entity, in the shape HMRC's Making Tax
 * Digital API expects (POST /organisations/vat/{vrn}/returns).
 *
 * The boxes are worked out from the invoices dated in the period (accrual
 * basis), in GBP at each invoice's booked rate:
 *   1  VAT due on sales                   output VAT on sales invoices
 *   2  VAT due on acquisitions            0 (Northern Ireland only since Brexit)
 *   3  Total VAT due                      1 + 2
 *   4  VAT reclaimed on purchases         input VAT on purchase invoices
 *   5  Net VAT to pay or reclaim          |3 - 4|
 *   6  Total sales excluding VAT          whole pounds
 *   7  Total purchases excluding VAT      whole pounds
 *   8  Goods supplied to the EU           0 (Northern Ireland only)
 *   9  Goods acquired from the EU         0 (Northern Ireland only)
 * VAT booked on the VAT ledgers by other journals (not invoices) isn't in
 * the return; the difference is reported so it can be checked.
 *
 * "Filing" stores the return and its figures; the MTD request body can then be
 * downloaded. Submitting it to HMRC needs the app to be registered with HMRC
 * (OAuth sign-in to the business's Government Gateway account and fraud
 * prevention headers), which is not part of this demo.
 */

const { db, round2 } = require('./db');
const acct = require('./accounting');

const { httpError, ROLES } = acct;

const BOXES = [
  ['vat_due_sales', 'vatDueSales'],
  ['vat_due_acquisitions', 'vatDueAcquisitions'],
  ['total_vat_due', 'totalVatDue'],
  ['vat_reclaimed', 'vatReclaimedCurrPeriod'],
  ['net_vat_due', 'netVatDue'],
  ['total_sales_ex_vat', 'totalValueSalesExVAT'],
  ['total_purchases_ex_vat', 'totalValuePurchasesExVAT'],
  ['total_goods_supplied_ex_vat', 'totalValueGoodsSuppliedExVAT'],
  ['total_acquisitions_ex_vat', 'totalAcquisitionsExVAT'],
];

// Boxes 6-9 are in whole pounds; HMRC lets you leave out the pence.
const pounds = (n) => Math.trunc(round2(n));

/** Due date: one calendar month and seven days after the end of the period. */
function dueDate(periodEnd) {
  const [y, m] = periodEnd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m + 1, 0)); // last day of the following month
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function checkPeriod(from, to) {
  if (!/^\d{4}-\d{2}-01$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw httpError(400, 'Choose the first and last month of the VAT period');
  if (to !== acct.periodBounds(to.slice(0, 7)).end_date) throw httpError(400, 'A VAT period ends on the last day of a month');
  if (from > to) throw httpError(400, '"From" must be before "to"');
}

/** The nine boxes for an entity and period, plus what they were built from. */
async function calculate({ entity_id, from, to }) {
  const entity = await acct.requireEntity(entity_id);
  checkPeriod(from, to);

  const sums = async (type) =>
    db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(base_net), 0) AS net, COALESCE(SUM(base_vat), 0) AS vat
       FROM invoices WHERE entity_id = ? AND type = ? AND invoice_date >= ? AND invoice_date <= ?`,
      entity.id, type, from, to
    );
  const sales = await sums('sale');
  const purchases = await sums('purchase');

  const boxes = {
    vat_due_sales: round2(sales.vat),
    vat_due_acquisitions: 0,
    vat_reclaimed: round2(purchases.vat),
    total_sales_ex_vat: pounds(sales.net),
    total_purchases_ex_vat: pounds(purchases.net),
    total_goods_supplied_ex_vat: 0,
    total_acquisitions_ex_vat: 0,
  };
  boxes.total_vat_due = round2(boxes.vat_due_sales + boxes.vat_due_acquisitions);
  boxes.net_vat_due = round2(Math.abs(boxes.total_vat_due - boxes.vat_reclaimed));

  // What the VAT ledgers moved in the period, to spot VAT booked outside invoices.
  const ledger = async (role, sign) => {
    const code = (await acct.accountByRole(role)).code;
    const r = await db.get(
      'SELECT COALESCE(SUM(debit - credit), 0) AS t FROM ledger_entries WHERE account_code = ? AND entity_id = ? AND entry_date >= ? AND entry_date <= ?',
      code, entity.id, from, to
    );
    return { code, amount: round2(sign * r.t) };
  };
  const outLedger = await ledger(ROLES.VAT_OUT, -1);
  const inLedger = await ledger(ROLES.VAT_IN, 1);

  return {
    entity,
    from,
    to,
    due_date: dueDate(to),
    boxes,
    to_pay: boxes.total_vat_due >= boxes.vat_reclaimed,
    sales_invoices: sales.n,
    purchase_invoices: purchases.n,
    ledger_check: {
      output: { ...outLedger, difference: round2(outLedger.amount - boxes.vat_due_sales) },
      input: { ...inLedger, difference: round2(inLedger.amount - boxes.vat_reclaimed) },
    },
  };
}

/** The request body for HMRC's MTD "submit VAT return" endpoint. */
function mtdBody(ret) {
  return {
    periodKey: ret.period_key,
    ...Object.fromEntries(BOXES.map(([col, key]) => [key, ret[col]])),
    finalised: true,
  };
}

async function listReturns(entityId) {
  const E = acct.entityOf(entityId);
  const rows = await db.all(
    `SELECT v.*, e.code AS entity_code, e.name AS entity_name FROM vat_returns v JOIN entities e ON e.id = v.entity_id
     WHERE (?::int IS NULL OR v.entity_id = ?) ORDER BY v.period_start DESC, v.id DESC`,
    E, E
  );
  // Flag returns whose figures no longer match the books (something was booked or changed afterwards).
  for (const r of rows) {
    const now = await calculate({ entity_id: r.entity_id, from: r.period_start, to: r.period_end });
    r.due_date = dueDate(r.period_end);
    r.changed_since_filing = BOXES.some(([col]) => now.boxes[col] !== r[col]);
  }
  return rows;
}

async function getReturn(id) {
  const r = await db.get('SELECT v.*, e.name AS entity_name FROM vat_returns v JOIN entities e ON e.id = v.entity_id WHERE v.id = ?', Number(id));
  if (!r) throw httpError(404, 'VAT return not found');
  return r;
}

/**
 * File a return: store the figures as calculated now. A period can be filed
 * once per entity; corrections go on a later return (or to HMRC separately).
 */
async function fileReturn({ entity_id, from, to, vrn, period_key, declaration }, filedBy) {
  vrn = String(vrn || '').replace(/\s+/g, '').replace(/^GB/i, '');
  if (!/^\d{9}$/.test(vrn)) throw httpError(400, 'A VAT registration number has 9 digits');
  period_key = String(period_key || '').trim().toUpperCase();
  if (!/^[A-Z0-9#]{4}$/.test(period_key)) throw httpError(400, 'The HMRC period key has 4 characters (e.g. 26A2): find it in the business tax account under VAT obligations');
  if (!declaration) throw httpError(400, 'Confirm the declaration before filing');

  const c = await calculate({ entity_id, from, to });
  const overlap = await db.get(
    'SELECT period_start, period_end FROM vat_returns WHERE entity_id = ? AND period_start <= ? AND period_end >= ?',
    c.entity.id, to, from
  );
  if (overlap) throw httpError(400, `A VAT return for ${overlap.period_start} to ${overlap.period_end} is already filed for ${c.entity.name}`);
  if (await db.get('SELECT 1 FROM vat_returns WHERE vrn = ? AND period_key = ?', vrn, period_key)) {
    throw httpError(400, `Period key ${period_key} is already filed for VAT number ${vrn}`);
  }

  const cols = BOXES.map(([col]) => col);
  const info = await db.run(
    `INSERT INTO vat_returns (entity_id, vrn, period_key, period_start, period_end, ${cols.join(', ')}, filed_by)
     VALUES (?, ?, ?, ?, ?, ${cols.map(() => '?').join(', ')}, ?)`,
    c.entity.id, vrn, period_key, from, to, ...cols.map((col) => c.boxes[col]), filedBy || null
  );
  return getReturn(info.lastInsertRowid);
}

async function mtdExport(id) {
  const r = await getReturn(id);
  return {
    filename: `vat-return-${r.vrn}-${r.period_key.replace('#', '_')}.json`,
    endpoint: `POST https://api.service.hmrc.gov.uk/organisations/vat/${r.vrn}/returns`,
    body: mtdBody(r),
  };
}

module.exports = { calculate, listReturns, getReturn, fileReturn, mtdExport, dueDate };
