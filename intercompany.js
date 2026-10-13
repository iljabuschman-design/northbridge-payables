'use strict';

/**
 * Intercompany reconciliation.
 *
 * Every ledger entry that is with another group company carries that company
 * as its counterparty (set automatically on invoices and payments to/from a
 * customer or supplier that is a group company, and per line on journals).
 * Seen from both companies of a pair the same transaction must mirror:
 *
 *   P&L            what A earned from B equals what B spent with A, so the
 *                  group result is not affected: (A income + B income) -
 *                  (A expense + B expense) = 0.
 *   Balance sheet  what A is owed by B equals what B owes A (trade balances,
 *                  loans, accrued interest) and A's investment equals B's
 *                  share capital held by A: A balance + B balance = 0.
 *
 * Differences above the tolerance are exceptions to be explained and booked.
 * The invoice list compares each intercompany sales invoice with the matching
 * purchase invoice of the other company (same invoice number).
 */

const { db, round2 } = require('./db');
const acct = require('./accounting');

const { httpError, CATEGORY_BY_KEY } = acct;

const DEFAULT_TOLERANCE = 1; // GBP: rounding differences up to this are not exceptions

// Intercompany P&L is compared per kind of flow, the balance sheet per kind of balance.
const PL_GROUPS = [
  { key: 'operating', name: 'Intercompany revenue and costs', categories: ['revenue', 'cost_of_sales', 'overheads', 'depreciation'] },
  { key: 'financing', name: 'Intercompany interest', categories: ['financial_income', 'financial_expenses'] },
];
const BS_GROUPS = [
  { key: 'trade', name: 'Trade receivables / payables', categories: ['receivables', 'payables'] },
  { key: 'loans', name: 'Loans', categories: ['financial_assets', 'long_term_liabilities'] },
  { key: 'accruals', name: 'Accrued interest and other', categories: ['other_current_assets', 'other_current_liabilities', 'cash', 'inventory'] },
  { key: 'capital', name: 'Investments and share capital', categories: ['fixed_assets', 'accumulated_depreciation', 'equity'] },
];

const groupOf = (groups, category) => groups.find((g) => g.categories.includes(category));
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function checkDates(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw httpError(400, 'from and to must be dates (YYYY-MM-DD)');
  if (from > to) throw httpError(400, '"From" date must be before "to" date');
}

/** Tagged ledger entries, summed per entity, counterparty and reporting category. */
async function taggedBalances(from, to) {
  // P&L: movement within the period. The opening journal is never a movement.
  const pl = await db.all(
    `SELECT l.entity_id, l.counterparty_entity_id AS cp, a.category, SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id
      WHERE l.counterparty_entity_id IS NOT NULL AND l.entry_date >= ? AND l.entry_date <= ? AND j.source_type <> 'opening'
      GROUP BY l.entity_id, l.counterparty_entity_id, a.category`,
    from, to
  );
  // Balance sheet: cumulative position at the end of the period.
  const bs = await db.all(
    `SELECT l.entity_id, l.counterparty_entity_id AS cp, a.category, SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code
      WHERE l.counterparty_entity_id IS NOT NULL AND l.entry_date <= ?
      GROUP BY l.entity_id, l.counterparty_entity_id, a.category`,
    to
  );
  return {
    pl: pl.filter((r) => CATEGORY_BY_KEY[r.category] && CATEGORY_BY_KEY[r.category].statement === 'PL'),
    bs: bs.filter((r) => CATEGORY_BY_KEY[r.category] && CATEGORY_BY_KEY[r.category].statement === 'BS'),
  };
}

/** Intercompany invoices of both sides, matched on the invoice number between the two companies. */
async function matchInvoices(from, to, tolerance) {
  const rows = await db.all(
    `SELECT i.id, i.type, i.entity_id, i.invoice_number, i.invoice_date, i.currency, i.net_amount, i.total_amount, i.exchange_rate,
            i.base_net, i.base_total, COALESCE(s.group_entity_id, c.group_entity_id) AS other_id
       FROM invoices i
       LEFT JOIN suppliers s ON i.type = 'purchase' AND s.id = i.party_id
       LEFT JOIN customers c ON i.type = 'sale' AND c.id = i.party_id
      WHERE COALESCE(s.group_entity_id, c.group_entity_id) IS NOT NULL
      ORDER BY i.invoice_date, i.id`
  );
  const sales = rows.filter((r) => r.type === 'sale');
  const purchases = rows.filter((r) => r.type === 'purchase');
  const used = new Set();
  const out = [];
  const period = (d) => String(d).slice(0, 7);
  const inRange = (d) => d >= from && d <= to;

  for (const s of sales) {
    // Seller = s.entity_id, buyer = the customer's group company.
    const p = purchases.find((x) => !used.has(x.id) && x.entity_id === s.other_id && x.other_id === s.entity_id && x.invoice_number === s.invoice_number);
    if (p) used.add(p.id);
    out.push(buildMatch(s, p, tolerance, period));
  }
  for (const p of purchases) {
    if (used.has(p.id)) continue;
    out.push(buildMatch(null, p, tolerance, period));
  }
  return out
    .filter((m) => inRange(m.seller_date || '') || inRange(m.buyer_date || ''))
    .sort((a, b) => (a.status === 'matched') - (b.status === 'matched') || (a.seller_date || a.buyer_date).localeCompare(b.seller_date || b.buyer_date));
}

function buildMatch(s, p, tolerance, period) {
  const base = {
    invoice_number: (s || p).invoice_number,
    seller_entity_id: s ? s.entity_id : p.other_id,
    buyer_entity_id: s ? s.other_id : p.entity_id,
    seller_invoice_id: s ? s.id : null,
    buyer_invoice_id: p ? p.id : null,
    seller_date: s ? s.invoice_date : null,
    buyer_date: p ? p.invoice_date : null,
    seller_currency: s ? s.currency : null,
    buyer_currency: p ? p.currency : null,
    seller_net: s ? s.net_amount : null,
    buyer_net: p ? p.net_amount : null,
    seller_rate: s ? s.exchange_rate : null,
    buyer_rate: p ? p.exchange_rate : null,
    seller_base_net: s ? s.base_net : null,
    buyer_base_net: p ? p.base_net : null,
  };
  let status;
  let note;
  let difference = 0;
  if (!s) {
    status = 'missing_seller';
    note = 'Booked by the buyer, but the selling company has not booked a sales invoice';
    difference = -p.base_net;
  } else if (!p) {
    status = 'missing_buyer';
    note = 'Booked by the seller, but the buying company has not booked a purchase invoice';
    difference = s.base_net;
  } else {
    difference = round2(s.base_net - p.base_net);
    const sameCurrency = s.currency === p.currency;
    const sameForeign = sameCurrency && Math.abs(s.net_amount - p.net_amount) <= 0.005;
    if (Math.abs(difference) <= tolerance && period(s.invoice_date) === period(p.invoice_date)) {
      status = 'matched';
      note = difference ? 'Rounding difference within tolerance' : 'Both sides agree';
    } else if (Math.abs(difference) <= tolerance) {
      status = 'period';
      note = `Same amount, booked in different periods (${period(s.invoice_date)} by the seller, ${period(p.invoice_date)} by the buyer)`;
    } else if (sameForeign && Math.abs(s.exchange_rate - p.exchange_rate) > 1e-9) {
      status = 'fx';
      note = `Same ${s.currency} amount, booked at different rates (${s.exchange_rate} vs ${p.exchange_rate})`;
    } else {
      status = 'amount';
      note = sameCurrency ? 'The invoice amounts differ between the two companies' : 'The currencies and amounts differ between the two companies';
    }
  }
  return { ...base, status, note, difference: round2(difference) };
}

const STATUS_LABEL = {
  matched: 'Matched',
  period: 'Different period',
  fx: 'Exchange rate differs',
  amount: 'Amount differs',
  missing_buyer: 'Not booked by buyer',
  missing_seller: 'Not booked by seller',
};

async function reconciliation({ from, to, tolerance }) {
  checkDates(from, to);
  const tol = tolerance === undefined || tolerance === null || tolerance === '' ? DEFAULT_TOLERANCE : Math.max(0, Number(tolerance) || 0);
  const entities = await acct.listEntities();
  const byId = Object.fromEntries(entities.map((e) => [e.id, e]));
  const tagged = await taggedBalances(from, to);

  // ----- Per pair of companies -----
  const pairs = {};
  const pair = (a, b) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = pairKey(a, b);
    if (!pairs[key]) {
      pairs[key] = {
        a_id: x,
        b_id: y,
        a_code: byId[x] ? byId[x].code : '',
        b_code: byId[y] ? byId[y].code : '',
        pl: Object.fromEntries(PL_GROUPS.map((g) => [g.key, { a_income: 0, a_expense: 0, b_income: 0, b_expense: 0 }])),
        bs: Object.fromEntries(BS_GROUPS.map((g) => [g.key, { a: 0, b: 0 }])),
      };
    }
    return pairs[key];
  };
  for (const r of tagged.pl) {
    const g = groupOf(PL_GROUPS, r.category);
    if (!g) continue;
    const p = pair(r.entity_id, r.cp);
    const side = r.entity_id === p.a_id ? 'a' : 'b';
    // Natural sign: income is credit less debit, an expense is debit less credit.
    const cat = CATEGORY_BY_KEY[r.category];
    if (cat.side === 'income') p.pl[g.key][`${side}_income`] += r.credit - r.debit;
    else p.pl[g.key][`${side}_expense`] += r.debit - r.credit;
  }
  for (const r of tagged.bs) {
    const g = groupOf(BS_GROUPS, r.category);
    if (!g) continue;
    const p = pair(r.entity_id, r.cp);
    const side = r.entity_id === p.a_id ? 'a' : 'b';
    p.bs[g.key][side] += r.debit - r.credit; // debit-positive: receivable / asset
  }

  const matches = await matchInvoices(from, to, tol);
  const issuesByPair = {};
  for (const m of matches) {
    if (m.status === 'matched') continue;
    const k = pairKey(m.seller_entity_id, m.buyer_entity_id);
    (issuesByPair[k] = issuesByPair[k] || []).push(m);
  }

  const result = [];
  for (const p of Object.values(pairs)) {
    const pl = PL_GROUPS.map((g) => {
      const v = p.pl[g.key];
      const income = round2(v.a_income + v.b_income);
      const expense = round2(v.a_expense + v.b_expense);
      const difference = round2(income - expense);
      return {
        key: g.key,
        name: g.name,
        a_income: round2(v.a_income),
        a_expense: round2(v.a_expense),
        b_income: round2(v.b_income),
        b_expense: round2(v.b_expense),
        income,
        expense,
        difference,
        ok: Math.abs(difference) <= tol,
      };
    }).filter((g) => g.income !== 0 || g.expense !== 0);
    const bs = BS_GROUPS.map((g) => {
      const v = p.bs[g.key];
      const difference = round2(v.a + v.b);
      return { key: g.key, name: g.name, a: round2(v.a), b: round2(v.b), difference, ok: Math.abs(difference) <= tol };
    }).filter((g) => g.a !== 0 || g.b !== 0);
    if (!pl.length && !bs.length) continue;
    result.push({
      a_id: p.a_id,
      b_id: p.b_id,
      a_code: p.a_code,
      b_code: p.b_code,
      a_name: byId[p.a_id] ? byId[p.a_id].name : '',
      b_name: byId[p.b_id] ? byId[p.b_id].name : '',
      pl,
      bs,
      pl_difference: round2(pl.reduce((t, g) => t + g.difference, 0)),
      bs_difference: round2(bs.reduce((t, g) => t + g.difference, 0)),
      issues: (issuesByPair[pairKey(p.a_id, p.b_id)] || []).length,
      ok: pl.every((g) => g.ok) && bs.every((g) => g.ok),
    });
  }
  result.sort((x, y) => x.a_code.localeCompare(y.a_code) || x.b_code.localeCompare(y.b_code));

  // ----- Checks -----
  const sum = (list, f) => round2(list.reduce((t, x) => t + f(x), 0));
  const groupDiff = (kind, key) => sum(result, (p) => sum(p[kind].filter((g) => g.key === key), (g) => g.difference));
  const groupBad = (kind, key) => result.reduce((n, p) => n + p[kind].filter((g) => g.key === key && !g.ok).length, 0);
  const groupTotal = (kind, key, field) => sum(result, (p) => sum(p[kind].filter((g) => g.key === key), (g) => g[field]));

  const unmatched = matches.filter((m) => m.status !== 'matched');
  const statements = await acct.financialStatements({ from, to, entity_id: null, consolidated: true });
  const consolidatedDiff = statements.balance_sheet.closing.intercompany_difference;
  const checks = [
    {
      id: 'pl_operating',
      statement: 'P&L',
      title: 'Intercompany revenue equals intercompany costs',
      detail: `Revenue booked by the selling companies ${fmtGbp(groupTotal('pl', 'operating', 'income'))} against costs booked by the buying companies ${fmtGbp(groupTotal('pl', 'operating', 'expense'))}.`,
      difference: groupDiff('pl', 'operating'),
      exceptions: groupBad('pl', 'operating'),
    },
    {
      id: 'pl_financing',
      statement: 'P&L',
      title: 'Intercompany interest income equals interest expense',
      detail: `Interest income ${fmtGbp(groupTotal('pl', 'financing', 'income'))} against interest expense ${fmtGbp(groupTotal('pl', 'financing', 'expense'))}.`,
      difference: groupDiff('pl', 'financing'),
      exceptions: groupBad('pl', 'financing'),
    },
    {
      id: 'bs_trade',
      statement: 'Balance sheet',
      title: 'Intercompany receivables equal intercompany payables',
      detail: 'Trade balances on intercompany invoices, seen from both companies.',
      difference: groupDiff('bs', 'trade'),
      exceptions: groupBad('bs', 'trade'),
    },
    {
      id: 'bs_loans',
      statement: 'Balance sheet',
      title: 'Intercompany loans agree',
      detail: 'Loans receivable of the lending companies against loans payable of the borrowers.',
      difference: groupDiff('bs', 'loans'),
      exceptions: groupBad('bs', 'loans'),
    },
    {
      id: 'bs_accruals',
      statement: 'Balance sheet',
      title: 'Accrued intercompany interest agrees',
      detail: 'Interest receivable against interest payable.',
      difference: groupDiff('bs', 'accruals'),
      exceptions: groupBad('bs', 'accruals'),
    },
    {
      id: 'bs_capital',
      statement: 'Balance sheet',
      title: 'Investments in subsidiaries equal their share capital held',
      detail: 'The parent’s investment against the share capital of the subsidiary that the parent holds.',
      difference: groupDiff('bs', 'capital'),
      exceptions: groupBad('bs', 'capital'),
    },
    {
      id: 'invoices',
      statement: 'Invoices',
      title: 'Every intercompany invoice is booked on both sides',
      detail: `${matches.length - unmatched.length} of ${matches.length} intercompany invoices in the period agree between seller and buyer.`,
      difference: sum(unmatched, (m) => m.difference),
      exceptions: unmatched.length,
    },
    {
      id: 'consolidated',
      statement: 'Consolidation',
      title: 'The consolidated balance sheet balances after elimination',
      detail: 'Total assets less equity and liabilities of the group once every intercompany entry is eliminated.',
      difference: consolidatedDiff,
      exceptions: Math.abs(consolidatedDiff) > tol ? 1 : 0,
    },
  ].map((c) => ({ ...c, status: c.exceptions === 0 && Math.abs(c.difference) <= tol ? 'ok' : 'exception' }));

  return {
    from,
    to,
    tolerance: tol,
    entities: entities.map((e) => ({ id: e.id, code: e.code, name: e.name })),
    checks,
    pairs: result,
    invoices: matches.map((m) => ({
      ...m,
      seller_code: byId[m.seller_entity_id] ? byId[m.seller_entity_id].code : '',
      buyer_code: byId[m.buyer_entity_id] ? byId[m.buyer_entity_id].code : '',
      status_label: STATUS_LABEL[m.status],
    })),
    summary: {
      pairs: result.length,
      exceptions: checks.reduce((n, c) => n + c.exceptions, 0),
      pl_difference: sum(result, (p) => p.pl_difference),
      bs_difference: sum(result, (p) => p.bs_difference),
      intercompany_invoices: matches.length,
      unmatched_invoices: unmatched.length,
    },
    // Group P&L effect of intercompany: income of both sides less expense of both sides, per pair.
    consolidated: { intercompany_difference: consolidatedDiff },
  };
}

function fmtGbp(n) {
  return `£${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The ledger entries behind one pair of companies (both sides), for drilling down. */
async function pairEntries({ a, b, from, to, section }) {
  checkDates(from, to);
  const A = Number(a);
  const B = Number(b);
  if (!A || !B || A === B) throw httpError(400, 'Choose two different companies');
  const isPl = section === 'pl';
  const when = isPl ? "l.entry_date >= ? AND l.entry_date <= ? AND j.source_type <> 'opening'" : 'l.entry_date <= ?';
  const rows = await db.all(
    `SELECT l.id, l.journal_id, l.entity_id, e.code AS entity_code, l.counterparty_entity_id, l.entry_date, l.account_code, a.name AS account_name, a.category,
            l.debit, l.credit, l.description, j.reference, j.source_type
       FROM ledger_entries l JOIN accounts a ON a.code = l.account_code JOIN journals j ON j.id = l.journal_id JOIN entities e ON e.id = l.entity_id
      WHERE ((l.entity_id = ? AND l.counterparty_entity_id = ?) OR (l.entity_id = ? AND l.counterparty_entity_id = ?))
        AND ${when}
      ORDER BY l.entry_date, l.id`,
    A, B, B, A, ...(isPl ? [from, to] : [to])
  );
  return rows.filter((r) => {
    const cat = CATEGORY_BY_KEY[r.category];
    return cat && cat.statement === (isPl ? 'PL' : 'BS');
  });
}

module.exports = { reconciliation, pairEntries, DEFAULT_TOLERANCE };
