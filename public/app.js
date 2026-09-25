'use strict';

const CCY_SYMBOL = { GBP: '£', EUR: '€', USD: '$' };
const BASE = 'GBP';

let META = { currencies: ['GBP', 'EUR', 'USD'], categories: [] };
let ACCOUNTS = [];
let SUPPLIERS = [];
let CUSTOMERS = [];

const ROLE_LABEL = {
  accounts_payable: 'Purchase invoices (AP)',
  accounts_receivable: 'Sales invoices (AR)',
  vat_recoverable: 'Input VAT',
  vat_payable: 'Output VAT',
  fx_gain: 'FX gains',
  fx_loss: 'FX losses',
};
const SOURCE_LABEL = { manual: 'Manual', invoice: 'Invoice', payment: 'Payment', bank: 'Bank', opening: 'Opening', asset: 'Asset', depreciation: 'Depreciation' };
let COST_CENTERS = [];
let VAT_CODES = [];
let PERIODS = [];

// ---------- Helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmt(n, ccy) {
  const num = Number(n) || 0;
  const sign = num < 0 ? '-' : '';
  const v = Math.abs(num).toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,');
  return `${sign}${ccy ? CCY_SYMBOL[ccy] || ccy + ' ' : ''}${v}`;
}

function round2(n) {
  return Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Selected entity in the top bar ('' = all entities). Every GET is scoped to it.
let CURRENT_ENTITY = '';

async function api(pathname, opts = {}) {
  if (!opts.method && CURRENT_ENTITY && pathname.startsWith('/api/')) {
    pathname += `${pathname.includes('?') ? '&' : '?'}entity=${CURRENT_ENTITY}`;
  }
  const res = await fetch(pathname, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && pathname !== '/api/login') showLogin();
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const post = (pathname, body, method = 'POST') => api(pathname, { method, body: JSON.stringify(body) });

function accountLabel(a) {
  return `${a.code} ${a.name}`;
}

/** An account code + name that opens the account overview. */
function acctLink(code, name) {
  if (!code) return esc(name || '');
  return `<a class="acct-link" href="#account/${encodeURIComponent(code)}">${esc(code)} ${esc(name || '')}</a>`;
}

/** Accounts an entity may post to: shared ones plus its own. */
const forEntity = (entityId) => (a) => !a.entity_id || String(a.entity_id) === String(entityId);

const entityName = (id) => ((META.entities || []).find((e) => String(e.id) === String(id)) || {}).name || '';
const entityCode = (id) => ((META.entities || []).find((e) => String(e.id) === String(id)) || {}).code || '';

/** Fill an entity select in a form; defaults to the entity chosen in the top bar. */
function fillEntityField(select, selected) {
  const value = String(selected || CURRENT_ENTITY || (META.entities[0] || {}).id);
  select.innerHTML = META.entities.map((e) => `<option value="${e.id}" ${String(e.id) === value ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
}

function updateEntityNotes() {
  const note = CURRENT_ENTITY
    ? `Showing ${entityName(CURRENT_ENTITY)}.`
    : 'Showing all entities added together. Intercompany balances, the management fee and Holding’s investment in Trading are not eliminated, so this is not a consolidation.';
  document.querySelectorAll('.entity-note').forEach((el) => (el.textContent = note));
}

function accountOptions(filter = () => true, selected) {
  return ACCOUNTS.filter(filter)
    .map((a) => `<option value="${esc(a.code)}" ${a.code === selected ? 'selected' : ''}>${esc(accountLabel(a))}</option>`)
    .join('');
}

function currencyOptions(selected) {
  return META.currencies.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}

const bankAccounts = () => ACCOUNTS.filter((a) => a.category === 'cash' && a.bank_currency);

const isPlAccount = (code) => (ACCOUNTS.find((a) => a.code === code) || {}).statement === 'PL';

function ccOptions(selected) {
  return (
    '<option value="">-</option>' +
    COST_CENTERS.filter((c) => c.active || c.code === selected)
      .map((c) => `<option value="${esc(c.code)}" ${c.code === selected ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`)
      .join('')
  );
}

/** A cost centre select is only usable next to a P&L account. */
function syncCcSelect(accountSelect, ccSelect) {
  const pl = isPlAccount(accountSelect.value);
  ccSelect.disabled = !pl;
  if (!pl) ccSelect.value = '';
}

async function loadVatCodes() {
  VAT_CODES = await api('/api/vat-codes');
}

function vatCodeOptions(selected) {
  return VAT_CODES.filter((v) => v.active || v.code === selected)
    .map((v) => `<option value="${esc(v.code)}" data-rate="${v.rate}" ${v.code === selected ? 'selected' : ''}>${esc(v.code)} (${v.rate}%)</option>`)
    .join('');
}

/** Default VAT code for a new line: standard rate for GBP, zero rate for foreign-currency invoices. */
function defaultVatCode(currency) {
  const active = VAT_CODES.filter((v) => v.active);
  const pick = currency === BASE ? active.reduce((a, b) => (!a || b.rate > a.rate ? b : a), null) : active.find((v) => v.rate === 0);
  return (pick || active[0] || {}).code || '';
}

async function loadCostCenters() {
  COST_CENTERS = await api('/api/cost-centers');
}

async function loadPeriods() {
  PERIODS = await api('/api/periods');
}

const ccName = (code) => {
  const c = COST_CENTERS.find((x) => x.code === code);
  return c ? `${c.code} ${c.name}` : code || '';
};

const currentPeriod = () => today().slice(0, 7);

/**
 * Fill a from/to pair of period selects. Defaults: from = the first month with
 * postings in the current year, to = the current month.
 */
function fillPeriodSelects(form) {
  const periods = [...PERIODS].sort((a, b) => a.period.localeCompare(b.period));
  const opts = (sel) => periods.map((p) => `<option value="${p.period}" ${p.period === sel ? 'selected' : ''}>${periodLabel(p.period)}</option>`).join('');
  const year = currentPeriod().slice(0, 4);
  const used = periods.filter((p) => p.journal_count > 0 && p.period.startsWith(year));
  const from = form.from.value || (used[0] || periods[0] || {}).period;
  const to = form.to.value || (periods.find((p) => p.period === currentPeriod()) ? currentPeriod() : (periods[periods.length - 1] || {}).period);
  form.from.innerHTML = opts(from);
  form.to.innerHTML = opts(to);
}

function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function periodRange(form) {
  const from = PERIODS.find((p) => p.period === form.from.value);
  const to = PERIODS.find((p) => p.period === form.to.value);
  return { from: from.start_date, to: to.end_date };
}

async function loadAccounts() {
  ACCOUNTS = await api('/api/accounts');
}

async function loadParties() {
  [CUSTOMERS, SUPPLIERS] = await Promise.all([api('/api/customers'), api('/api/suppliers')]);
}

function statusBadge(status) {
  const cls = status === 'Paid' ? 'paid' : status === 'Partially Paid' ? 'partial' : 'open';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

/**
 * Fill a rate input with the ECB rate (1 unit = ? GBP) for a currency/date.
 * GBP locks the input at 1. The user can still overwrite a fetched rate.
 */
const rateRequests = new WeakMap();
async function autoRate(currency, date, input, hintEl) {
  if (currency === BASE) {
    rateRequests.set(input, {}); // a slower lookup for another currency must not overwrite this
    input.value = 1;
    input.readOnly = true;
    if (hintEl) hintEl.textContent = '';
    return 1;
  }
  input.readOnly = false;
  if (!date) {
    if (hintEl) hintEl.textContent = 'Pick a date to fill in the ECB rate.';
    return null;
  }
  const token = {};
  rateRequests.set(input, token);
  if (hintEl) hintEl.textContent = 'Fetching ECB rate…';
  try {
    const r = await api(`/api/fx/rate?currency=${currency}&date=${date}`);
    if (rateRequests.get(input) !== token) return null; // a newer request superseded this one
    input.value = r.rate;
    if (hintEl) hintEl.textContent = `ECB reference rate of ${r.rate_date}: 1 ${currency} = £${r.rate}. You can overwrite it with the rate actually used.`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return r.rate;
  } catch (err) {
    if (hintEl) hintEl.textContent = `Couldn't fetch an ECB rate (${err.message}) - enter the rate manually.`;
    return null;
  }
}

// ---------- Tabs ----------

const LOADERS = {
  suppliers: loadSuppliersPage,
  dashboard: loadDashboard,
  kpis: loadKpis,
  assets: loadAssets,
  sales: () => loadInvoices('sale'),
  purchases: () => loadInvoices('purchase'),
  bank: loadBank,
  journals: loadJournals,
  ledger: loadLedger,
  financials: loadFinancials,
  vat: async () => {
    await loadVat();
    await loadVatCodes();
    renderVatCodes();
  },
  setup: loadSetup,
};

function showTab(name) {
  if (!CURRENT_USER) return; // nothing to show until someone is logged in
  updateEntityNotes();
  if (name.startsWith('account/')) {
    const code = decodeURIComponent(name.slice(8));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-account'));
    loadAccountView(code).catch((err) => console.error(err));
    return;
  }
  if (!document.getElementById(`view-${name}`)) name = 'suppliers';
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  // The "Other" button shows which of its pages is open.
  const inOther = document.querySelector(`#tab-menu [data-tab="${name}"]`);
  const other = document.getElementById('tab-other');
  other.classList.toggle('active', Boolean(inOther));
  other.textContent = inOther ? `Other: ${inOther.textContent} ▾` : 'Other ▾';
  closeOtherMenu();
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (LOADERS[name])
    LOADERS[name]().catch((err) => {
      console.error(err);
      if (err.status !== 401 && err.status !== 403) showProblem(err.message || 'The server could not be reached.');
    });
}

// Account links are plain #account/<code> links; following one closes any open dialog.
window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'suppliers'));
document.addEventListener('click', (e) => {
  if (e.target.closest('.acct-link')) document.querySelectorAll('dialog[open]').forEach((d) => d.close());
});

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});

// "Other" dropdown with the pages that aren't in the main menu.
function closeOtherMenu() {
  document.getElementById('tab-menu').hidden = true;
  document.getElementById('tab-other').setAttribute('aria-expanded', 'false');
}
document.getElementById('tab-other').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.getElementById('tab-menu');
  menu.hidden = !menu.hidden;
  document.getElementById('tab-other').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#tab-more')) closeOtherMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOtherMenu();
});

function refreshActive() {
  showTab(location.hash.slice(1) || 'suppliers');
}

// ---------- Dashboard ----------

async function loadDashboard() {
  const [d, rates] = await Promise.all([api('/api/dashboard'), api('/api/fx/status').catch(() => null)]);
  document.getElementById('summary-cards').innerHTML = `
    <div class="card">
      <div class="label">Receivables outstanding</div>
      <div class="value">${fmt(d.receivables.outstanding_base, BASE)}</div>
      <div class="sub">${d.receivables.open_invoices} open sales invoice(s)</div>
    </div>
    <div class="card">
      <div class="label">Payables outstanding</div>
      <div class="value">${fmt(d.payables.outstanding_base, BASE)}</div>
      <div class="sub">${d.payables.open_invoices} open purchase invoice(s)</div>
    </div>
    <div class="card">
      <div class="label">Cash &amp; bank</div>
      <div class="value">${fmt(d.cash_balance, BASE)}</div>
      <div class="sub">all bank accounts, in GBP</div>
    </div>
    <div class="card">
      <div class="label">Realised FX to date</div>
      <div class="value ${d.realised_fx_total >= 0 ? 'pos' : 'neg'}">${d.realised_fx_total >= 0 ? '+' : ''}${fmt(d.realised_fx_total, BASE)}</div>
      <div class="sub">${d.realised_fx_total >= 0 ? 'net gain' : 'net loss'} on settlements</div>
    </div>`;

  document.getElementById('dashboard-rates').textContent =
    rates && rates.latest.length
      ? `ECB reference rates (${rates.latest[0].rate_date}): ` + rates.latest.map((r) => `1 ${r.currency} = £${r.rate}`).join(' · ')
      : '';

  document.querySelector('#currency-table tbody').innerHTML = META.currencies
    .map((c) => {
      const r = d.receivables.by_currency[c];
      const p = d.payables.by_currency[c];
      return `<tr><td><strong>${c}</strong></td>
        <td class="num">${fmt(r.outstanding_foreign, c)}</td><td class="num">${fmt(r.outstanding_base, BASE)}</td>
        <td class="num">${fmt(p.outstanding_foreign, c)}</td><td class="num">${fmt(p.outstanding_base, BASE)}</td></tr>`;
    })
    .join('');

  const tbStatus = document.getElementById('tb-status');
  tbStatus.textContent = d.trial_balance_balanced
    ? 'Trial balance is in balance: every entry posted a fully balanced journal.'
    : 'Trial balance is OUT of balance - check the ledger.';
  tbStatus.className = 'tb-status ' + (d.trial_balance_balanced ? 'ok' : 'bad');
  document.querySelector('#tb-mini-table tbody').innerHTML = d.trial_balance
    .map((r) => `<tr><td>${acctLink(r.account_code, r.account_name)}</td><td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td></tr>`)
    .join('');
}

// ---------- Invoices ----------

async function loadInvoices(type) {
  const invoices = await api(`/api/invoices?type=${type}`);
  const table = document.getElementById(type === 'sale' ? 'sales-table' : 'purchases-table');
  table.innerHTML = `
    <thead><tr>
      <th>Entity</th><th>${type === 'sale' ? 'Customer' : 'Supplier'}</th><th>Invoice #</th><th>Date</th><th>Ccy</th>
      <th class="num">Net</th><th class="num">VAT</th><th class="num">Total</th>
      <th class="num">Rate</th><th class="num">Total (GBP)</th>
      <th class="num">${type === 'sale' ? 'Received' : 'Paid'}</th><th class="num">Remaining</th><th class="num">Remaining (GBP)</th>
      <th>Status</th>${type === 'purchase' ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${
      invoices
        .map(
          (i) => `
      <tr class="clickable" data-id="${i.id}">
        <td><span class="entity-tag">${esc(i.entity_code)}</span></td><td>${esc(i.party_name)}</td><td>${esc(i.invoice_number)}</td><td>${esc(i.invoice_date)}</td><td>${i.currency}</td>
        <td class="num">${fmt(i.net_amount)}</td><td class="num">${fmt(i.vat_amount)}</td><td class="num">${fmt(i.total_amount)}</td>
        <td class="num">${i.exchange_rate}</td><td class="num">${fmt(i.base_total, BASE)}</td>
        <td class="num">${fmt(i.paid_amount)}</td><td class="num">${fmt(i.remaining_amount)}</td><td class="num">${fmt(i.remaining_base, BASE)}</td>
        <td>${statusBadge(i.status)}</td>
        ${type === 'purchase' ? `<td>${i.status !== 'Paid' ? `<button class="btn btn-small btn-pay" data-id="${i.id}">Pay</button>` : ''}</td>` : ''}
      </tr>`
        )
        .join('') || `<tr><td colspan="15" class="hint">No ${type === 'sale' ? 'sales' : 'purchase'} invoices yet.</td></tr>`
    }</tbody>`;
  table.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openInvoiceDetail(Number(tr.dataset.id))));
  table.querySelectorAll('.btn-pay').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPayDialog(invoices.find((i) => i.id === Number(btn.dataset.id)));
    })
  );
}

async function openInvoiceDetail(id) {
  const { invoice: inv, lines, payments, ledger, document: pdfDoc } = await api(`/api/invoices/${id}`);
  const isSale = inv.type === 'sale';
  const body = document.getElementById('detail-body');
  body.innerHTML = `
    <h2>${isSale ? 'Sales' : 'Purchase'} invoice ${esc(inv.invoice_number)} - ${esc(inv.party_name)}</h2>
    <div class="detail-grid">
      <div><span class="k">Entity:</span> ${esc(inv.entity_name)}</div>
      <div><span class="k">Date:</span> ${esc(inv.invoice_date)}${inv.due_date ? ` · due ${esc(inv.due_date)}` : ''}</div>
      ${pdfDoc ? `<div><span class="k">Document:</span> <a href="/api/documents/${pdfDoc.id}/file" target="_blank" rel="noopener">📄 ${esc(pdfDoc.filename)}</a></div>` : ''}
      <div><span class="k">Currency:</span> ${inv.currency} @ ${inv.exchange_rate}</div>
      <div><span class="k">Net / VAT / Total:</span> ${fmt(inv.net_amount)} / ${fmt(inv.vat_amount)} / ${fmt(inv.total_amount)}</div>
      <div><span class="k">Total (GBP):</span> ${fmt(inv.base_total, BASE)}</div>
      <div><span class="k">${isSale ? 'Received' : 'Paid'}:</span> ${fmt(inv.paid_amount)} (${fmt(inv.paid_base, BASE)})</div>
      <div><span class="k">Remaining:</span> ${fmt(inv.remaining_amount)} (${fmt(inv.remaining_base, BASE)})</div>
      <div><span class="k">Realised FX:</span> ${fmt(inv.realised_fx, BASE)}</div>
      <div><span class="k">Status:</span> ${statusBadge(inv.status)}</div>
    </div>
    ${inv.notes ? `<p class="hint">${esc(inv.notes)}</p>` : ''}

    <div class="section-title">Lines</div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Description</th><th>Account</th><th>Cost centre</th><th class="num">Net</th><th>VAT code</th><th class="num">VAT</th><th class="num">Net (GBP)</th></tr></thead>
      <tbody>${lines
        .map((l) => `<tr><td>${esc(l.description || '')}</td><td>${acctLink(l.account_code, l.account_name)}</td><td>${esc(ccName(l.cost_center))}</td><td class="num">${fmt(l.net_amount)}</td><td>${esc(l.vat_code || '')} <span class="muted">${l.vat_rate}%</span></td><td class="num">${fmt(l.vat_amount)}</td><td class="num">${fmt(l.base_net)}</td></tr>`)
        .join('')}</tbody>
    </table></div>

    <div class="section-title">${isSale ? 'Receipts' : 'Payments'}</div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Bank</th><th class="num">Settled</th><th class="num">Through bank</th><th class="num">Bank (GBP)</th><th class="num">FX gain/loss</th></tr></thead>
      <tbody>${
        payments
          .map(
            (p) => `<tr><td>${esc(p.payment_date)}</td><td>${esc(p.bank_account)} ${esc(p.bank_account_name)}</td><td class="num">${fmt(p.amount, inv.currency)}</td><td class="num">${fmt(p.bank_amount, p.bank_currency)}</td><td class="num">${fmt(p.base_cash, BASE)}</td><td class="num">${fmt(p.fx_gain_loss, BASE)}</td></tr>`
          )
          .join('') || '<tr><td colspan="6" class="hint">Nothing recorded yet.</td></tr>'
      }</tbody>
    </table></div>

    <div class="section-title">Journal entries <span class="muted">(click a line to open or edit its journal)</span></div>
    ${ledgerTable(ledger, true)}

    <div class="dialog-actions inline admin-only"><button type="button" class="btn btn-delete" data-delete="invoice" data-id="${inv.id}">Delete invoice</button></div>
    ${inv.remaining_amount > 0.005 ? `<div class="dialog-actions inline">${isSale ? '' : '<button class="btn" id="btn-pay-invoice">Pay via bank</button>'}<button class="btn btn-primary" id="btn-record-payment">${isSale ? 'Record receipt' : 'Record payment'}</button></div>` : ''}
  `;
  const dlg = document.getElementById('dialog-detail');
  bindJournalRows(body);
  if (!dlg.open) dlg.showModal();
  const payViaBank = document.getElementById('btn-pay-invoice');
  if (payViaBank) {
    payViaBank.addEventListener('click', () => {
      dlg.close();
      openPayDialog(inv);
    });
  }
  const payBtn = document.getElementById('btn-record-payment');
  if (payBtn) {
    payBtn.addEventListener('click', () => {
      dlg.close();
      openPaymentDialog(inv);
    });
  }
}

/** Journal lines; with openable = true, a click on a line opens its journal (e.g. from an invoice). */
function ledgerTable(entries, openable = false) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Date</th><th>Account</th><th>Cost centre</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>${entries
      .map(
        (e) => `<tr ${openable ? `class="clickable" data-journal="${e.journal_id}"` : ''}><td>${esc(e.entry_date)}</td><td>${acctLink(e.account_code, e.account_name)}</td><td>${esc(ccName(e.cost_center))}</td>
          <td>${esc(e.description)}${e.fx_note ? `<div class="muted">${esc(e.fx_note)}</div>` : ''}</td><td class="num">${e.debit ? fmt(e.debit) : ''}</td><td class="num">${e.credit ? fmt(e.credit) : ''}</td></tr>`
      )
      .join('')}</tbody>
  </table></div>`;
}

/**
 * Edit buttons on entries (ledger, account overview, journals): open the
 * journal's editor directly - the full editor for manual/opening journals,
 * the reclassify editor for the others, or the journal (with the reason) if
 * its period is closed.
 */
async function editJournalById(id) {
  const j = await api(`/api/journals/${id}`);
  if (j.edit_mode === 'full') openJournalForm(j);
  else if (j.edit_mode === 'reclassify') openReclassDialog(j);
  else openJournalDetail(id);
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit-journal]');
  if (!btn) return;
  e.stopPropagation();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  editJournalById(Number(btn.dataset.editJournal)).catch((err) => console.error(err));
}, true);

/**
 * Delete buttons (admin): the first click asks "Really delete?", the second deletes.
 * The server decides what goes with it (e.g. an invoice's journal) and refuses what
 * would break the books; the answer says what was deleted.
 */
const DELETE_URL = {
  journal: (id) => `/api/journals/${id}`,
  invoice: (id) => `/api/invoices/${id}`,
  supplier: (id) => `/api/suppliers/${id}`,
  customer: (id) => `/api/customers/${id}`,
  account: (code) => `/api/accounts/${encodeURIComponent(code)}`,
};
document.addEventListener(
  'click',
  async (e) => {
    const btn = e.target.closest('[data-delete]');
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.dataset.label = btn.textContent;
      btn.textContent = 'Really delete?';
      btn.classList.add('confirm');
      setTimeout(() => {
        if (btn.isConnected && btn.dataset.confirm === '1') {
          btn.dataset.confirm = '';
          btn.textContent = btn.dataset.label;
          btn.classList.remove('confirm');
        }
      }, 5000);
      return;
    }
    btn.disabled = true;
    try {
      const r = await post(DELETE_URL[btn.dataset.delete](btn.dataset.id), {}, 'DELETE');
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      showNotice(`Deleted: ${r.deleted}.`);
      refreshActive();
    } catch (err) {
      showNotice(err.message, 'bad');
      btn.disabled = false;
      btn.dataset.confirm = '';
      btn.textContent = btn.dataset.label;
      btn.classList.remove('confirm');
    }
  },
  true
);

/** Wire up clickable journal lines rendered by ledgerTable(…, true). */
function bindJournalRows(root) {
  root.querySelectorAll('tr[data-journal]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      openJournalDetail(Number(tr.dataset.journal));
    })
  );
}

// ----- New invoice dialog -----

const invoiceForm = document.getElementById('form-invoice');
let invoiceType = 'purchase';

const invoiceLineAccounts = (type) =>
  type === 'sale'
    ? (a) => a.category === 'revenue'
    : (a) => ['cost_of_sales', 'overheads', 'fixed_assets', 'other_current_assets'].includes(a.category) && !a.role;

/** Open the invoice form: empty, or filled in from a recognised PDF (suggestion). */
async function openInvoiceDialog(type, suggestion = null) {
  invoiceType = type;
  if (!suggestion) recognition = null;
  await Promise.all([loadAccounts(), loadParties(), loadCostCenters(), loadVatCodes()]);
  const parties = invoiceType === 'sale' ? CUSTOMERS : SUPPLIERS;
  invoiceForm.reset();
  document.getElementById('invoice-dialog-title').textContent = invoiceType === 'sale' ? 'New sales invoice' : 'New purchase invoice';
  document.getElementById('invoice-party-label').textContent = invoiceType === 'sale' ? 'Customer' : 'Supplier';
  fillEntityField(invoiceForm.entity_id);
  invoiceForm.party_id.innerHTML = parties.map((p) => `<option value="${p.id}" data-currency="${p.currency}">${esc(p.name)} (${p.currency})</option>`).join('');
  invoiceForm.currency.innerHTML = currencyOptions(BASE);
  invoiceForm.invoice_date.value = today();
  document.getElementById('invoice-error').textContent = '';
  document.querySelector('#invoice-lines tbody').innerHTML = '';
  addInvoiceLine();
  syncInvoiceCurrency();
  const dlg = document.getElementById('dialog-invoice');
  // With an uploaded PDF: show it next to the form.
  document.getElementById('invoice-preview').hidden = !recognition;
  document.getElementById('recognition-banner').hidden = !recognition;
  dlg.classList.toggle('with-preview', Boolean(recognition));
  document.getElementById('pdf-total-wrap').hidden = !recognition;
  invoiceForm.querySelectorAll('.rec-learned, .rec-generic, .rec-guess, .rec-missing, .rec-taught, .teach-active').forEach((el) => el.classList.remove('rec-learned', 'rec-generic', 'rec-guess', 'rec-missing', 'rec-taught', 'teach-active'));
  if (suggestion) applySuggestion(suggestion);
  dlg.showModal();
  if (recognition) {
    setTeachField(null);
    renderPdfPreview().catch((err) => setTeachHint(`The PDF could not be shown: ${esc(err.message)}`, true));
  }
}

document.querySelectorAll('[data-new-invoice]').forEach((btn) => btn.addEventListener('click', () => openInvoiceDialog(btn.dataset.newInvoice)));

function addInvoiceLine() {
  const tbody = document.querySelector('#invoice-lines tbody');
  const defaultAccount = invoiceType === 'sale' ? '4000' : '5000';
  const vat = defaultVatCode(invoiceForm.currency.value);
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="l-desc" maxlength="120" placeholder="Description" /></td>
    <td><select class="l-account">${accountOptions(invoiceLineAccounts(invoiceType), defaultAccount)}</select></td>
    <td><select class="l-cc">${ccOptions(invoiceType === 'sale' ? '100' : '')}</select></td>
    <td class="num"><input class="l-net num" type="number" step="0.01" min="0" required /></td>
    <td><select class="l-vat-code">${vatCodeOptions(vat)}</select></td>
    <td class="num l-vat">0.00</td>
    <td><button type="button" class="btn btn-small btn-icon" title="Remove line">×</button></td>`;
  tr.querySelector('.btn-icon').addEventListener('click', () => {
    if (tbody.children.length > 1) tr.remove();
    updateInvoiceTotals();
  });
  const accSel = tr.querySelector('.l-account');
  accSel.addEventListener('change', () => syncCcSelect(accSel, tr.querySelector('.l-cc')));
  syncCcSelect(accSel, tr.querySelector('.l-cc'));
  tbody.appendChild(tr);
  updateInvoiceTotals();
}
document.getElementById('btn-add-invoice-line').addEventListener('click', addInvoiceLine);

function invoiceLinesFromForm() {
  return [...document.querySelectorAll('#invoice-lines tbody tr')].map((tr) => ({
    description: tr.querySelector('.l-desc').value.trim(),
    account_code: tr.querySelector('.l-account').value,
    cost_center: tr.querySelector('.l-cc').value || null,
    net_amount: parseFloat(tr.querySelector('.l-net').value) || 0,
    vat_code: tr.querySelector('.l-vat-code').value,
    vat_rate: Number((tr.querySelector('.l-vat-code').selectedOptions[0] || { dataset: { rate: 0 } }).dataset.rate) || 0,
    row: tr,
  }));
}

function updateInvoiceTotals() {
  const ccy = invoiceForm.currency.value;
  const rate = parseFloat(invoiceForm.exchange_rate.value) || 0;
  let net = 0;
  let vat = 0;
  for (const l of invoiceLinesFromForm()) {
    const lineVat = round2((l.net_amount * l.vat_rate) / 100);
    l.row.querySelector('.l-vat').textContent = fmt(lineVat);
    net += l.net_amount;
    vat += lineVat;
  }
  const total = round2(net + vat);
  document.getElementById('invoice-total-hint').innerHTML =
    `Net ${fmt(net, ccy)} + VAT ${fmt(vat, ccy)} = <strong>${fmt(total, ccy)}</strong>` +
    (ccy !== BASE ? `  →  approx. ${fmt(total * rate, BASE)}` : '') +
    recognitionTotalCheck(total);
}
invoiceForm.addEventListener('input', updateInvoiceTotals);

function syncInvoiceCurrency() {
  const opt = invoiceForm.party_id.selectedOptions[0];
  if (opt) invoiceForm.currency.value = opt.dataset.currency;
  refreshInvoiceRate();
}

function refreshInvoiceRate() {
  const ccy = invoiceForm.currency.value;
  // Default VAT code for lines not chosen by hand follows the currency (UK standard rate vs overseas zero rate).
  document.querySelectorAll('#invoice-lines .l-vat-code').forEach((i) => {
    if (!i.dataset.touched) i.value = defaultVatCode(ccy);
  });
  autoRate(ccy, invoiceForm.invoice_date.value, invoiceForm.exchange_rate, document.getElementById('invoice-rate-hint')).then(updateInvoiceTotals);
}
invoiceForm.party_id.addEventListener('change', syncInvoiceCurrency);
invoiceForm.currency.addEventListener('change', refreshInvoiceRate);
invoiceForm.invoice_date.addEventListener('change', refreshInvoiceRate);
document.querySelector('#invoice-lines').addEventListener('input', (e) => {
  if (e.target.classList.contains('l-vat-code')) e.target.dataset.touched = '1';
});

invoiceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    entity_id: Number(invoiceForm.entity_id.value),
    type: invoiceType,
    party_id: Number(invoiceForm.party_id.value),
    invoice_number: invoiceForm.invoice_number.value.trim(),
    invoice_date: invoiceForm.invoice_date.value,
    due_date: invoiceForm.due_date.value || null,
    currency: invoiceForm.currency.value,
    exchange_rate: parseFloat(invoiceForm.exchange_rate.value),
    notes: invoiceForm.notes.value.trim(),
    lines: invoiceLinesFromForm().map(({ row, ...l }) => l),
    document_id: recognition ? recognition.document_id : null,
    zones: recognition ? recognition.zones : null,
  };
  try {
    const saved = await post('/api/invoices', payload);
    document.getElementById('dialog-invoice').close();
    if (saved.learning) {
      const l = saved.learning;
      showNotice(
        `Invoice ${saved.invoice_number} saved with its PDF. ${l.correct} of ${l.checked} fields were recognised correctly` +
          (l.corrected.length ? ` (you corrected: ${l.corrected.join(', ').replace(/_/g, ' ')})` : '') +
          (l.learned.length ? `. Learned for ${saved.party_name}: ${l.learned.join('; ')}.` : '.')
      );
    }
    recognition = null;
    refreshActive();
  } catch (err) {
    document.getElementById('invoice-error').textContent = err.message;
  }
});

// ----- Payment / receipt dialog -----

const paymentForm = document.getElementById('form-payment');
let paymentInvoice = null;
let bankAmountTouched = false;

async function openPaymentDialog(inv) {
  await loadAccounts();
  paymentInvoice = inv;
  bankAmountTouched = false;
  const isSale = inv.type === 'sale';
  paymentForm.reset();
  document.getElementById('payment-error').textContent = '';
  document.getElementById('payment-dialog-title').textContent = isSale ? 'Record receipt' : 'Record payment';
  document.getElementById('payment-context').textContent = `${isSale ? 'Sales' : 'Purchase'} invoice ${inv.invoice_number} (${inv.party_name}): remaining ${fmt(
    inv.remaining_amount,
    inv.currency
  )} of ${fmt(inv.total_amount, inv.currency)}, booked at ${inv.exchange_rate} = ${fmt(inv.remaining_base, BASE)}.`;
  document.getElementById('payment-amount-label').textContent = `Amount of the invoice settled (${inv.currency})`;
  const banks = bankAccounts().filter(forEntity(inv.entity_id));
  const preferred = banks.find((b) => b.bank_currency === inv.currency) || banks[0];
  paymentForm.bank_account.innerHTML = banks
    .map((b) => `<option value="${esc(b.code)}" ${b === preferred ? 'selected' : ''}>${esc(accountLabel(b))} (${b.bank_currency})</option>`)
    .join('');
  paymentForm.payment_date.value = today();
  paymentForm.amount.max = inv.remaining_amount;
  paymentForm.amount.value = inv.remaining_amount;
  document.getElementById('dialog-payment').showModal();
  await refreshPaymentFields();
}

const selectedBank = () => ACCOUNTS.find((a) => a.code === paymentForm.bank_account.value);

async function refreshPaymentFields() {
  const inv = paymentInvoice;
  const bank = selectedBank();
  if (!inv || !bank) return;
  const sameCcy = bank.bank_currency === inv.currency;
  document.getElementById('payment-bank-amount-wrap').hidden = sameCcy;
  paymentForm.bank_amount.required = !sameCcy;
  document.getElementById('payment-bank-amount-label').textContent = `Amount ${inv.type === 'sale' ? 'received in' : 'taken from'} the bank account (${bank.bank_currency})`;
  document.getElementById('payment-rate-wrap').hidden = bank.bank_currency === BASE;
  document.getElementById('payment-rate-label').textContent = `Rate on payment date: 1 ${bank.bank_currency} = ? GBP`;

  const date = paymentForm.payment_date.value;
  const bankRate = bank.bank_currency === BASE ? 1 : await autoRate(bank.bank_currency, date, paymentForm.bank_rate, null);
  if (!sameCcy && !bankAmountTouched && date) {
    // Suggest what the bank would have converted at today's ECB rates.
    try {
      const invRate = inv.currency === BASE ? 1 : (await api(`/api/fx/rate?currency=${inv.currency}&date=${date}`)).rate;
      const amt = parseFloat(paymentForm.amount.value) || 0;
      if (bankRate) paymentForm.bank_amount.value = round2((amt * invRate) / bankRate).toFixed(2);
    } catch {
      /* leave it for the user to enter */
    }
  }
  updatePaymentPreview();
}

function updatePaymentPreview() {
  const inv = paymentInvoice;
  const bank = selectedBank();
  if (!inv || !bank) return;
  const amount = parseFloat(paymentForm.amount.value) || 0;
  const sameCcy = bank.bank_currency === inv.currency;
  const bankAmount = sameCcy ? amount : parseFloat(paymentForm.bank_amount.value) || 0;
  const bankRate = bank.bank_currency === BASE ? 1 : parseFloat(paymentForm.bank_rate.value) || 0;
  const settlesAll = Math.abs(amount - inv.remaining_amount) <= 0.005;
  const relief = settlesAll ? inv.remaining_base : round2(amount * inv.exchange_rate);
  const cash = round2(bankAmount * bankRate);
  const fx = round2(inv.type === 'sale' ? cash - relief : relief - cash);
  const hint = document.getElementById('payment-fx-hint');
  if (!amount) {
    hint.textContent = '';
    return;
  }
  hint.innerHTML = `Clears ${fmt(relief, BASE)} of ${inv.type === 'sale' ? 'receivable' : 'payable'} (booked rate); bank moves ${fmt(cash, BASE)}. ` +
    (fx === 0 ? 'No FX difference.' : `<strong class="${fx > 0 ? 'pos' : 'neg'}">FX ${fx > 0 ? 'gain' : 'loss'} ${fmt(Math.abs(fx), BASE)}</strong>`);
}

paymentForm.bank_account.addEventListener('change', () => {
  bankAmountTouched = false;
  refreshPaymentFields();
});
paymentForm.payment_date.addEventListener('change', refreshPaymentFields);
paymentForm.amount.addEventListener('change', () => {
  if (!bankAmountTouched) refreshPaymentFields();
});
paymentForm.bank_amount.addEventListener('input', () => (bankAmountTouched = true));
paymentForm.addEventListener('input', updatePaymentPreview);

paymentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    payment_date: paymentForm.payment_date.value,
    amount: parseFloat(paymentForm.amount.value),
    bank_account: paymentForm.bank_account.value,
    bank_amount: parseFloat(paymentForm.bank_amount.value) || null,
    bank_rate: parseFloat(paymentForm.bank_rate.value) || 1,
    notes: paymentForm.notes.value.trim(),
  };
  try {
    await post(`/api/invoices/${paymentInvoice.id}/payments`, payload);
    document.getElementById('dialog-payment').close();
    refreshActive();
  } catch (err) {
    document.getElementById('payment-error').textContent = err.message;
  }
});

// ---------- Bank statements ----------

let currentStatementId = null;

async function loadBank() {
  await loadAccounts();
  const sel = document.getElementById('upload-bank-select');
  const prev = sel.value;
  sel.innerHTML =
    '<option value="">Detect from IBAN in the file</option>' +
    bankAccounts()
      .filter((b) => !CURRENT_ENTITY || forEntity(CURRENT_ENTITY)(b))
      .map((b) => `<option value="${esc(b.code)}">${esc(accountLabel(b))} (${b.bank_currency}${b.entity_id ? ', ' + esc(entityCode(b.entity_id)) : ''}${b.iban ? ', ' + esc(b.iban) : ''})</option>`)
      .join('');
  sel.value = prev;

  const statements = await api('/api/bank/statements');
  const tbody = document.querySelector('#statements-table tbody');
  tbody.innerHTML =
    statements
      .map(
        (s) => `<tr class="clickable ${s.id === currentStatementId ? 'selected' : ''}" data-id="${s.id}">
          <td>${esc(s.uploaded_at.slice(0, 16))}</td><td><span class="entity-tag">${esc(s.entity_code)}</span></td><td>${acctLink(s.bank_account, s.bank_account_name)}</td>
          <td>${esc(s.statement_ref || '')}</td><td>${esc(s.from_date || '')} – ${esc(s.to_date || '')}</td><td class="muted">${esc(s.filename || '')}</td>
          <td class="num">${s.line_count}</td><td class="num">${s.open_lines ? `<span class="badge open">${s.open_lines}</span>` : '<span class="badge paid">0</span>'}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="8" class="hint">No statements uploaded yet.</td></tr>';
  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openStatement(Number(tr.dataset.id))));
  if (currentStatementId) await openStatement(currentStatementId);
}

document.getElementById('form-upload').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const errEl = document.getElementById('upload-error');
  const okEl = document.getElementById('upload-result');
  errEl.textContent = '';
  okEl.textContent = '';
  const file = form.file.files[0];
  if (!file) return;
  try {
    const content = await file.text();
    const results = await post('/api/bank/statements', { filename: file.name, content, bank_account: form.bank_account.value || null, entity_id: CURRENT_ENTITY || null });
    const imported = results.reduce((s, r) => s + r.imported, 0);
    const skipped = results.reduce((s, r) => s + r.skipped, 0);
    const auto = results.flatMap((r) => r.auto_settled || []);
    okEl.textContent =
      `Imported ${imported} line(s)` +
      (skipped ? `, skipped ${skipped} already imported or unusable line(s)` : '') +
      '.' +
      (auto.length ? ` Automatically settled ${auto.length} line(s) against invoice ${auto.map((a) => a.invoice_number).join(', ')}.` : '');
    const newest = results.find((r) => r.statement_id);
    if (newest) currentStatementId = newest.statement_id;
    form.file.value = '';
    await loadBank();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// Same rule as the server: the invoice number must appear as a whole "word" in the text.
function mentionsInvoice(text, invoiceNumber) {
  const n = String(invoiceNumber).trim().toLowerCase();
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Not glued to other letters/digits, and not part of a longer number like 2026-09 or 09/2026.
  return new RegExp(`(?<![a-z0-9])(?<![0-9][-/.])${escaped}(?![a-z0-9])(?![-/.][a-z0-9])`).test(String(text).toLowerCase());
}

document.getElementById('btn-auto-settle').addEventListener('click', async () => {
  const errEl = document.getElementById('statement-error');
  const okEl = document.getElementById('statement-result');
  errEl.textContent = '';
  okEl.textContent = '';
  try {
    const settled = await post(`/api/bank/statements/${currentStatementId}/auto-settle`, {});
    await loadBank();
    document.getElementById('statement-result').textContent = settled.length
      ? `Settled ${settled.length} line(s) against invoice ${settled.map((s) => s.invoice_number).join(', ')}.`
      : 'No open lines mention the number of an open invoice.';
  } catch (err) {
    errEl.textContent = err.message;
  }
});

async function openStatement(id) {
  if (!COST_CENTERS.length) await loadCostCenters();
  if (id !== currentStatementId) document.getElementById('statement-result').textContent = '';
  currentStatementId = id;
  document.querySelectorAll('#statements-table tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.id) === id));
  const [st, openInvoices] = await Promise.all([api(`/api/bank/statements/${id}`), api('/api/invoices')]);
  const open = openInvoices.filter((i) => i.status !== 'Paid' && i.entity_id === st.entity_id);
  const bank = ACCOUNTS.find((a) => a.code === st.bank_account);
  document.getElementById('statement-panel').hidden = false;
  document.getElementById('statement-title').textContent = `Statement ${st.statement_ref || st.id} - ${st.bank_account} ${st.bank_account_name} (${st.entity_name})`;
  document.getElementById('statement-error').textContent = '';

  const tbody = document.querySelector('#statement-lines-table tbody');
  tbody.innerHTML = st.lines
    .map((l) => {
      const moneyIn = l.direction === 'CRDT';
      const details = `<strong>${esc(l.counterparty || '')}</strong><div class="muted">${esc(l.remittance || '')}</div>`;
      const amounts = `<td class="num">${moneyIn ? fmt(l.amount, l.currency) : ''}</td><td class="num">${moneyIn ? '' : fmt(l.amount, l.currency)}</td>`;
      if (l.journal_id) {
        const what = l.payment_id ? esc(l.journal_description) : `${esc(l.contra_accounts || '')} - ${esc(l.journal_description)}`;
        const badge = l.auto_settled ? '<span class="badge paid">Auto-settled</span>' : '<span class="badge paid">Posted</span>';
        return `<tr><td>${esc(l.booking_date)}</td><td>${details}</td>${amounts}<td colspan="2">${badge} <span class="muted">${what}</span></td></tr>`;
      }
      const candidates = open.filter((i) => i.type === (moneyIn ? 'sale' : 'purchase'));
      const text = `${l.remittance || ''} ${l.counterparty || ''}`;
      const suggested = candidates.find((i) => mentionsInvoice(text, i.invoice_number));
      const invOptions = candidates
        .map(
          (i) =>
            `<option value="${i.id}" data-currency="${i.currency}" data-remaining="${i.remaining_amount}" ${i === suggested ? 'selected' : ''}>${esc(i.invoice_number)} - ${esc(i.party_name)} (${fmt(i.remaining_amount, i.currency)} open)</option>`
        )
        .join('');
      return `<tr data-line="${l.id}" data-bank-ccy="${esc(bank ? bank.bank_currency : l.currency)}">
        <td>${esc(l.booking_date)}</td><td>${details}</td>${amounts}
        <td class="post-cell">
          <select class="p-mode">
            <option value="account" ${suggested ? '' : 'selected'}>Ledger account</option>
            <option value="invoice" ${suggested ? 'selected' : ''} ${candidates.length ? '' : 'disabled'}>Open ${moneyIn ? 'sales' : 'purchase'} invoice</option>
          </select>
          <select class="p-account" ${suggested ? 'hidden' : ''}><option value="">Choose opposing account…</option>${accountOptions((a) => a.code !== st.bank_account && forEntity(st.entity_id)(a))}</select>
          <select class="p-cc" hidden title="Cost centre">${ccOptions('')}</select>
          <select class="p-invoice" ${suggested ? '' : 'hidden'}>${invOptions}</select>
          <label class="p-settle" hidden>Settles <input class="p-settle-amount num" type="number" step="0.01" min="0.01" /> <span class="p-settle-ccy"></span></label>
        </td>
        <td><button class="btn btn-small btn-primary p-post">Post</button></td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('tr[data-line]').forEach((tr) => {
    const mode = tr.querySelector('.p-mode');
    const accSel = tr.querySelector('.p-account');
    const invSel = tr.querySelector('.p-invoice');
    const settle = tr.querySelector('.p-settle');
    const syncSettle = () => {
      const opt = invSel.selectedOptions[0];
      // Only ask how much of the invoice is settled when its currency differs from the bank's.
      const differs = mode.value === 'invoice' && opt && opt.dataset.currency !== tr.dataset.bankCcy;
      settle.hidden = !differs;
      if (differs) {
        tr.querySelector('.p-settle-amount').value = opt.dataset.remaining;
        tr.querySelector('.p-settle-ccy').textContent = opt.dataset.currency;
      }
    };
    const ccSel = tr.querySelector('.p-cc');
    const syncCc = () => {
      ccSel.hidden = !(mode.value === 'account' && isPlAccount(accSel.value));
      if (ccSel.hidden) ccSel.value = '';
    };
    accSel.addEventListener('change', syncCc);
    mode.addEventListener('change', () => {
      accSel.hidden = mode.value !== 'account';
      invSel.hidden = mode.value !== 'invoice';
      syncSettle();
      syncCc();
    });
    invSel.addEventListener('change', syncSettle);
    syncSettle();
    tr.querySelector('.p-post').addEventListener('click', async () => {
      const errEl = document.getElementById('statement-error');
      errEl.textContent = '';
      try {
        await post(`/api/bank/lines/${tr.dataset.line}/post`, {
          mode: mode.value,
          account_code: accSel.value || null,
          cost_center: ccSel.value || null,
          invoice_id: invSel.value ? Number(invSel.value) : null,
          invoice_amount: parseFloat(tr.querySelector('.p-settle-amount').value) || null,
        });
        await loadBank();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  });
}

// ---------- Journals ----------

async function loadJournals() {
  const journals = await api('/api/journals');
  const tbody = document.querySelector('#journals-table tbody');
  tbody.innerHTML = journals
    .map(
      (j) => `<tr class="clickable" data-id="${j.id}">
        <td>${esc(j.journal_date)}</td><td>${esc(j.period)}</td><td><span class="entity-tag">${esc(j.entity_code)}</span></td><td>${esc(j.reference || '')}</td><td>${esc(j.description)}${j.edit_count ? ' <span class="badge edited">Edited</span>' : ''}</td>
        <td><span class="badge src-${esc(j.source_type)}">${esc(SOURCE_LABEL[j.source_type] || j.source_type)}</span></td>
        <td class="num">${j.line_count}</td><td class="num">${fmt(j.total, BASE)}</td>
        <td><button type="button" class="btn btn-small btn-edit-entry" data-edit-journal="${j.id}">Edit</button> <button type="button" class="btn btn-small btn-delete" data-delete="journal" data-id="${j.id}">Delete</button></td></tr>`
    )
    .join('');
  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openJournalDetail(Number(tr.dataset.id))));
}

async function openJournalDetail(id) {
  const j = await api(`/api/journals/${id}`);
  const editNote = {
    full: 'You can change everything in this journal.',
    reclassify: `This journal follows its ${(SOURCE_LABEL[j.source_type] || j.source_type).toLowerCase()} document: you can change the description and move P&L lines to another account or cost centre.`,
    locked: `Period ${j.period} is closed - reopen it in Setup to change this journal.`,
  }[j.edit_mode];
  const body = document.getElementById('detail-body');
  body.innerHTML = `
    <h2>Journal ${j.reference ? esc(j.reference) + ' - ' : ''}${esc(j.description)}</h2>
    <div class="detail-grid">
      <div><span class="k">Entity:</span> ${esc(j.entity_name)}</div>
      <div><span class="k">Date:</span> ${esc(j.journal_date)} (period ${esc(j.period)}, ${esc(j.period_status)})</div>
      <div><span class="k">Source:</span> ${esc(SOURCE_LABEL[j.source_type] || j.source_type)}</div>
      <div><span class="k">Changed:</span> ${j.edit_count ? `${j.edit_count} time(s), last ${esc(j.edited_at)}` : 'never'}</div>
    </div>
    ${ledgerTable(j.lines)}
    <p class="hint">${esc(editNote)}</p>
    ${
      j.history.length
        ? `<div class="section-title">History</div><ul class="history">${j.history.map((h) => `<li><span class="muted">${esc(h.changed_at)}</span> ${esc(h.summary)}</li>`).join('')}</ul>`
        : ''
    }
    ${j.edit_mode !== 'locked' ? '<div class="dialog-actions inline"><button class="btn btn-primary" id="btn-edit-journal">Edit journal</button></div>' : ''}`;
  const dlg = document.getElementById('dialog-detail');
  if (!dlg.open) dlg.showModal();
  const editBtn = document.getElementById('btn-edit-journal');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      dlg.close();
      if (j.edit_mode === 'full') openJournalForm(j);
      else openReclassDialog(j);
    });
  }
}

const journalForm = document.getElementById('form-journal');
let editingJournal = null;

/** New journal (no argument) or full edit of a manual/opening journal (amounts in GBP). */
async function openJournalForm(journal = null) {
  await Promise.all([loadAccounts(), loadCostCenters()]);
  editingJournal = journal;
  journalForm.reset();
  fillEntityField(journalForm.entity_id, journal ? journal.entity_id : null);
  journalForm.entity_id.disabled = !!journal;
  journalForm.currency.innerHTML = currencyOptions(BASE);
  journalForm.currency.disabled = !!journal;
  document.getElementById('journal-dialog-title').textContent = journal ? `Edit journal ${journal.reference || journal.id}` : 'New journal entry';
  document.getElementById('journal-error').textContent = '';
  document.querySelector('#journal-lines tbody').innerHTML = '';
  if (journal) {
    journalForm.journal_date.value = journal.journal_date;
    journalForm.reference.value = journal.reference || '';
    journalForm.description.value = journal.description;
    for (const l of journal.lines) addJournalLine(l);
  } else {
    journalForm.journal_date.value = today();
    addJournalLine();
    addJournalLine();
  }
  refreshJournalRate();
  document.getElementById('dialog-journal').showModal();
}

document.getElementById('btn-new-journal').addEventListener('click', () => openJournalForm(null));

// Switching entity changes which accounts (e.g. bank accounts) can be used.
journalForm.entity_id.addEventListener('change', () => {
  document.querySelectorAll('#journal-lines .j-account').forEach((sel) => {
    const value = sel.value;
    sel.innerHTML = `<option value="">Choose account…</option>${accountOptions(forEntity(journalForm.entity_id.value), value)}`;
  });
});

function addJournalLine(prefill = null) {
  const tbody = document.querySelector('#journal-lines tbody');
  const tr = document.createElement('tr');
  if (prefill && prefill.id) tr.dataset.lineId = prefill.id;
  const p = prefill || {};
  tr.innerHTML = `
    <td><select class="j-account" required><option value="">Choose account…</option>${accountOptions(forEntity(journalForm.entity_id.value), p.account_code)}</select></td>
    <td><select class="j-cc" disabled>${ccOptions(p.cost_center || '')}</select></td>
    <td><input class="j-desc" maxlength="120" value="${esc(p.description || '')}" /></td>
    <td class="num"><input class="j-debit num" type="number" step="0.01" min="0" value="${p.debit ? p.debit : ''}" /></td>
    <td class="num"><input class="j-credit num" type="number" step="0.01" min="0" value="${p.credit ? p.credit : ''}" /></td>
    <td><button type="button" class="btn btn-small btn-icon" title="Remove line">×</button></td>`;
  tr.querySelector('.btn-icon').addEventListener('click', () => {
    if (tbody.children.length > 2) tr.remove();
    updateJournalTotals();
  });
  const jAcc = tr.querySelector('.j-account');
  jAcc.addEventListener('change', () => syncCcSelect(jAcc, tr.querySelector('.j-cc')));
  if (p.account_code) {
    const cc = tr.querySelector('.j-cc');
    cc.disabled = !isPlAccount(p.account_code);
  }
  // Typing a debit clears the credit on the same line and vice versa.
  tr.querySelector('.j-debit').addEventListener('input', (e) => e.target.value && (tr.querySelector('.j-credit').value = ''));
  tr.querySelector('.j-credit').addEventListener('input', (e) => e.target.value && (tr.querySelector('.j-debit').value = ''));
  tbody.appendChild(tr);
  updateJournalTotals();
}
document.getElementById('btn-add-journal-line').addEventListener('click', () => addJournalLine());

function journalLinesFromForm() {
  return [...document.querySelectorAll('#journal-lines tbody tr')].map((tr) => ({
    id: tr.dataset.lineId ? Number(tr.dataset.lineId) : null,
    account_code: tr.querySelector('.j-account').value,
    cost_center: tr.querySelector('.j-cc').value || null,
    description: tr.querySelector('.j-desc').value.trim(),
    debit: parseFloat(tr.querySelector('.j-debit').value) || 0,
    credit: parseFloat(tr.querySelector('.j-credit').value) || 0,
  }));
}

function updateJournalTotals() {
  const ccy = journalForm.currency.value || BASE;
  const lines = journalLinesFromForm();
  const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
  const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
  const diff = round2(dr - cr);
  document.getElementById('journal-total-hint').innerHTML =
    `Debits ${fmt(dr, ccy)} · Credits ${fmt(cr, ccy)} · ` +
    (diff === 0 && dr > 0 ? '<strong class="pos">Balanced</strong>' : `<strong class="neg">Difference ${fmt(diff, ccy)}</strong>`);
}
journalForm.addEventListener('input', updateJournalTotals);

function refreshJournalRate() {
  autoRate(journalForm.currency.value, journalForm.journal_date.value, journalForm.exchange_rate, document.getElementById('journal-rate-hint'));
  updateJournalTotals();
}
journalForm.currency.addEventListener('change', refreshJournalRate);
journalForm.journal_date.addEventListener('change', refreshJournalRate);

journalForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    entity_id: Number(journalForm.entity_id.value),
    journal_date: journalForm.journal_date.value,
    reference: journalForm.reference.value.trim(),
    description: journalForm.description.value.trim(),
    currency: journalForm.currency.value,
    exchange_rate: parseFloat(journalForm.exchange_rate.value),
    lines: journalLinesFromForm(),
  };
  try {
    if (editingJournal) await post(`/api/journals/${editingJournal.id}`, payload, 'PUT');
    else await post('/api/journals', payload);
    document.getElementById('dialog-journal').close();
    refreshActive();
  } catch (err) {
    document.getElementById('journal-error').textContent = err.message;
  }
});

// ---------- Ledger ----------

async function loadLedger() {
  const [entries, tb] = await Promise.all([api('/api/ledger'), api('/api/trial-balance'), loadCostCenters()]);
  document.querySelector('#ledger-table tbody').innerHTML = entries
    .map(
      (e) => `<tr class="clickable" data-journal="${e.journal_id}">
        <td>${esc(e.entry_date)}</td><td><span class="entity-tag">${esc(e.entity_code)}</span></td><td>${acctLink(e.account_code, e.account_name)}</td><td>${esc(ccName(e.cost_center))}</td><td>${esc(e.description)}</td>
        <td class="muted">${esc(e.fx_note || '')}</td>
        <td class="num">${e.debit ? fmt(e.debit) : ''}</td><td class="num">${e.credit ? fmt(e.credit) : ''}</td>
        <td><button type="button" class="btn btn-small btn-edit-entry" data-edit-journal="${e.journal_id}" title="Edit this entry's journal">Edit</button> <button type="button" class="btn btn-small btn-delete" data-delete="journal" data-id="${e.journal_id}">Delete</button></td></tr>`
    )
    .join('');
  bindJournalRows(document.getElementById('ledger-table'));
  const totDr = tb.reduce((s, r) => s + r.debit, 0);
  const totCr = tb.reduce((s, r) => s + r.credit, 0);
  document.querySelector('#tb-full-table tbody').innerHTML =
    tb
      .map((r) => `<tr><td>${acctLink(r.account_code, r.account_name)}</td><td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td><td class="num">${fmt(r.balance)}</td></tr>`)
      .join('') + `<tr class="total"><td>Total</td><td class="num">${fmt(totDr)}</td><td class="num">${fmt(totCr)}</td><td class="num">${fmt(totDr - totCr)}</td></tr>`;
}

// ---------- Financial statements ----------

const periodForm = document.getElementById('form-period');
periodForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadFinancials();
});
document.getElementById('fin-detail').addEventListener('change', () => {
  document.getElementById('view-financials').classList.toggle('hide-detail', !document.getElementById('fin-detail').checked);
});

function finGroupRows(group) {
  const head = `<tr class="cat"><td>${esc(group.name)}</td><td class="num">${fmt(group.total)}</td></tr>`;
  const lines = group.accounts
    .map((a) => `<tr class="acct"><td>${a.code ? acctLink(a.code, a.name) : esc(a.name)}</td><td class="num">${fmt(a.amount)}</td></tr>`)
    .join('');
  return head + lines;
}

const subtotal = (label, value, cls = 'sub') => `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${fmt(value, BASE)}</td></tr>`;

async function loadFinancials() {
  await Promise.all([loadPeriods(), loadCostCenters()]);
  fillPeriodSelects(periodForm);
  const ccSel = periodForm.cost_center;
  const ccPrev = ccSel.value;
  ccSel.innerHTML =
    '<option value="">Whole company</option>' +
    COST_CENTERS.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} ${esc(c.name)}</option>`).join('') +
    '<option value="none">Unallocated</option>';
  ccSel.value = ccPrev;
  const { from, to } = periodRange(periodForm);
  let r;
  let ccr;
  try {
    [r, ccr] = await Promise.all([
      api(`/api/reports?from=${from}&to=${to}${ccSel.value ? `&cost_center=${encodeURIComponent(ccSel.value)}` : ''}`),
      api(`/api/reports/cost-centers?from=${from}&to=${to}`),
    ]);
  } catch (err) {
    document.getElementById('pl-period').textContent = err.message;
    return;
  }
  const pl = r.profit_and_loss;
  document.getElementById('pl-period').textContent =
    `${r.from} to ${r.to}` + (r.cost_center ? ` · ${r.cost_center === 'none' ? 'unallocated lines only' : 'cost centre ' + ccName(r.cost_center)}` : ' · whole company');
  document.getElementById('pl-table').innerHTML =
    finGroupRows(pl.revenue) +
    finGroupRows(pl.cost_of_sales) +
    subtotal('Gross profit', pl.gross_profit) +
    finGroupRows(pl.overheads) +
    subtotal('EBITDA', pl.ebitda) +
    finGroupRows(pl.depreciation) +
    subtotal('Operating result (EBIT)', pl.operating_result) +
    finGroupRows(pl.financial_income) +
    finGroupRows(pl.financial_expenses) +
    subtotal('Net result', pl.net_result, 'grand');

  // Balance sheet: opening and closing side by side.
  const { opening, closing } = r.balance_sheet;
  const pairRows = (o, c) => {
    const amounts = new Map();
    for (const a of o.accounts) amounts.set(a.code + a.name, { code: a.code, name: a.name, o: a.amount, c: 0 });
    for (const a of c.accounts) {
      const k = a.code + a.name;
      amounts.set(k, { ...(amounts.get(k) || { code: a.code, name: a.name, o: 0 }), c: a.amount });
    }
    const rows = [...amounts.values()].sort((x, y) => (x.code || 'zzz').localeCompare(y.code || 'zzz'));
    if (!rows.length && o.total === 0 && c.total === 0) return '';
    return (
      `<tr class="cat"><td>${esc(c.name)}</td><td class="num">${fmt(o.total)}</td><td class="num">${fmt(c.total)}</td></tr>` +
      rows.map((a) => `<tr class="acct"><td>${a.code ? acctLink(a.code, a.name) : esc(a.name)}</td><td class="num">${fmt(a.o)}</td><td class="num">${fmt(a.c)}</td></tr>`).join('')
    );
  };
  const total3 = (label, o, c, cls = 'sub') => `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${fmt(o, BASE)}</td><td class="num">${fmt(c, BASE)}</td></tr>`;
  document.getElementById('bs-table').innerHTML =
    `<thead><tr><th></th><th class="num">${esc(r.opening_date)}</th><th class="num">${esc(r.to)}</th></tr></thead><tbody>` +
    `<tr class="section"><td colspan="3">Assets</td></tr>` +
    closing.assets.map((g, i) => pairRows(opening.assets[i], g)).join('') +
    total3('Total assets', opening.total_assets, closing.total_assets, 'grand') +
    `<tr class="section"><td colspan="3">Equity &amp; liabilities</td></tr>` +
    pairRows(opening.equity, closing.equity) +
    closing.liabilities.map((g, i) => pairRows(opening.liabilities[i], g)).join('') +
    total3('Total equity & liabilities', opening.total_equity_liabilities, closing.total_equity_liabilities, 'grand') +
    '</tbody>';
  const bsCheck = document.getElementById('bs-check');
  bsCheck.textContent = closing.balanced && opening.balanced ? '✓ Assets equal equity plus liabilities.' : '✗ Balance sheet does not balance - check the ledger.';
  bsCheck.className = 'hint ' + (closing.balanced && opening.balanced ? 'pos' : 'neg');

  const cf = r.cash_flow;
  const cfGroups = (groups) => groups.filter((g) => g.accounts.length).map((g) => finGroupRows(g)).join('');
  document.getElementById('cf-table').innerHTML =
    `<tr class="section"><td colspan="2">Operating activities</td></tr>` +
    `<tr class="cat"><td>Net result for the period</td><td class="num">${fmt(cf.net_result)}</td></tr>` +
    cfGroups(cf.operating_items) +
    subtotal('Cash flow from operating activities', cf.operating) +
    `<tr class="section"><td colspan="2">Investing activities</td></tr>` +
    cfGroups(cf.investing_items) +
    subtotal('Cash flow from investing activities', cf.investing) +
    `<tr class="section"><td colspan="2">Financing activities</td></tr>` +
    cfGroups(cf.financing_items) +
    subtotal('Cash flow from financing activities', cf.financing) +
    subtotal('Net change in cash & bank', cf.net_change, 'grand') +
    `<tr class="cat"><td>Cash &amp; bank at ${esc(r.opening_date)}</td><td class="num">${fmt(cf.opening_cash, BASE)}</td></tr>` +
    `<tr class="cat"><td>Cash &amp; bank at ${esc(r.to)}</td><td class="num">${fmt(cf.closing_cash, BASE)}</td></tr>` +
    cf.cash_accounts.filter((a) => a.opening || a.closing).map((a) => `<tr class="acct"><td>${acctLink(a.code, a.name)}</td><td class="num">${fmt(a.closing)}</td></tr>`).join('');
  renderCostCenterTable(ccr);

  const cfCheck = document.getElementById('cf-check');
  cfCheck.textContent = cf.reconciles ? '✓ Opening cash plus net change equals closing cash.' : '✗ Cash flow does not reconcile.';
  cfCheck.className = 'hint ' + (cf.reconciles ? 'pos' : 'neg');
}

// ---------- VAT returns (HMRC) ----------

const VAT_BOXES = [
  ['vat_due_sales', 1, 'VAT due on sales and other outputs'],
  ['vat_due_acquisitions', 2, 'VAT due on acquisitions of goods from EU member states (NI only)'],
  ['total_vat_due', 3, 'Total VAT due (box 1 + box 2)'],
  ['vat_reclaimed', 4, 'VAT reclaimed on purchases and other inputs'],
  ['net_vat_due', 5, 'Net VAT to pay to HMRC or reclaim'],
  ['total_sales_ex_vat', 6, 'Total value of sales and other outputs, excluding VAT'],
  ['total_purchases_ex_vat', 7, 'Total value of purchases and other inputs, excluding VAT'],
  ['total_goods_supplied_ex_vat', 8, 'Total value of goods supplied to EU member states, excluding VAT (NI only)'],
  ['total_acquisitions_ex_vat', 9, 'Total value of goods acquired from EU member states, excluding VAT (NI only)'],
];

const vatForm = document.getElementById('form-vat-period');
const vatFileForm = document.getElementById('form-vat-file');
let vatCalc = null;

vatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  calculateVat();
});

/** Default period: the three months up to the last completed month. */
function fillVatPeriods() {
  const firstTime = !vatForm.to.value;
  fillPeriodSelects(vatForm);
  if (!firstTime) return;
  const periods = [...PERIODS].map((p) => p.period).sort();
  const last = periods.filter((p) => p < currentPeriod()).pop() || periods[periods.length - 1];
  vatForm.from.value = periods[Math.max(0, periods.indexOf(last) - 2)];
  vatForm.to.value = last;
}

async function loadVat() {
  await loadPeriods();
  fillVatPeriods();
  await Promise.all([calculateVat(), loadVatReturns()]);
}

async function calculateVat() {
  const out = document.getElementById('vat-result');
  const err = document.getElementById('vat-error');
  const filePanel = document.getElementById('vat-file-panel');
  err.textContent = '';
  vatCalc = null;
  filePanel.hidden = true;
  if (!CURRENT_ENTITY) {
    out.innerHTML = '<p class="hint">Choose an entity in the top bar: each entity files its own VAT return.</p>';
    return;
  }
  const { from, to } = periodRange(vatForm);
  try {
    vatCalc = await api(`/api/vat/calculate?from=${from}&to=${to}`);
  } catch (e) {
    out.innerHTML = '';
    err.textContent = e.message;
    return;
  }
  const c = vatCalc;
  const b = c.boxes;
  const money = (key) => (key.startsWith('total_') && key !== 'total_vat_due' ? fmt(b[key], BASE).replace(/\.\d\d$/, '') : fmt(b[key], BASE));
  const check = (label, x) =>
    x.difference
      ? `<p class="hint neg">✗ ${label}: ledger ${acctLink(x.code, '')} moved ${fmt(x.amount, BASE)} in the period, ${fmt(Math.abs(x.difference), BASE)} ${x.difference > 0 ? 'more' : 'less'} than on the invoices. VAT booked by journals is not in the return; check it before filing.</p>`
      : `<p class="hint pos">✓ ${label} agrees with ledger ${acctLink(x.code, '')}.</p>`;
  out.innerHTML = `
    <p class="hint">${esc(c.entity.name)} · ${esc(c.from)} to ${esc(c.to)} · ${c.sales_invoices} sales and ${c.purchase_invoices} purchase invoice(s) · due by <strong>${esc(c.due_date)}</strong></p>
    <div class="table-wrap"><table class="table fin">
      <tbody>${VAT_BOXES.map(
        ([key, n, label]) => `<tr class="${n === 5 ? 'grand' : n === 3 ? 'sub' : 'cat'}"><td>Box ${n}</td><td>${esc(label)}</td><td class="num">${money(key)}</td></tr>`
      ).join('')}</tbody>
    </table></div>
    <p><strong>${b.net_vat_due === 0 ? 'Nothing to pay or reclaim.' : c.to_pay ? `${fmt(b.net_vat_due, BASE)} to pay to HMRC.` : `${fmt(b.net_vat_due, BASE)} to reclaim from HMRC.`}</strong></p>
    ${check('Output VAT (box 1)', c.ledger_check.output)}
    ${check('Input VAT (box 4)', c.ledger_check.input)}`;
  filePanel.hidden = false;
  document.getElementById('vat-file-error').textContent = '';
}

vatFileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('vat-file-error');
  errEl.textContent = '';
  if (!vatCalc) return;
  try {
    const r = await post('/api/vat/returns', {
      entity_id: vatCalc.entity.id,
      from: vatCalc.from,
      to: vatCalc.to,
      vrn: vatFileForm.vrn.value,
      period_key: vatFileForm.period_key.value,
      declaration: vatFileForm.declaration.checked,
    });
    vatFileForm.period_key.value = '';
    vatFileForm.declaration.checked = false;
    await loadVatReturns();
    await downloadVatReturn(r.id);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

async function loadVatReturns() {
  const rows = await api('/api/vat/returns');
  // Suggest the VAT number used last time for this entity.
  const last = rows.find((r) => String(r.entity_id) === String(CURRENT_ENTITY));
  if (last && !vatFileForm.vrn.value) vatFileForm.vrn.value = last.vrn;
  const tbody = document.querySelector('#vat-returns-table tbody');
  tbody.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td>${esc(r.entity_code)}</td>
        <td>${esc(r.period_start)} to ${esc(r.period_end)}${r.changed_since_filing ? ' <span class="badge open" title="The books for this period have changed since it was filed">changed since filing</span>' : ''}</td>
        <td>${esc(r.period_key)}</td>
        <td>GB ${esc(r.vrn)}</td>
        <td class="num">${r.total_vat_due >= r.vat_reclaimed ? '' : '-'}${fmt(r.net_vat_due, BASE)}</td>
        <td>${esc(r.due_date)}</td>
        <td>${esc(String(r.filed_at).slice(0, 16))}${r.filed_by ? ` · ${esc(r.filed_by)}` : ''}</td>
        <td><button type="button" class="btn btn-small" data-vat-download="${r.id}">Download MTD file</button></td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="8" class="muted">No VAT returns filed yet.</td></tr>';
  tbody.querySelectorAll('[data-vat-download]').forEach((btn) => btn.addEventListener('click', () => downloadVatReturn(btn.dataset.vatDownload)));
}

/** Save the Making Tax Digital request body as a .json file. */
async function downloadVatReturn(id) {
  const r = await api(`/api/vat/returns/${id}/mtd`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(r.body, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = r.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Setup: chart of accounts, customers, suppliers, FX ----------

async function loadSetup() {
  await Promise.all([loadAccounts(), loadParties()]);
  document.getElementById('period-error').textContent = '';
  const catOptions = (selected, bankOnly) =>
    META.categories
      .filter((c) => !bankOnly || c.key === 'cash')
      .map((c) => `<option value="${c.key}" ${c.key === selected ? 'selected' : ''}>${esc(c.name)} (${c.statement === 'BS' ? 'balance sheet' : 'P&L'})</option>`)
      .join('');
  const tbody = document.querySelector('#accounts-table tbody');
  tbody.innerHTML = ACCOUNTS.map(
    (a) => `<tr data-code="${esc(a.code)}">
      <td><strong>${acctLink(a.code, '')}</strong></td>
      <td>${esc(a.name)}${a.bank_currency ? ` <span class="muted">(${a.bank_currency}${a.iban ? ', ' + esc(a.iban) : ''})</span>` : ''}${a.entity_id ? ` <span class="entity-tag">${esc(entityCode(a.entity_id))} only</span>` : ''}</td>
      <td><select class="cat-select" ${a.bank_currency ? 'disabled title="Bank accounts stay in Cash & bank"' : ''}>${catOptions(a.category, !!a.bank_currency)}</select></td>
      <td>${a.statement === 'BS' ? 'Balance sheet' : 'P&amp;L'}</td>
      <td class="muted">${esc(ROLE_LABEL[a.role] || (a.bank_currency ? 'Bank' : ''))}</td>
      <td class="num">${fmt(a.balance)}</td>
      <td class="nowrap"><button class="btn btn-small edit-account">Edit</button> <button type="button" class="btn btn-small btn-delete" data-delete="account" data-id="${esc(a.code)}">Delete</button></td>
    </tr>`
  ).join('');
  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.querySelector('.cat-select').addEventListener('change', async (e) => {
      try {
        await post(`/api/accounts/${encodeURIComponent(tr.dataset.code)}`, { category: e.target.value }, 'PUT');
        await loadSetup();
      } catch (err) {
        alert(err.message);
      }
    });
    tr.querySelector('.edit-account').addEventListener('click', () => openAccountDialog(ACCOUNTS.find((a) => a.code === tr.dataset.code)));
  });

  document.querySelector('#customers-table tbody').innerHTML = CUSTOMERS.map(
    (p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.country || '')}</td><td>${p.currency}</td><td>${esc(p.vat_number || '')}</td>
      <td class="nowrap"><button class="btn btn-small" data-edit-party="customer" data-id="${p.id}">Edit</button> <button type="button" class="btn btn-small btn-delete" data-delete="customer" data-id="${p.id}">Delete</button></td></tr>`
  ).join('');
  document.querySelectorAll('[data-edit-party]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const kind = btn.dataset.editParty;
      openPartyDialog(kind, (kind === 'customer' ? CUSTOMERS : SUPPLIERS).find((p) => p.id === Number(btn.dataset.id)));
    })
  );

  await Promise.all([loadCostCenters(), loadPeriods()]);
  renderCostCenterList();
  renderPeriods();
  await loadRecognitionProfiles();
  if (isAdmin()) await loadUsers();

  renderFxStatus(await api('/api/fx/status'));
}

function renderFxStatus(s) {
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
  document.getElementById('fx-status').innerHTML = `
    <div class="fx-rates">${s.latest.map((r) => `<div class="card"><div class="label">1 ${r.currency}</div><div class="value">£${r.rate}</div><div class="sub">ECB, ${esc(r.rate_date)}</div></div>`).join('') || '<p class="hint">No rates stored yet.</p>'}</div>
    <p class="hint">Source: European Central Bank daily reference rates. Updated automatically on start-up and every ${s.update_every_hours} hours
      (last successful update: ${when(s.last_success)}). ${s.days_stored} days stored${s.first_date ? `, ${esc(s.first_date)} to ${esc(s.last_date)}` : ''}.
      ${s.last_error ? `<span class="neg">Last error: ${esc(s.last_error)}</span>` : ''}</p>`;
}

document.getElementById('btn-refresh-rates').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    renderFxStatus(await post('/api/fx/refresh', {}));
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
  }
});

// ----- Account dialog -----

const accountForm = document.getElementById('form-account');
let editingAccount = null;

function openAccountDialog(account) {
  editingAccount = account || null;
  accountForm.reset();
  document.getElementById('account-error').textContent = '';
  document.getElementById('account-dialog-title').textContent = account ? `Edit account ${account.code}` : 'New account';
  accountForm.category.innerHTML = META.categories
    .filter((c) => !account || !account.bank_currency || c.key === 'cash')
    .map((c) => `<option value="${c.key}">${esc(c.name)} (${c.statement === 'BS' ? 'balance sheet' : 'P&L'})</option>`)
    .join('');
  accountForm.bank_currency.innerHTML = currencyOptions(BASE);
  accountForm.code.disabled = !!account;
  if (account) {
    accountForm.code.value = account.code;
    accountForm.name.value = account.name;
    accountForm.category.value = account.category;
    accountForm.iban.value = account.iban || '';
  }
  syncAccountFields();
  document.getElementById('dialog-account').showModal();
}

function syncAccountFields() {
  const isBank = accountForm.category.value === 'cash';
  document.getElementById('account-currency-wrap').hidden = !isBank || !!editingAccount;
  document.getElementById('account-iban-wrap').hidden = !isBank;
}
accountForm.category.addEventListener('change', syncAccountFields);
document.getElementById('btn-new-account').addEventListener('click', () => openAccountDialog(null));

accountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: accountForm.name.value.trim(),
    category: accountForm.category.value,
    iban: accountForm.iban.value.trim(),
  };
  try {
    if (editingAccount) {
      await post(`/api/accounts/${encodeURIComponent(editingAccount.code)}`, payload, 'PUT');
    } else {
      await post('/api/accounts', { ...payload, code: accountForm.code.value.trim(), bank_currency: accountForm.bank_currency.value });
    }
    document.getElementById('dialog-account').close();
    loadSetup();
  } catch (err) {
    document.getElementById('account-error').textContent = err.message;
  }
});

// ----- Customer / supplier dialog -----

const partyForm = document.getElementById('form-party');
let partyKind = 'supplier';
let editingParty = null;

function openPartyDialog(kind, party) {
  partyKind = kind;
  editingParty = party || null;
  partyForm.reset();
  partyForm.currency.innerHTML = currencyOptions(party ? party.currency : BASE);
  const noun = kind === 'customer' ? 'customer' : 'supplier';
  document.getElementById('party-dialog-title').textContent = party ? `Edit ${noun}` : `New ${noun}`;
  document.getElementById('party-error').textContent = '';
  if (party) {
    for (const f of ['name', 'country', 'vat_number', 'sort_code', 'account_number', 'iban', 'bic']) partyForm[f].value = party[f] || '';
  }
  document.getElementById('dialog-party').showModal();
}

document.querySelectorAll('[data-new-party]').forEach((btn) => btn.addEventListener('click', () => openPartyDialog(btn.dataset.newParty, null)));

partyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: partyForm.name.value.trim(),
    country: partyForm.country.value.trim(),
    currency: partyForm.currency.value,
    vat_number: partyForm.vat_number.value.trim(),
    sort_code: partyForm.sort_code.value.trim(),
    account_number: partyForm.account_number.value.trim(),
    iban: partyForm.iban.value.trim(),
    bic: partyForm.bic.value.trim(),
  };
  const base = partyKind === 'customer' ? '/api/customers' : '/api/suppliers';
  try {
    if (editingParty) await post(`${base}/${editingParty.id}`, payload, 'PUT');
    else await post(base, payload);
    // Edits can come from Setup (customers) or the Suppliers page: reload whichever is open.
    document.getElementById('dialog-party').close();
    refreshActive();
  } catch (err) {
    document.getElementById('party-error').textContent = err.message;
  }
});

// ---------- P&L by cost centre (Financials) ----------

function renderCostCenterTable(r) {
  const cols = r.cost_centers;
  const table = document.getElementById('cc-table');
  if (!cols.length) {
    table.innerHTML = '<tr><td class="hint">No P&amp;L postings in this period.</td></tr>';
    return;
  }
  const head = `<thead><tr><th></th>${cols.map((c) => `<th class="num">${esc(c.code ? `${c.code} ${c.name}` : c.name)}</th>`).join('')}<th class="num">Total</th></tr></thead>`;
  const row = (label, key, cls) => {
    const total = cols.reduce((t, c) => t + c[key], 0);
    return `<tr class="${cls}"><td>${esc(label)}</td>${cols.map((c) => `<td class="num">${fmt(c[key])}</td>`).join('')}<td class="num">${fmt(total)}</td></tr>`;
  };
  const cat = (key) => r.categories.find((c) => c.key === key).name;
  table.innerHTML =
    head +
    '<tbody>' +
    row(cat('revenue'), 'revenue', 'cat') +
    row(cat('cost_of_sales'), 'cost_of_sales', 'cat') +
    row('Gross profit', 'gross_profit', 'sub') +
    row(cat('overheads'), 'overheads', 'cat') +
    row('EBITDA', 'ebitda', 'sub') +
    row(cat('depreciation'), 'depreciation', 'cat') +
    row('Operating result (EBIT)', 'operating_result', 'sub') +
    row(cat('financial_income'), 'financial_income', 'cat') +
    row(cat('financial_expenses'), 'financial_expenses', 'cat') +
    row('Net result', 'net_result', 'grand') +
    '</tbody>';
}

// ---------- Setup: cost centres & periods ----------

function renderCostCenterList() {
  const tbody = document.querySelector('#cc-list-table tbody');
  tbody.innerHTML = COST_CENTERS.map(
    (c) => `<tr><td><strong>${esc(c.code)}</strong></td><td>${esc(c.name)}</td>
      <td>${c.active ? '<span class="badge paid">Active</span>' : '<span class="badge open">Inactive</span>'}</td>
      <td><button class="btn btn-small" data-cc-toggle="${esc(c.code)}">${c.active ? 'Deactivate' : 'Activate'}</button></td></tr>`
  ).join('');
  tbody.querySelectorAll('[data-cc-toggle]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const c = COST_CENTERS.find((x) => x.code === btn.dataset.ccToggle);
      try {
        await post(`/api/cost-centers/${encodeURIComponent(c.code)}`, { active: !c.active }, 'PUT');
        await loadCostCenters();
        renderCostCenterList();
      } catch (err) {
        document.getElementById('cc-error').textContent = err.message;
      }
    })
  );
}

document.getElementById('form-cc').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  document.getElementById('cc-error').textContent = '';
  try {
    await post('/api/cost-centers', { code: form.code.value.trim(), name: form.name.value.trim() });
    form.reset();
    await loadCostCenters();
    renderCostCenterList();
  } catch (err) {
    document.getElementById('cc-error').textContent = err.message;
  }
});

function renderPeriods() {
  const tbody = document.querySelector('#periods-table tbody');
  // Future months are created automatically when needed; list only up to the current month.
  tbody.innerHTML = PERIODS.filter((p) => p.period <= currentPeriod() || p.journal_count > 0).map(
    (p) => `<tr>
      <td><strong>${periodLabel(p.period)}</strong><div class="muted">${esc(p.start_date)} – ${esc(p.end_date)}</div></td>
      <td class="num">${p.journal_count}</td>
      <td class="num">${p.depreciation ? fmt(p.depreciation, BASE) : ''}</td>
      <td>${p.status === 'closed' ? '<span class="badge closed">Closed</span>' : '<span class="badge paid">Open</span>'}</td>
      <td><button class="btn btn-small" data-period="${p.period}" data-action="${p.status === 'closed' ? 'reopen' : 'close'}">${p.status === 'closed' ? 'Reopen' : 'Close'}</button></td>
    </tr>`
  ).join('');
  tbody.querySelectorAll('[data-period]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const errEl = document.getElementById('period-error');
      errEl.textContent = '';
      try {
        await post(`/api/periods/${btn.dataset.period}/${btn.dataset.action}`, {});
        await loadPeriods();
        renderPeriods();
      } catch (err) {
        errEl.textContent = err.message;
      }
    })
  );
}

// ---------- Charts (inline SVG) ----------
// Categorical colours, validated for colour-vision deficiency (slots 1-3 of the reference palette).
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function compactGbp(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${sign}£${Math.round(a / 1e3)}k`;
  return `${sign}£${Math.round(a)}`;
}

function niceTicks(min, max, count = 5) {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.001; t += step) ticks.push(Math.round(t * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function makeTooltip(container) {
  let tip = container.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    container.appendChild(tip);
  }
  return tip;
}

/** Tooltip rows: value first (strong), series name after, keyed with a short line in the series colour. */
function fillTooltip(tip, title, rows) {
  tip.replaceChildren();
  const h = document.createElement('div');
  h.className = 'tip-title';
  h.textContent = title;
  tip.appendChild(h);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    if (r.color) {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = r.color;
      row.appendChild(key);
    }
    const v = document.createElement('strong');
    v.textContent = r.value;
    row.appendChild(v);
    const n = document.createElement('span');
    n.className = 'muted';
    n.textContent = ` ${r.name}`;
    row.appendChild(n);
    tip.appendChild(row);
  }
}

/** Line chart: one shared GBP axis, crosshair + tooltip, legend and direct end labels. */
function lineChart(container, labels, series) {
  container.replaceChildren();
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  if (series.length > 1) {
    for (const s of series) {
      const item = document.createElement('span');
      const key = document.createElement('span');
      key.className = 'legend-line';
      key.style.background = s.color;
      item.append(key, document.createTextNode(s.name));
      legend.appendChild(item);
    }
    container.appendChild(legend);
  }
  const W = Math.max(container.clientWidth || 520, 320);
  const H = 240;
  const m = { l: 56, r: series.length > 1 ? 104 : 16, t: 10, b: 26 };
  const values = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const x = (i) => m.l + (labels.length === 1 ? (W - m.l - m.r) / 2 : (i * (W - m.l - m.r)) / (labels.length - 1));
  const y = (v) => m.t + ((y1 - v) / (y1 - y0)) * (H - m.t - m.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': series.map((s) => s.name).join(', ') + ' per month' });
  for (const t of ticks) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis-zero' : 'grid' }, svg);
    const lab = svgEl('text', { x: m.l - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
    lab.textContent = compactGbp(t);
  }
  labels.forEach((l, i) => {
    const lab = svgEl('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, svg);
    lab.textContent = periodLabel(l).replace(' 20', " '");
  });
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    if (labels.length === 1) svgEl('circle', { cx: x(0), cy: y(s.values[0]), r: 4, fill: s.color }, svg);
  }
  // Direct labels at the line ends, nudged apart so they never overlap.
  if (series.length > 1) {
    const ends = series.map((s) => ({ s, y: y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    for (const e of ends) {
      svgEl('line', { x1: W - m.r + 6, x2: W - m.r + 16, y1: e.y, y2: e.y, stroke: e.s.color, 'stroke-width': 2 }, svg);
      const t = svgEl('text', { x: W - m.r + 20, y: e.y + 4, class: 'end-label' }, svg);
      t.textContent = e.s.name;
    }
  }
  const cross = svgEl('line', { y1: m.t, y2: H - m.b, class: 'crosshair', visibility: 'hidden' }, svg);
  const dots = series.map((s) => svgEl('circle', { r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const hit = svgEl('rect', { x: m.l - 10, y: m.t, width: W - m.l - m.r + 20, height: H - m.t - m.b, fill: 'transparent' }, svg);
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.appendChild(svg);
  container.appendChild(wrap);
  const tip = makeTooltip(wrap);
  const show = (i) => {
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    dots.forEach((d, k) => {
      d.setAttribute('cx', x(i));
      d.setAttribute('cy', y(series[k].values[i]));
      d.setAttribute('visibility', 'visible');
    });
    fillTooltip(tip, periodLabel(labels[i]), series.map((s) => ({ value: fmt(s.values[i], BASE), name: s.name, color: s.color })));
    tip.hidden = false;
    const px = (x(i) / W) * wrap.clientWidth;
    tip.style.left = `${Math.min(px + 12, wrap.clientWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = '8px';
  };
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    labels.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    show(best);
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  });
}

/** Horizontal bars for one measure (single hue), value labels at the bar ends, per-bar tooltip. */
function barChart(container, items) {
  container.replaceChildren();
  if (!items.length) {
    container.innerHTML = '<p class="hint">No costs with a cost centre in this period.</p>';
    return;
  }
  const W = Math.max(container.clientWidth || 520, 320);
  const rowH = 34;
  const labelW = Math.min(220, W * 0.38);
  const H = items.length * rowH + 8;
  const max = Math.max(...items.map((i) => i.value));
  const scale = (v) => (v / max) * (W - labelW - 90);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': 'Operating costs per cost centre' });
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.appendChild(svg);
  container.appendChild(wrap);
  const tip = makeTooltip(wrap);
  items.forEach((it, i) => {
    const cy = 4 + i * rowH + rowH / 2;
    const name = svgEl('text', { x: labelW - 10, y: cy + 4, class: 'bar-label', 'text-anchor': 'end' }, svg);
    name.textContent = it.label;
    const w = Math.max(scale(it.value), 2);
    // Square at the baseline, 4px rounded at the data end.
    const r = Math.min(4, w / 2);
    const x0 = labelW;
    const top = cy - 8;
    const d = `M${x0},${top} H${x0 + w - r} Q${x0 + w},${top} ${x0 + w},${top + r} V${top + 16 - r} Q${x0 + w},${top + 16} ${x0 + w - r},${top + 16} H${x0} Z`;
    const bar = svgEl('path', { d, fill: SERIES[0], class: 'bar' }, svg);
    const val = svgEl('text', { x: x0 + w + 8, y: cy + 4, class: 'bar-value' }, svg);
    val.textContent = fmt(it.value, BASE);
    const hit = svgEl('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, fill: 'transparent', tabindex: 0 }, svg);
    const show = () => {
      bar.classList.add('hover');
      fillTooltip(tip, it.label, [{ value: fmt(it.value, BASE), name: it.sub || '' }]);
      tip.hidden = false;
      tip.style.left = `${Math.min(((x0 + w) / W) * wrap.clientWidth + 12, wrap.clientWidth - tip.offsetWidth - 4)}px`;
      tip.style.top = `${(top / H) * wrap.clientHeight - 6}px`;
    };
    const hide = () => {
      bar.classList.remove('hover');
      tip.hidden = true;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
  });
}

// ---------- KPI dashboard ----------

const kpiForm = document.getElementById('form-kpi-period');
kpiForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadKpis();
});
let lastKpis = null;

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const times = (v) => (v === null || v === undefined ? 'n/a' : `${v.toFixed(2)}×`);
const daysTxt = (v) => (v === null || v === undefined ? 'n/a' : `${v} days`);

async function loadKpis() {
  await loadPeriods();
  fillPeriodSelects(kpiForm);
  const { from, to } = periodRange(kpiForm);
  const k = await api(`/api/kpis?from=${from}&to=${to}`);
  lastKpis = k;
  const tile = (label, value, sub, tone) =>
    `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value ${tone || ''}">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
  const signTone = (v) => (v === null ? '' : v < 0 ? 'neg' : '');
  const groups = [
    [
      'Profitability',
      [
        tile('Revenue', fmt(k.revenue, BASE), `${k.from} to ${k.to}`),
        tile('Gross margin', pct(k.gross_margin), `gross profit ${fmt(k.gross_profit, BASE)}`),
        tile('EBITDA', fmt(k.ebitda, BASE), `${pct(k.ebitda_margin)} of revenue`, signTone(k.ebitda)),
        tile('Net result', fmt(k.net_result, BASE), `net margin ${pct(k.net_margin)}`, signTone(k.net_result)),
      ],
    ],
    [
      'Liquidity',
      [
        tile('Cash & bank', fmt(k.cash, BASE), `at ${k.to}`),
        tile('Working capital', fmt(k.working_capital, BASE), 'current assets minus current liabilities', signTone(k.working_capital)),
        tile('Current ratio', times(k.current_ratio), 'current assets ÷ current liabilities'),
        tile('Quick ratio', times(k.quick_ratio), '(cash + receivables) ÷ current liabilities'),
      ],
    ],
    [
      'Efficiency',
      [
        tile('Days sales outstanding', daysTxt(k.dso), 'receivables ÷ invoiced sales × days'),
        tile('Days payables outstanding', daysTxt(k.dpo), 'payables ÷ invoiced purchases × days'),
        tile('Overheads / revenue', pct(k.overhead_ratio), `depreciation ${fmt(k.depreciation, BASE)} not included`),
        tile('Realised FX result', `${k.fx_result >= 0 ? '+' : ''}${fmt(k.fx_result, BASE)}`, 'gains minus losses on settlements', signTone(k.fx_result)),
      ],
    ],
    [
      'Solvency',
      [
        tile('Solvency', pct(k.solvency), 'equity ÷ total assets'),
        tile('Return on equity', pct(k.return_on_equity), 'net result ÷ equity, for the period', signTone(k.return_on_equity)),
      ],
    ],
  ];
  document.getElementById('kpi-groups').innerHTML = groups
    .map(([title, tiles]) => `<div class="kpi-group"><h3>${esc(title)}</h3><div class="cards">${tiles.join('')}</div></div>`)
    .join('');
  renderKpiCharts();
}

function renderKpiCharts() {
  const k = lastKpis;
  if (!k) return;
  const labels = k.months.map((m) => m.period);
  lineChart(document.getElementById('chart-trend'), labels, [
    { name: 'Revenue', color: SERIES[0], values: k.months.map((m) => m.revenue) },
    { name: 'Gross profit', color: SERIES[1], values: k.months.map((m) => m.gross_profit) },
    { name: 'Net result', color: SERIES[2], values: k.months.map((m) => m.net_result) },
  ]);
  lineChart(document.getElementById('chart-cash'), labels, [{ name: 'Cash & bank', color: SERIES[0], values: k.months.map((m) => m.cash) }]);
  barChart(
    document.getElementById('chart-cc'),
    k.cost_by_cost_center.map((c) => ({ label: c.code ? `${c.code} ${c.name}` : c.name, value: c.costs, sub: 'operating costs' }))
  );
  document.getElementById('table-trend').innerHTML = `<table class="table"><thead><tr><th>Month</th><th class="num">Revenue</th><th class="num">Gross profit</th><th class="num">Net result</th></tr></thead><tbody>${k.months
    .map((m) => `<tr><td>${periodLabel(m.period)}</td><td class="num">${fmt(m.revenue)}</td><td class="num">${fmt(m.gross_profit)}</td><td class="num">${fmt(m.net_result)}</td></tr>`)
    .join('')}</tbody></table>`;
  document.getElementById('table-cash').innerHTML = `<table class="table"><thead><tr><th>Month end</th><th class="num">Cash &amp; bank</th></tr></thead><tbody>${k.months
    .map((m) => `<tr><td>${periodLabel(m.period)}</td><td class="num">${fmt(m.cash)}</td></tr>`)
    .join('')}</tbody></table>`;
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!document.getElementById('view-kpis').hidden) renderKpiCharts();
  }, 150);
});

// ---------- Fixed assets ----------

let ASSETS = [];
let assetFilter = '';

async function loadAssets() {
  const [data] = await Promise.all([api('/api/assets'), loadCostCenters(), loadPeriods()]);
  ASSETS = data.assets;
  const total = (k) => ASSETS.reduce((t, a) => t + a[k], 0);
  document.getElementById('asset-cards').innerHTML = `
    <div class="card"><div class="label">Cost</div><div class="value">${fmt(total('acquisition_cost'), BASE)}</div><div class="sub">${ASSETS.length} assets</div></div>
    <div class="card"><div class="label">Accumulated depreciation</div><div class="value">${fmt(total('accumulated_depreciation'), BASE)}</div><div class="sub">written off to date</div></div>
    <div class="card"><div class="label">Net book value</div><div class="value">${fmt(total('book_value'), BASE)}</div><div class="sub">cost minus depreciation</div></div>
    <div class="card"><div class="label">Depreciation per month</div><div class="value">${fmt(total('monthly_depreciation'), BASE)}</div><div class="sub">at current book values</div></div>`;

  const st = data.depreciation;
  const lastPeriods = (st.last_result || []).map((r) => r.period);
  document.getElementById('depr-status').textContent =
    `Depreciation is booked automatically as soon as a month has ended: the server checks on start-up and every ${st.runs_every_hours} hours` +
    (st.last_run ? ` (last check ${new Date(st.last_run).toLocaleString()}${lastPeriods.length ? `, booked ${lastPeriods.join(', ')}` : ', nothing due'})` : '') +
    '. You can also run it for a period by hand, e.g. the current month before closing it.';
  const sel = document.querySelector('#form-depr select[name=period]');
  const prev = sel.value;
  sel.innerHTML = [...PERIODS]
    .filter((p) => p.status === 'open' && p.period <= currentPeriod())
    .sort((a, b) => b.period.localeCompare(a.period))
    .map((p) => `<option value="${p.period}">${periodLabel(p.period)}${p.depreciation ? ` (booked ${fmt(p.depreciation, BASE)})` : ''}</option>`)
    .join('');
  if (prev) sel.value = prev;
  renderAssetTable();
}

function renderAssetTable() {
  const rows = ASSETS.filter((a) => !assetFilter || a.asset_type === assetFilter);
  const tbody = document.querySelector('#assets-table tbody');
  tbody.innerHTML = rows
    .map(
      (a) => `<tr class="clickable" data-id="${a.id}">
        <td><strong>${esc(a.asset_number)}</strong></td>
        <td><span class="entity-tag">${esc(a.entity_code)}</span></td>
        <td>${esc(a.name)}${a.description ? `<div class="muted">${esc(a.description)}</div>` : ''}</td>
        <td>${a.asset_type === 'machinery' ? 'Machinery' : 'Inventory'}</td>
        <td>${esc(ccName(a.cost_center))}</td>
        <td>${esc(a.acquisition_date)}</td>
        <td class="num">${fmt(a.acquisition_cost)}</td>
        <td class="num">${a.depreciation_rate}%<div class="muted">${a.useful_life_years} yrs</div></td>
        <td class="num">${fmt(a.accumulated_depreciation)}</td>
        <td class="num"><strong>${fmt(a.book_value)}</strong></td>
        <td class="num">${fmt(a.monthly_depreciation)}</td>
        <td>${a.status === 'In use' ? '<span class="badge paid">In use</span>' : '<span class="badge closed">Fully depreciated</span>'}</td>
      </tr>`
    )
    .join('');
  const sum = (k) => rows.reduce((t, a) => t + a[k], 0);
  tbody.innerHTML += `<tr class="total"><td colspan="6">Total${assetFilter ? ` ${assetFilter}` : ''}</td><td class="num">${fmt(sum('acquisition_cost'))}</td><td></td>
    <td class="num">${fmt(sum('accumulated_depreciation'))}</td><td class="num">${fmt(sum('book_value'))}</td><td class="num">${fmt(sum('monthly_depreciation'))}</td><td></td></tr>`;
  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openAssetDetail(Number(tr.dataset.id))));
}

document.getElementById('asset-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  assetFilter = btn.dataset.type;
  document.querySelectorAll('#asset-filter .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  renderAssetTable();
});

document.getElementById('form-depr').addEventListener('submit', async (e) => {
  e.preventDefault();
  const okEl = document.getElementById('depr-result');
  const errEl = document.getElementById('depr-error');
  okEl.textContent = '';
  errEl.textContent = '';
  try {
    const r = await post('/api/assets/depreciation', { period: e.target.period.value });
    await loadAssets();
    okEl.textContent = r.assets
      ? `Booked ${fmt(r.amount, BASE)} depreciation for ${periodLabel(r.period)} on ${r.assets} asset(s).`
      : `Nothing to book for ${periodLabel(r.period)}: every asset is already depreciated for that month.`;
  } catch (err) {
    errEl.textContent = err.message;
  }
});

async function openAssetDetail(id) {
  const a = await api(`/api/assets/${id}`);
  const upcoming = a.schedule.slice(0, 12);
  const last = a.schedule[a.schedule.length - 1];
  document.getElementById('detail-body').innerHTML = `
    <h2>${esc(a.asset_number)} ${esc(a.name)}</h2>
    ${a.description ? `<p class="hint">${esc(a.description)}</p>` : ''}
    <div class="detail-grid">
      <div><span class="k">Type:</span> ${esc(a.type_name)}</div>
      <div><span class="k">Cost centre:</span> ${esc(ccName(a.cost_center)) || '-'}</div>
      <div><span class="k">Acquired:</span> ${esc(a.acquisition_date)}</div>
      <div><span class="k">Cost:</span> ${fmt(a.acquisition_cost, BASE)}</div>
      <div><span class="k">Depreciation:</span> ${a.depreciation_rate}% a year (${a.useful_life_years} years), ${fmt(a.monthly_depreciation, BASE)} a month</div>
      <div><span class="k">Book value:</span> <strong>${fmt(a.book_value, BASE)}</strong> (${fmt(a.accumulated_depreciation, BASE)} written off)</div>
      ${a.opening_depreciation ? `<div><span class="k">Before these books:</span> ${fmt(a.opening_depreciation, BASE)} written off</div>` : ''}
      <div><span class="k">Status:</span> ${esc(a.status)}</div>
    </div>
    <div class="section-title">Ledgers</div>
    <p class="hint">Investment ${esc(a.accounts.cost.code)} ${esc(a.accounts.cost.name)} · Accumulated depreciation ${esc(a.accounts.accumulated.code)} ${esc(a.accounts.accumulated.name)} · Depreciation ${esc(a.accounts.expense.code)} ${esc(a.accounts.expense.name)}</p>
    <div class="grid-2 even">
      <div>
        <div class="section-title">Booked</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Period</th><th class="num">Depreciation</th></tr></thead><tbody>${
          a.history.map((h) => `<tr><td>${periodLabel(h.period)}</td><td class="num">${fmt(h.amount)}</td></tr>`).join('') ||
          '<tr><td colspan="2" class="hint">Nothing booked yet.</td></tr>'
        }</tbody></table></div>
      </div>
      <div>
        <div class="section-title">Coming months</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Period</th><th class="num">Depreciation</th><th class="num">Book value after</th></tr></thead><tbody>${
          upcoming.map((s) => `<tr><td>${periodLabel(s.period)}</td><td class="num">${fmt(s.amount)}</td><td class="num">${fmt(s.book_value_after)}</td></tr>`).join('') ||
          '<tr><td colspan="3" class="hint">Fully depreciated.</td></tr>'
        }</tbody></table></div>
        ${last && a.schedule.length > 12 ? `<p class="hint">…fully written off after ${periodLabel(last.period)}.</p>` : ''}
      </div>
    </div>`;
  document.getElementById('dialog-detail').showModal();
}

// ----- New asset dialog -----

const assetForm = document.getElementById('form-asset');

document.getElementById('btn-new-asset').addEventListener('click', async () => {
  await Promise.all([loadAccounts(), loadCostCenters()]);
  assetForm.reset();
  assetForm.asset_type.innerHTML = META.asset_types.map((t) => `<option value="${t.key}">${esc(t.name)}</option>`).join('');
  assetForm.cost_center.innerHTML = ccOptions('');
  assetForm.acquisition_date.value = today();
  fillEntityField(assetForm.entity_id);
  fillAssetContra();
  document.getElementById('asset-error').textContent = '';
  updateAssetHint();
  document.getElementById('dialog-asset').showModal();
});

/** "Paid from" choices: the entity's GBP bank accounts first, then other balance sheet accounts it may use. */
function fillAssetContra() {
  const ok = forEntity(assetForm.entity_id.value);
  const banks = bankAccounts().filter((b) => b.bank_currency === BASE && ok(b));
  assetForm.contra_account.innerHTML =
    banks.map((b) => `<option value="${esc(b.code)}">${esc(accountLabel(b))}</option>`).join('') +
    accountOptions((a) => ok(a) && a.statement === 'BS' && a.category !== 'cash' && a.category !== 'fixed_assets' && a.category !== 'accumulated_depreciation');
}
assetForm.entity_id.addEventListener('change', fillAssetContra);

function updateAssetHint() {
  const cost = parseFloat(assetForm.acquisition_cost.value) || 0;
  const rate = parseFloat(assetForm.depreciation_rate.value) || 0;
  document.getElementById('asset-hint').textContent =
    rate > 0
      ? `Written off over ${round2(100 / rate)} years: ${fmt((cost * rate) / 100, BASE)} a year, ${fmt(round2((cost * rate) / 1200), BASE)} a month, starting in the month of acquisition.`
      : '';
}
assetForm.addEventListener('input', updateAssetHint);

assetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    entity_id: Number(assetForm.entity_id.value),
    name: assetForm.name.value.trim(),
    description: assetForm.description.value.trim(),
    asset_type: assetForm.asset_type.value,
    cost_center: assetForm.cost_center.value || null,
    acquisition_date: assetForm.acquisition_date.value,
    acquisition_cost: parseFloat(assetForm.acquisition_cost.value),
    depreciation_rate: parseFloat(assetForm.depreciation_rate.value),
    booking: assetForm.booking.value,
    contra_account: assetForm.contra_account.value,
  };
  try {
    await post('/api/assets', payload);
    document.getElementById('dialog-asset').close();
    loadAssets();
  } catch (err) {
    document.getElementById('asset-error').textContent = err.message;
  }
});

// ---------- Pay a purchase invoice through the company's bank ----------

// Main UK business banks and payment apps, offered in the (simulated) pay window.
const UK_BANKS = [
  { name: 'Barclays' },
  { name: 'HSBC UK' },
  { name: 'Lloyds Bank' },
  { name: 'NatWest' },
  { name: 'Royal Bank of Scotland' },
  { name: 'Santander UK' },
  { name: 'Bank of Scotland' },
  { name: 'TSB' },
  { name: 'Metro Bank' },
  { name: 'Nationwide' },
  { name: 'Starling Bank' },
  { name: 'Monzo' },
  { name: 'Tide' },
  { name: 'Revolut Business' },
  { name: 'Wise Business' },
];

function bankDetailsText(p) {
  const parts = [];
  if (p.sort_code || p.account_number) parts.push(`${p.sort_code || '?'} / ${p.account_number || '?'}`);
  if (p.iban) parts.push(`IBAN ${p.iban}${p.bic ? ` (${p.bic})` : ''}`);
  return parts.join(' · ');
}

function rememberedBank() {
  try {
    return localStorage.getItem('nb-bank');
  } catch {
    return null;
  }
}

/**
 * Simulated bank payment window: review -> bank login -> authorise -> done.
 * Everything happens inside the app; no real bank is contacted and no money
 * moves. Approving books the payment on the invoice.
 */
const pay = { inv: null, supplier: null, amount: 0, from: null, bank: null, step: 'review', rates: {}, result: null, error: '' };

async function openPayDialog(inv) {
  await Promise.all([loadParties(), loadAccounts()]);
  const banks = bankAccounts().filter(forEntity(inv.entity_id));
  Object.assign(pay, {
    inv,
    supplier: SUPPLIERS.find((x) => x.id === inv.party_id) || { name: inv.party_name },
    amount: inv.remaining_amount,
    from: (banks.find((b) => b.bank_currency === inv.currency) || banks.find((b) => b.bank_currency === BASE) || banks[0]).code,
    bank: rememberedBank(),
    step: 'review',
    rates: {},
    result: null,
    error: '',
  });
  document.getElementById('dialog-pay').showModal();
  await loadPayRates();
  renderPay();
}

async function loadPayRates() {
  const date = today();
  for (const c of META.currencies) {
    if (pay.rates[c]) continue;
    try {
      pay.rates[c] = c === BASE ? 1 : (await api(`/api/fx/rate?currency=${c}&date=${date}`)).rate;
    } catch {
      pay.rates[c] = null;
    }
  }
}

const payFromAccount = () => ACCOUNTS.find((a) => a.code === pay.from);

/** What leaves the chosen account, converted by the bank at today's ECB rates. */
function payDebit() {
  const acc = payFromAccount();
  if (acc.bank_currency === pay.inv.currency) return pay.amount;
  const r1 = pay.rates[pay.inv.currency];
  const r2 = pay.rates[acc.bank_currency];
  return r1 && r2 ? round2((pay.amount * r1) / r2) : null;
}

function bankInitials(name) {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 3);
}

function renderPay() {
  const body = document.getElementById('pay-body');
  const inv = pay.inv;
  const s = pay.supplier;
  const acc = payFromAccount();
  const debit = payDebit();
  const payeeLines = [
    s.sort_code && s.account_number ? `Sort code ${s.sort_code} · Account ${s.account_number}` : '',
    s.iban ? `IBAN ${s.iban}${s.bic ? ` · BIC ${s.bic}` : ''}` : '',
  ].filter(Boolean);
  const conversion =
    acc.bank_currency !== inv.currency && debit !== null
      ? `<p class="hint">Your bank converts ${fmt(pay.amount, inv.currency)} into about <strong>${fmt(debit, acc.bank_currency)}</strong> at today's ECB rate. Any difference with the invoice's booked rate is posted as a realised FX gain or loss.</p>`
      : '';
  const bankHeader = (subtitle) => `
    <div class="sim-bank-bar">
      <span class="bank-mark">${esc(bankInitials(pay.bank || 'Bank'))}</span>
      <div><div class="sim-bank-name">${esc(pay.bank)}</div><div class="sim-bank-sub">${esc(subtitle)}</div></div>
      <span class="sim-badge">Simulated bank · no real money</span>
    </div>`;
  const summary = () => `
    <div class="pay-fields">
      <div class="pay-field"><span class="k">From</span><strong>${esc(inv.entity_name)} · ${esc(acc.name)}${acc.iban ? ` · ${esc(acc.iban)}` : ''}</strong></div>
      <div class="pay-field"><span class="k">To</span><strong>${esc(s.name)}${payeeLines.length ? `<div class="muted">${esc(payeeLines.join(' · '))}</div>` : ''}</strong></div>
      <div class="pay-field"><span class="k">Amount</span><strong>${fmt(pay.amount, inv.currency)}${acc.bank_currency !== inv.currency && debit !== null ? ` <span class="muted">(${fmt(debit, acc.bank_currency)} from your account)</span>` : ''}</strong></div>
      <div class="pay-field"><span class="k">Reference</span><strong>${esc(inv.invoice_number)}</strong></div>
      <div class="pay-field"><span class="k">Date</span><strong>${esc(today())} (immediate payment)</strong></div>
    </div>`;
  const error = pay.error ? `<p class="error">${esc(pay.error)}</p>` : '';

  if (pay.step === 'review') {
    const banks = bankAccounts().filter(forEntity(inv.entity_id));
    body.innerHTML = `
      <div class="form">
        <h2>Pay ${esc(inv.invoice_number)} - ${esc(inv.party_name)}</h2>
        <p class="hint">Open: ${fmt(inv.remaining_amount, inv.currency)} of ${fmt(inv.total_amount, inv.currency)}.</p>
        <div class="row">
          <label>Amount (${inv.currency})<input id="pay-amount" type="number" min="0.01" step="0.01" max="${inv.remaining_amount}" value="${pay.amount.toFixed(2)}" /></label>
          <label>Pay from<select id="pay-from">${banks.map((b) => `<option value="${esc(b.code)}" ${b.code === pay.from ? 'selected' : ''}>${esc(accountLabel(b))} (${b.bank_currency})</option>`).join('')}</select></label>
        </div>
        ${conversion}
        ${payeeLines.length ? '' : '<p class="error">This supplier has no bank details yet - add them under Setup → Suppliers → Edit before paying.</p>'}
        <div class="section-title">Your bank</div>
        <div class="bank-grid">${UK_BANKS.map(
          (b) => `<button type="button" class="bank-btn ${b.name === pay.bank ? 'selected' : ''}" data-bank="${esc(b.name)}"><span class="bank-mark">${esc(bankInitials(b.name))}</span>${esc(b.name)}</button>`
        ).join('')}</div>
        ${error}
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-pay="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-pay="continue" ${pay.bank && payeeLines.length ? '' : 'disabled'}>Continue to ${esc(pay.bank || 'bank')}</button>
      </div>`;
    body.querySelector('#pay-amount').addEventListener('input', (e) => {
      pay.amount = round2(parseFloat(e.target.value) || 0);
      renderPayHintOnly();
    });
    body.querySelector('#pay-from').addEventListener('change', (e) => {
      pay.from = e.target.value;
      renderPay();
    });
    body.querySelectorAll('.bank-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        pay.bank = btn.dataset.bank;
        try {
          localStorage.setItem('nb-bank', pay.bank);
        } catch {
          /* remembering the bank is optional */
        }
        renderPay();
      })
    );
  } else if (pay.step === 'login') {
    body.innerHTML = `
      <div class="sim-bank">
        ${bankHeader('Business online banking')}
        <div class="sim-bank-body">
          <h2>Log in to approve a payment</h2>
          <p class="hint">Northbridge Books is asking to make a payment from your account. This is a simulation: there is no real login, so never enter real bank details here.</p>
          <div class="pay-fields">
            <div class="pay-field"><span class="k">Customer</span><strong>${esc(inv.entity_name)} (demo)</strong></div>
            <div class="pay-field"><span class="k">Security</span><strong>Demo passcode accepted automatically</strong></div>
          </div>
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-pay="back">Back</button>
        <button type="button" class="btn btn-primary" data-pay="login">Log in (demo)</button>
      </div>`;
  } else if (pay.step === 'authorise') {
    body.innerHTML = `
      <div class="sim-bank">
        ${bankHeader('Approve payment')}
        <div class="sim-bank-body">
          <h2>Check and approve this payment</h2>
          ${summary()}
          ${error}
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-pay="cancel">Cancel payment</button>
        <button type="button" class="btn btn-primary" data-pay="approve">Approve payment</button>
      </div>`;
  } else if (pay.step === 'processing') {
    body.innerHTML = `
      <div class="sim-bank">
        ${bankHeader('Approve payment')}
        <div class="sim-bank-body center"><div class="spinner"></div><p>Sending payment…</p></div>
      </div>`;
  } else if (pay.step === 'done') {
    const r = pay.result;
    const fxAmt = r.payment.fx_gain_loss;
    body.innerHTML = `
      <div class="sim-bank">
        ${bankHeader('Payment sent')}
        <div class="sim-bank-body center">
          <div class="done-mark">✓</div>
          <h2>Payment sent</h2>
          <p>${fmt(r.payment.amount, inv.currency)} to ${esc(s.name)}, reference ${esc(inv.invoice_number)}.</p>
          <p class="hint">Bank transaction ${esc(r.transaction_reference)} · ${fmt(r.bank_amount, r.bank_currency)} from ${esc(acc.name)}</p>
          <p>Invoice ${esc(inv.invoice_number)} is now <strong>${esc(r.invoice.status)}</strong>${fxAmt ? `, with a realised FX ${fxAmt > 0 ? 'gain' : 'loss'} of ${fmt(Math.abs(fxAmt), BASE)}` : ''}.</p>
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-pay="close">Done</button>
      </div>`;
  }

  body.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', () => payAction(btn.dataset.pay)));
}

// Update only the conversion hint while typing, so the amount field keeps focus.
function renderPayHintOnly() {
  const inv = pay.inv;
  const acc = payFromAccount();
  const debit = payDebit();
  const hint = document.querySelector('#pay-body .row + .hint');
  if (hint && acc.bank_currency !== inv.currency && debit !== null) {
    hint.innerHTML = `Your bank converts ${fmt(pay.amount, inv.currency)} into about <strong>${fmt(debit, acc.bank_currency)}</strong> at today's ECB rate. Any difference with the invoice's booked rate is posted as a realised FX gain or loss.`;
  }
}

async function payAction(action) {
  pay.error = '';
  if (action === 'cancel' || action === 'close') {
    document.getElementById('dialog-pay').close();
    if (action === 'close') refreshActive();
    return;
  }
  if (action === 'continue') {
    if (!(pay.amount > 0) || pay.amount > pay.inv.remaining_amount + 0.005) {
      pay.error = `Enter an amount between 0.01 and ${pay.inv.remaining_amount.toFixed(2)} ${pay.inv.currency}.`;
    } else {
      pay.step = 'login';
    }
  } else if (action === 'back') {
    pay.step = 'review';
  } else if (action === 'login') {
    pay.step = 'authorise';
  } else if (action === 'approve') {
    pay.step = 'processing';
    renderPay();
    try {
      const [result] = await Promise.all([
        post(`/api/invoices/${pay.inv.id}/simulated-payment`, { bank_account: pay.from, amount: pay.amount, bank_name: pay.bank }),
        new Promise((r) => setTimeout(r, 900)), // a short pause, like a real bank confirming
      ]);
      pay.result = result;
      pay.step = 'done';
    } catch (err) {
      pay.error = err.message;
      pay.step = 'authorise';
    }
  }
  renderPay();
}

// ---------- Ledger account overview ----------

const accountPeriodForm = document.getElementById('form-account-period');
let accountViewCode = null;

accountPeriodForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadAccountView(accountViewCode);
});
document.getElementById('account-back').addEventListener('click', (e) => {
  e.preventDefault();
  if (history.length > 1) history.back();
  else showTab('ledger');
});

async function loadAccountView(code) {
  if (code !== accountViewCode) accountPeriodForm.cost_center.value = '';
  accountViewCode = code;
  await Promise.all([loadPeriods(), loadCostCenters(), loadAccounts()]);
  fillPeriodSelects(accountPeriodForm);
  const ccSel = accountPeriodForm.cost_center;
  const ccPrev = ccSel.value;
  ccSel.innerHTML =
    '<option value="">All</option>' + COST_CENTERS.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} ${esc(c.name)}</option>`).join('') + '<option value="none">Unallocated</option>';
  ccSel.value = ccPrev;
  const { from, to } = periodRange(accountPeriodForm);
  const d = await api(`/api/accounts/${encodeURIComponent(code)}/detail?from=${from}&to=${to}${ccSel.value ? `&cost_center=${encodeURIComponent(ccSel.value)}` : ''}`);
  const a = d.account;
  const isPl = a.statement === 'PL';
  // Cost centres only exist on P&L lines.
  ccSel.closest('label').hidden = !isPl;
  const nat = (v) => fmt(d.sign * v);
  document.getElementById('account-title').textContent = `${a.code} ${a.name}`;
  document.getElementById('account-meta').textContent =
    `${a.category_name} · ${isPl ? 'profit & loss' : 'balance sheet'} · ${d.sign > 0 ? 'debit' : 'credit'} balance is positive` +
    (a.entity_id ? ` · only used by ${entityName(a.entity_id)}` : '') +
    ` · ${d.from} to ${d.to}` +
    (d.cost_center ? ` · cost centre ${d.cost_center === 'none' ? 'unallocated' : ccName(d.cost_center)}` : '');
  document.getElementById('account-cards').innerHTML = `
    <div class="card"><div class="label">${isPl ? 'Before the period' : 'Opening balance'}</div><div class="value">${nat(d.opening)}</div><div class="sub">at ${esc(dayBeforeIso(d.from))}</div></div>
    <div class="card"><div class="label">Debits</div><div class="value">${fmt(d.debit)}</div><div class="sub">${d.entries.length} entries</div></div>
    <div class="card"><div class="label">Credits</div><div class="value">${fmt(d.credit)}</div><div class="sub">in the period</div></div>
    <div class="card"><div class="label">${isPl ? 'Total for the period' : 'Closing balance'}</div><div class="value">${isPl ? nat(d.debit - d.credit) : nat(d.closing)}</div><div class="sub">${isPl ? `cumulative ${nat(d.closing)}` : `at ${esc(d.to)}`}</div></div>`;

  const groupTable = (rows, label, nameOf) =>
    rows.length
      ? `<thead><tr><th>${label}</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Net</th></tr></thead><tbody>${rows
          .map((g) => `<tr><td>${esc(nameOf(g))}</td><td class="num">${fmt(g.debit)}</td><td class="num">${fmt(g.credit)}</td><td class="num"><strong>${fmt(g.net)}</strong></td></tr>`)
          .join('')}</tbody>`
      : '<tbody><tr><td class="hint">Nothing booked in this period.</td></tr></tbody>';
  document.getElementById('account-months').innerHTML = groupTable(d.by_month, 'Month', (g) => periodLabel(g.key));
  document.getElementById('account-ccs').innerHTML = isPl
    ? groupTable(d.by_cost_center, 'Cost centre', (g) => g.name)
    : '<tbody><tr><td class="hint">Cost centres are only used on P&amp;L accounts.</td></tr></tbody>';

  const table = document.getElementById('account-entries');
  table.innerHTML = `<thead><tr><th>Date</th><th>Entity</th><th>Journal</th><th>Description</th><th>Cost centre</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th><th></th></tr></thead>
    <tbody>
      <tr class="total"><td colspan="7">${isPl ? 'Before the period' : 'Opening balance'}</td><td class="num">${nat(d.opening)}</td><td></td></tr>
      ${d.entries
        .map(
          (e) => `<tr class="clickable" data-journal="${e.journal_id}">
            <td>${esc(e.entry_date)}</td><td><span class="entity-tag">${esc(e.entity_code)}</span></td>
            <td>${esc(e.reference || '')} <span class="badge src-${esc(e.source_type)}">${esc(SOURCE_LABEL[e.source_type] || e.source_type)}</span></td>
            <td>${esc(e.description)}${e.fx_note ? `<div class="muted">${esc(e.fx_note)}</div>` : ''}</td>
            <td>${esc(ccName(e.cost_center))}</td>
            <td class="num">${e.debit ? fmt(e.debit) : ''}</td><td class="num">${e.credit ? fmt(e.credit) : ''}</td><td class="num">${nat(e.balance)}</td>
            <td><button type="button" class="btn btn-small btn-edit-entry" data-edit-journal="${e.journal_id}" title="Edit this entry's journal">Edit</button> <button type="button" class="btn btn-small btn-delete" data-delete="journal" data-id="${e.journal_id}">Delete</button></td></tr>`
        )
        .join('')}
      <tr class="total"><td colspan="5">${isPl ? 'Cumulative at' : 'Closing balance at'} ${esc(d.to)}</td><td class="num">${fmt(d.debit)}</td><td class="num">${fmt(d.credit)}</td><td class="num">${nat(d.closing)}</td><td></td></tr>
    </tbody>`;
  bindJournalRows(table);
}

function dayBeforeIso(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------- Reclassify a journal that follows a source document ----------

const reclassForm = document.getElementById('form-reclass');
let reclassJournal = null;

async function openReclassDialog(j) {
  await Promise.all([loadAccounts(), loadCostCenters()]);
  reclassJournal = j;
  document.getElementById('reclass-title').textContent = `Edit journal ${j.reference || j.id} (${(SOURCE_LABEL[j.source_type] || j.source_type).toLowerCase()})`;
  document.getElementById('reclass-hint').textContent =
    'The amounts and date follow the source document. You can change the description, and move P&L lines to another P&L account and/or cost centre; balance sheet lines stay as they are.';
  document.getElementById('reclass-error').textContent = '';
  reclassForm.description.value = j.description;
  const plAccount = (a) => a.statement === 'PL' && forEntity(j.entity_id)(a);
  document.querySelector('#reclass-lines tbody').innerHTML = j.lines
    .map((l) => {
      const pl = isPlAccount(l.account_code);
      return `<tr data-line="${l.id}" data-pl="${pl ? 1 : 0}">
        <td>${pl ? `<select class="r-account">${accountOptions(plAccount, l.account_code)}</select>` : `${esc(l.account_code)} ${esc(l.account_name)} <span class="muted">(fixed)</span>`}</td>
        <td>${pl ? `<select class="r-cc">${ccOptions(l.cost_center || '')}</select>` : '<span class="muted">-</span>'}</td>
        <td class="num">${l.debit ? fmt(l.debit) : ''}</td><td class="num">${l.credit ? fmt(l.credit) : ''}</td></tr>`;
    })
    .join('');
  document.getElementById('dialog-reclass').showModal();
}

reclassForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const lines = [...document.querySelectorAll('#reclass-lines tbody tr[data-pl="1"]')].map((tr) => ({
    id: Number(tr.dataset.line),
    account_code: tr.querySelector('.r-account').value,
    cost_center: tr.querySelector('.r-cc').value || null,
  }));
  try {
    await post(`/api/journals/${reclassJournal.id}`, { description: reclassForm.description.value.trim(), lines }, 'PUT');
    document.getElementById('dialog-reclass').close();
    refreshActive();
  } catch (err) {
    document.getElementById('reclass-error').textContent = err.message;
  }
});

// ---------- Dialog wiring & init ----------

document.querySelectorAll('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

// ---------- Invoice recognition (upload a PDF) ----------

const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let recognition = null; // { document_id, suggestion, pdf, zones, active } while an invoice is made from a PDF

/**
 * Read a PDF with pdf.js: its text as lines in reading order (columns split
 * by " | ") and every text item with its box as fractions of the page (from
 * the top left). The loaded document is kept to draw the pages next to the form.
 */
async function pdfRead(buffer) {
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) throw new Error('The PDF reader could not be loaded - check your internet connection');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: buffer }).promise;
  const lines = [];
  const items = [];
  for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const rows = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const [x, y] = [it.transform[4], it.transform[5]];
      const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      // Top-left corner and size in page fractions.
      const [left, top] = vp.convertToViewportPoint(x, y + h);
      items.push({ p, x: left / vp.width, y: top / vp.height, w: it.width / vp.width, h: h / vp.height, s: it.str });
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, end: x + it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const it of r.items) {
        if (prevEnd !== null) line += it.x - prevEnd > 15 ? ' | ' : it.x - prevEnd > 1 ? ' ' : '';
        line += it.s;
        prevEnd = it.end;
      }
      lines.push(line.replace(/\s+/g, ' ').trim());
    }
  }
  return { doc, lines, items };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('The file could not be read'));
    r.readAsDataURL(file);
  });
}

function showNotice(message, kind = 'ok') {
  const el = document.getElementById('notice-banner');
  el.textContent = message;
  el.className = `notice-banner ${kind}`;
  el.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => (el.hidden = true), 12000);
}

async function recogniseFile(file) {
  const status = document.getElementById('recognise-status');
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return showNotice('Please choose a PDF file.', 'bad');
  if (file.size > 3 * 1024 * 1024) return showNotice('The PDF is larger than 3 MB.', 'bad');
  status.textContent = `Reading ${file.name}…`;
  try {
    const [base64, read] = await Promise.all([fileToBase64(file), file.arrayBuffer().then(pdfRead)]);
    status.textContent = 'Recognising…';
    const s = await post('/api/recognition/extract', {
      filename: file.name,
      pdf_base64: base64,
      lines: read.lines,
      items: read.items.map((i) => ({ ...i, x: +i.x.toFixed(5), y: +i.y.toFixed(5), w: +i.w.toFixed(5), h: +i.h.toFixed(5) })),
      entity_id: Number(CURRENT_ENTITY || META.entities[0].id),
    });
    status.textContent = '';
    recognition = { document_id: s.document_id, suggestion: s, pdf: read.doc, filename: file.name, zones: {}, active: null };
    await openInvoiceDialog('purchase', s);
  } catch (err) {
    status.textContent = '';
    showNotice(`Could not read ${file.name}: ${err.message}`, 'bad');
  }
}

// ----- Teaching positions: click a field, then drag a box on the PDF -----

const FIELD_LABEL = {
  invoice_number: 'invoice number',
  invoice_date: 'invoice date',
  due_date: 'due date',
  description: 'description',
  net: 'net amount',
  vat: 'VAT amount',
  total: 'total',
};
const firstLine = (sel) => document.querySelector(`#invoice-lines tbody tr ${sel}`);
const TEACH_FIELDS = {
  invoice_number: () => invoiceForm.invoice_number,
  invoice_date: () => invoiceForm.invoice_date,
  due_date: () => invoiceForm.due_date,
  description: () => firstLine('.l-desc'),
  net: () => firstLine('.l-net'),
  total: () => invoiceForm.pdf_total,
};

function setTeachHint(html, warn = false) {
  const bar = document.getElementById('teach-bar');
  bar.innerHTML = html;
  bar.classList.toggle('warn', warn);
}

const DEFAULT_TEACH_HINT =
  'To teach the app where something is on this supplier’s invoices: click a field on the right (invoice number, dates, description, net amount or total), then drag a box around its value here.';

function setTeachField(field) {
  recognition.active = field;
  document.querySelectorAll('.teach-active').forEach((el) => el.classList.remove('teach-active'));
  const el = field && TEACH_FIELDS[field]();
  if (el) el.classList.add('teach-active');
  setTeachHint(field ? `📍 Now drag a box around the <strong>${FIELD_LABEL[field]}</strong> on the invoice.` : DEFAULT_TEACH_HINT);
}

// Clicking a teachable field while a PDF is shown makes it the field to teach.
invoiceForm.addEventListener('focusin', (e) => {
  if (!recognition) return;
  const field = Object.keys(TEACH_FIELDS).find((k) => TEACH_FIELDS[k]() === e.target);
  if (field) setTeachField(field);
});

/** Draw the PDF's pages next to the form, with the marked positions on top. */
async function renderPdfPreview() {
  const box = document.getElementById('pdf-pages');
  box.replaceChildren();
  const doc = recognition.pdf;
  // Leave room for the padding and a vertical scrollbar.
  const width = Math.max(300, (box.clientWidth || 560) - 40);
  for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const ratio = window.devicePixelRatio || 1;
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.style.width = `${vp.width}px`;
    wrap.style.height = `${vp.height}px`;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * ratio);
    canvas.height = Math.floor(vp.height * ratio);
    const overlay = document.createElement('div');
    overlay.className = 'pdf-overlay';
    overlay.dataset.page = p;
    wrap.append(canvas, overlay);
    box.appendChild(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: vp.scale * ratio }) }).promise;
    bindZoneDrawing(overlay, p);
  }
  drawZones();
}

function placeBox(el, z) {
  el.style.left = `${z.x0 * 100}%`;
  el.style.top = `${z.y0 * 100}%`;
  el.style.width = `${(z.x1 - z.x0) * 100}%`;
  el.style.height = `${(z.y1 - z.y0) * 100}%`;
}

/** Show learned positions (dashed green) and the ones marked now (purple), labelled by field. */
function drawZones() {
  document.querySelectorAll('.pdf-overlay .zone').forEach((z) => z.remove());
  const all = [
    ...Object.entries(recognition.suggestion.zones || {}).filter(([f]) => !recognition.zones[f]).map(([f, z]) => [f, z, 'learned']),
    ...Object.entries(recognition.zones).map(([f, z]) => [f, z, 'taught']),
  ];
  for (const [field, z, kind] of all) {
    const overlay = document.querySelector(`.pdf-overlay[data-page="${z.page}"]`);
    if (!overlay) continue;
    const el = document.createElement('div');
    el.className = `zone ${kind}`;
    placeBox(el, z);
    const tag = document.createElement('span');
    tag.textContent = FIELD_LABEL[field] || field;
    el.appendChild(tag);
    overlay.appendChild(el);
  }
}

function bindZoneDrawing(overlay, page) {
  overlay.addEventListener('pointerdown', (e) => {
    if (!recognition.active) {
      setTeachHint('First click the field on the right you want to teach, then draw a box around its value here.', true);
      return;
    }
    e.preventDefault();
    const r = overlay.getBoundingClientRect();
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const sx = clamp((e.clientX - r.left) / r.width);
    const sy = clamp((e.clientY - r.top) / r.height);
    const rect = document.createElement('div');
    rect.className = 'zone drawing';
    overlay.appendChild(rect);
    overlay.setPointerCapture(e.pointerId);
    let zone = null;
    const move = (ev) => {
      const x = clamp((ev.clientX - r.left) / r.width);
      const y = clamp((ev.clientY - r.top) / r.height);
      zone = { page, x0: Math.min(sx, x), y0: Math.min(sy, y), x1: Math.max(sx, x), y1: Math.max(sy, y) };
      placeBox(rect, zone);
    };
    const up = () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      rect.remove();
      if (zone && zone.x1 - zone.x0 > 0.004 && zone.y1 - zone.y0 > 0.004) teachZone(recognition.active, zone);
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
  });
}

/** Read the value inside the drawn box, put it in the field and remember the box for saving. */
async function teachZone(field, zone) {
  try {
    const res = await post('/api/recognition/read-zone', {
      document_id: recognition.document_id,
      field,
      zone,
      supplier_id: Number(invoiceForm.party_id.value) || null,
    });
    if (res.value === null || res.value === undefined) {
      setTeachHint(`No ${FIELD_LABEL[field]} found in that box (it contains: “${esc(res.text || 'nothing')}”). Try a slightly bigger box.`, true);
      return;
    }
    const el = TEACH_FIELDS[field]();
    const shown = typeof res.value === 'number' ? res.value.toFixed(2) : res.value;
    el.value = shown;
    el.classList.remove('rec-learned', 'rec-generic', 'rec-guess', 'rec-missing', 'teach-active');
    el.classList.add('rec-taught');
    el.title = 'Read from the box you drew - remembered for this supplier when you save';
    recognition.zones[field] = res.zone;
    recognition.active = null;
    updateInvoiceTotals();
    drawZones();
    setTeachHint(`✓ ${FIELD_LABEL[field][0].toUpperCase() + FIELD_LABEL[field].slice(1)} set to <strong>${esc(shown)}</strong>; its position is remembered for this supplier when you save. Click another field to teach more.`);
  } catch (err) {
    setTeachHint(esc(err.message), true);
  }
}

document.getElementById('btn-upload-invoice').addEventListener('click', () => document.getElementById('invoice-pdf-input').click());
document.getElementById('invoice-pdf-input').addEventListener('change', (e) => {
  recogniseFile(e.target.files[0]);
  e.target.value = '';
});
// Drop a PDF anywhere on the purchase invoices page.
const purchasesView = document.getElementById('view-purchases');
purchasesView.addEventListener('dragover', (e) => {
  if (!isAdmin()) return;
  e.preventDefault();
  purchasesView.classList.add('drop-target');
});
purchasesView.addEventListener('dragleave', () => purchasesView.classList.remove('drop-target'));
purchasesView.addEventListener('drop', (e) => {
  if (!isAdmin()) return;
  e.preventDefault();
  purchasesView.classList.remove('drop-target');
  recogniseFile(e.dataTransfer.files[0]);
});

const SOURCE_TEXT = {
  learned: 'learned from earlier invoices of this supplier',
  generic: 'recognised',
  calculated: 'calculated from the other amounts',
  supplier: "the supplier's usual value",
  guess: 'a guess - please check',
  default: 'a default - please check',
};
const sourceClass = (src) => (src === 'learned' ? 'rec-learned' : src === 'guess' || src === 'default' ? 'rec-guess' : 'rec-generic');

function mark(el, field) {
  el.classList.remove('rec-learned', 'rec-generic', 'rec-guess', 'rec-missing', 'rec-taught');
  el.removeAttribute('title');
  if (!recognition) return;
  const f = field ? recognition.suggestion[field] : null;
  if (!f) {
    el.classList.add('rec-missing');
    el.title = 'Not found on the invoice - please fill in';
    return;
  }
  el.classList.add(sourceClass(f.source));
  el.title = `${SOURCE_TEXT[f.source] || f.source}${f.label ? ` (next to "${f.label}")` : ''}`;
}

/** Fill the invoice form from a recognition suggestion. */
function applySuggestion(s) {
  const f = invoiceForm;
  if (s.supplier) f.party_id.value = String(s.supplier.value);
  syncInvoiceCurrency();
  if (s.currency) f.currency.value = s.currency.value;
  if (s.invoice_number) f.invoice_number.value = s.invoice_number.value;
  if (s.invoice_date) f.invoice_date.value = s.invoice_date.value;
  f.due_date.value = s.due_date ? s.due_date.value : '';
  document.querySelector('#invoice-lines tbody').innerHTML = '';
  for (const l of s.lines) {
    addInvoiceLine();
    const tr = document.querySelector('#invoice-lines tbody tr:last-child');
    tr.querySelector('.l-desc').value = l.description || '';
    tr.querySelector('.l-account').value = l.account_code;
    syncCcSelect(tr.querySelector('.l-account'), tr.querySelector('.l-cc'));
    tr.querySelector('.l-cc').value = l.cost_center || '';
    tr.querySelector('.l-net').value = l.net_amount ? l.net_amount.toFixed(2) : '';
    if (l.vat_code) {
      tr.querySelector('.l-vat-code').value = l.vat_code;
      tr.querySelector('.l-vat-code').dataset.touched = '1';
    }
    tr.querySelectorAll('.l-account, .l-cc').forEach((el) => {
      el.classList.add(sourceClass(l.source));
      el.title = SOURCE_TEXT[l.source];
    });
    mark(tr.querySelector('.l-net'), 'net');
    mark(tr.querySelector('.l-vat-code'), 'vat_code');
  }
  mark(f.party_id, 'supplier');
  mark(f.invoice_number, 'invoice_number');
  mark(f.invoice_date, 'invoice_date');
  if (s.due_date) mark(f.due_date, 'due_date');
  f.pdf_total.value = s.total ? s.total.value.toFixed(2) : '';
  mark(f.pdf_total, 'total');
  mark(f.currency, 'currency');
  refreshInvoiceRate();
  updateInvoiceTotals();

  const pct = (x) => `${Math.round(x * 100)}%`;
  const who = s.supplier ? `<strong>${esc(s.supplier.name)}</strong> (found by ${esc(s.supplier.reasons.join(', '))})` : '<strong class="neg">no supplier recognised - please choose one</strong>';
  const history = s.profile
    ? `Learned from ${s.profile.documents} earlier invoice(s) of this supplier${s.profile.accuracy !== null ? `, ${pct(s.profile.accuracy)} of fields right so far` : ''}.`
    : 'First invoice from this supplier: your corrections teach the app for next time.';
  document.getElementById('recognition-banner').innerHTML = `
    <div>Read <strong>${esc(recognition.filename)}</strong>: ${who}. ${history}</div>
    ${s.no_text ? '<div class="neg">This PDF has no text layer (probably a scan), so nothing could be read - please fill in the invoice.</div>' : ''}
    ${s.total && s.total.mismatch ? '<div class="neg">The net and VAT on the invoice don’t add up to its total - please check the amounts.</div>' : ''}
    <div class="legend"><span class="rec-learned">learned</span> <span class="rec-generic">recognised</span> <span class="rec-guess">please check</span> <span class="rec-missing">not found</span> <span class="rec-taught">marked on the PDF</span> - hover a field to see why. Correct anything wrong (type it, or click the field and draw a box on the PDF), then save.</div>`;
}

/** Totals the form will book vs the total printed on the invoice. */
function recognitionTotalCheck(formTotal) {
  const t = recognition ? parseFloat(invoiceForm.pdf_total.value) : NaN;
  if (!Number.isFinite(t)) return '';
  const ok = Math.abs(t - formTotal) < 0.005;
  return ` · invoice says ${fmt(t, invoiceForm.currency.value)} <strong class="${ok ? 'pos' : 'neg'}">${ok ? '✓' : '≠ check the lines'}</strong>`;
}

// ----- Setup: what recognition has learned -----

async function loadRecognitionProfiles() {
  const profiles = await api('/api/recognition/profiles');
  const tbody = document.querySelector('#recognition-table tbody');
  const labelText = (labels) =>
    Object.entries(labels)
      .map(([k, v]) => `${k.replace('_', ' ')}: "${v[0]}"`)
      .join(', ');
  tbody.innerHTML =
    profiles
      .map(
        (p) => `<tr>
        <td><strong>${esc(p.supplier_name)}</strong></td>
        <td class="num">${p.documents}</td>
        <td class="num">${p.accuracy === null ? '' : Math.round(p.accuracy * 100) + '%'}</td>
        <td>${p.last ? `${p.last.correct}/${p.last.checked} right${p.last.corrected.length ? ` <span class="muted">(corrected: ${esc(p.last.corrected.join(', ').replace(/_/g, ' '))})</span>` : ''}` : ''}</td>
        <td class="muted">${esc(labelText(p.labels))}${p.date_order ? ` · dates ${p.date_order === 'MDY' ? 'm/d/y' : 'd/m/y'}` : ''}${p.zones.length ? ` · <strong>positions:</strong> ${esc(p.zones.map((z) => FIELD_LABEL[z] || z).join(', '))}` : ''}</td>
        <td class="muted">${p.defaults ? esc(`${p.defaults.account_code}${p.defaults.cost_center ? ' / ' + p.defaults.cost_center : ''}${p.defaults.vat_code ? ' / ' + p.defaults.vat_code : ''}`) : ''}</td>
        <td class="admin-only"><button type="button" class="btn btn-small" data-forget="${p.supplier_id}">Forget</button></td>
      </tr>`
      )
      .join('') || '<tr><td colspan="7" class="hint">Nothing learned yet: upload a supplier invoice PDF under Purchase invoices.</td></tr>';
  tbody.querySelectorAll('[data-forget]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = 'Really forget?';
        return;
      }
      await post(`/api/recognition/profiles/${btn.dataset.forget}`, {}, 'DELETE');
      loadRecognitionProfiles();
    })
  );
}

// ---------- Suppliers page ----------

async function loadSuppliersPage() {
  const [invoices, profiles] = await Promise.all([api('/api/invoices?type=purchase'), api('/api/recognition/profiles'), loadParties()]);
  const learned = Object.fromEntries(profiles.map((p) => [p.supplier_id, p]));
  const stats = {};
  for (const i of invoices) {
    const s = (stats[i.party_id] ||= { count: 0, open: 0, outstanding: 0 });
    s.count += 1;
    if (i.status !== 'Paid') {
      s.open += 1;
      s.outstanding += i.remaining_base;
    }
  }
  const totalOutstanding = Object.values(stats).reduce((t, s) => t + s.outstanding, 0);
  const openCount = Object.values(stats).reduce((t, s) => t + s.open, 0);
  document.getElementById('supplier-cards').innerHTML = `
    <div class="card"><div class="label">Suppliers</div><div class="value">${SUPPLIERS.length}</div><div class="sub">${Object.keys(stats).length} with invoices</div></div>
    <div class="card"><div class="label">Open invoices</div><div class="value">${openCount}</div><div class="sub">not (fully) paid</div></div>
    <div class="card"><div class="label">Outstanding</div><div class="value">${fmt(totalOutstanding, BASE)}</div><div class="sub">at booked rates</div></div>
    <div class="card"><div class="label">Recognition learned</div><div class="value">${profiles.length}</div><div class="sub">supplier(s) with a learned profile</div></div>`;
  document.querySelector('#suppliers-table tbody').innerHTML = SUPPLIERS.map((p) => {
    const s = stats[p.id] || { count: 0, open: 0, outstanding: 0 };
    const l = learned[p.id];
    return `<tr>
      <td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.country || '')}</div></td>
      <td>${p.currency}</td>
      <td class="muted">${esc(p.vat_number || '')}</td>
      <td class="muted">${esc(bankDetailsText(p) || 'none')}</td>
      <td class="num">${s.count}</td>
      <td class="num">${s.open ? `<span class="badge open">${s.open}</span>` : '0'}</td>
      <td class="num">${fmt(s.outstanding, BASE)}</td>
      <td class="muted">${l ? `${l.documents} invoice(s)${l.accuracy !== null ? `, ${Math.round(l.accuracy * 100)}% right` : ''}` : '-'}</td>
      <td class="nowrap"><button class="btn btn-small" data-edit-party="supplier" data-id="${p.id}">Edit</button> <button type="button" class="btn btn-small btn-delete" data-delete="supplier" data-id="${p.id}">Delete</button></td>
    </tr>`;
  }).join('');
  document.querySelectorAll('#suppliers-table [data-edit-party]').forEach((btn) =>
    btn.addEventListener('click', () => openPartyDialog('supplier', SUPPLIERS.find((x) => x.id === Number(btn.dataset.id))))
  );
}

// ---------- Setup: VAT codes ----------

function renderVatCodes() {
  const bsAccounts = (selected) => accountOptions((a) => a.statement === 'BS' && !a.bank_currency, selected);
  const admin = isAdmin();
  document.querySelector('#vat-codes-table tbody').innerHTML = VAT_CODES.map(
    (v) => `<tr data-vat="${esc(v.code)}">
      <td><strong>${esc(v.code)}</strong></td>
      <td>${esc(v.description)}</td>
      <td class="num">${v.rate}%</td>
      <td>${admin ? `<select class="v-purchase">${bsAccounts(v.purchase_account)}</select>` : acctLink(v.purchase_account, v.purchase_account_name)}</td>
      <td>${admin ? `<select class="v-sales">${bsAccounts(v.sales_account)}</select>` : acctLink(v.sales_account, v.sales_account_name)}</td>
      <td class="num">${v.used_on_lines}</td>
      <td>${v.active ? '<span class="badge paid">Active</span>' : '<span class="badge open">Not in use</span>'}</td>
      <td class="admin-only"><button type="button" class="btn btn-small v-toggle">${v.active ? 'Stop using' : 'Use again'}</button></td>
    </tr>`
  ).join('');
  const errEl = document.getElementById('vat-code-error');
  const save = async (code, body) => {
    errEl.textContent = '';
    try {
      await post(`/api/vat-codes/${encodeURIComponent(code)}`, body, 'PUT');
    } catch (err) {
      errEl.textContent = err.message;
    }
    await loadVatCodes();
    renderVatCodes();
  };
  document.querySelectorAll('#vat-codes-table tr[data-vat]').forEach((tr) => {
    const code = tr.dataset.vat;
    const v = VAT_CODES.find((x) => x.code === code);
    if (!admin) return;
    tr.querySelector('.v-purchase').addEventListener('change', (e) => save(code, { purchase_account: e.target.value }));
    tr.querySelector('.v-sales').addEventListener('change', (e) => save(code, { sales_account: e.target.value }));
    tr.querySelector('.v-toggle').addEventListener('click', () => save(code, { active: !v.active }));
  });
  const form = document.getElementById('form-vat-code');
  form.purchase_account.innerHTML = bsAccounts('1200');
  form.sales_account.innerHTML = bsAccounts('2200');
}

document.getElementById('form-vat-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = document.getElementById('vat-code-error');
  errEl.textContent = '';
  try {
    await post('/api/vat-codes', {
      code: f.code.value,
      description: f.description.value,
      rate: parseFloat(f.rate.value),
      purchase_account: f.purchase_account.value,
      sales_account: f.sales_account.value,
    });
    f.reset();
    await loadVatCodes();
    renderVatCodes();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ---------- Login, users & permissions ----------

let CURRENT_USER = null;
const isAdmin = () => CURRENT_USER && CURRENT_USER.role === 'admin';

function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.body.classList.add('logged-out');
}

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  const button = f.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await post('/api/login', { username: f.username.value.trim(), password: f.password.value });
  } catch (err) {
    errEl.textContent = err.message;
    f.password.value = '';
    f.password.focus();
    button.disabled = false;
    return;
  }
  // Check the browser kept the login cookie before continuing.
  const me = await fetch('/api/me', { cache: 'no-store' }).catch(() => null);
  if (!me || !me.ok) {
    errEl.textContent =
      me && me.status === 401
        ? 'Your password was accepted, but this browser did not keep the login. Please allow cookies for this site (or leave private/incognito mode) and try again.'
        : 'Your password was accepted, but the server could not finish logging you in. Please try again in a moment.';
    button.disabled = false;
    return;
  }
  document.getElementById('login-screen').hidden = true;
  document.body.classList.remove('logged-out');
  f.reset();
  button.disabled = false;
  startApp();
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await post('/api/logout', {}).catch(() => {});
  location.reload();
});

document.getElementById('btn-change-password').addEventListener('click', () => {
  document.getElementById('form-password').reset();
  document.getElementById('password-error').textContent = '';
  document.getElementById('dialog-password').showModal();
});

document.getElementById('form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = document.getElementById('password-error');
  if (f.new_password.value !== f.repeat.value) {
    errEl.textContent = 'The new passwords are not the same';
    return;
  }
  try {
    await post('/api/me/password', { current_password: f.current_password.value, new_password: f.new_password.value });
    document.getElementById('dialog-password').close();
    alert('Your password has been changed.');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

async function loadUsers() {
  const users = await api('/api/users');
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = users
    .map((u) => {
      const self = u.id === CURRENT_USER.id;
      return `<tr data-user="${u.id}" data-username="${esc(u.username)}">
        <td><strong>${esc(u.username)}</strong>${self ? ' <span class="muted">(you)</span>' : ''}</td>
        <td>${esc(u.name)}</td>
        <td><select class="u-role" ${self ? 'disabled title="You cannot change your own role"' : ''}>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer</option></select></td>
        <td class="muted">${esc(u.last_login_at ? u.last_login_at.slice(0, 16) + ' UTC' : 'never')}</td>
        <td><input class="u-password" type="password" minlength="10" placeholder="min. 10 characters" autocomplete="new-password" />
          <button type="button" class="btn btn-small u-reset">Set</button></td>
        <td>${self ? '' : '<button type="button" class="btn btn-small u-delete">Remove</button>'}</td>
      </tr>`;
    })
    .join('');
  const result = (msg) => {
    document.getElementById('users-error').textContent = '';
    document.getElementById('users-result').textContent = msg;
  };
  const failed = (err) => {
    document.getElementById('users-result').textContent = '';
    document.getElementById('users-error').textContent = err.message;
  };
  tbody.querySelectorAll('tr[data-user]').forEach((tr) => {
    const id = tr.dataset.user;
    const name = tr.dataset.username;
    tr.querySelector('.u-role').addEventListener('change', async (e) => {
      try {
        await post(`/api/users/${id}`, { role: e.target.value }, 'PUT');
        result(`${name} is now ${e.target.value === 'admin' ? 'an admin' : 'a viewer'}.`);
      } catch (err) {
        failed(err);
      }
      loadUsers();
    });
    tr.querySelector('.u-reset').addEventListener('click', async () => {
      try {
        await post(`/api/users/${id}/password`, { password: tr.querySelector('.u-password').value });
        result(`New password set for ${name}; they have been logged out everywhere.`);
        tr.querySelector('.u-password').value = '';
      } catch (err) {
        failed(err);
      }
    });
    const del = tr.querySelector('.u-delete');
    if (del) {
      // Two clicks: the first asks for confirmation.
      del.addEventListener('click', async () => {
        if (del.dataset.confirm !== '1') {
          del.dataset.confirm = '1';
          del.textContent = `Really remove ${name}?`;
          return;
        }
        try {
          await post(`/api/users/${id}`, {}, 'DELETE');
          result(`${name} has been removed.`);
        } catch (err) {
          failed(err);
        }
        loadUsers();
      });
    }
  });
}

document.getElementById('form-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const u = await post('/api/users', { username: f.username.value, name: f.name.value, role: f.role.value, password: f.password.value });
    f.reset();
    document.getElementById('users-error').textContent = '';
    document.getElementById('users-result').textContent = `User ${u.username} added.`;
    loadUsers();
  } catch (err) {
    document.getElementById('users-error').textContent = err.message;
  }
});

/** A notice at the top when the server has a problem, with a way to try again. */
function showProblem(message) {
  const el = document.getElementById('problem-banner');
  el.querySelector('span').textContent = message;
  el.hidden = false;
}
document.querySelector('#problem-banner button').addEventListener('click', () => location.reload());

/** Load the logged-in user and start the app (on page load, or right after logging in). */
async function startApp() {
  try {
    CURRENT_USER = await api('/api/me');
  } catch (err) {
    // 401: the login screen is showing. Anything else: the server has a problem.
    if (err.status !== 401) showProblem(err.message || 'The server could not be reached.');
    return;
  }
  try {
    await finishStart();
  } catch (err) {
    showProblem(err.message || 'The server could not be reached.');
  }
}

async function finishStart() {
  document.body.classList.add(`role-${CURRENT_USER.role}`);
  document.getElementById('user-menu').hidden = false;
  document.getElementById('user-name').textContent = CURRENT_USER.name;
  const roleBadge = document.getElementById('user-role');
  roleBadge.textContent = CURRENT_USER.role === 'admin' ? 'Admin' : 'View only';
  roleBadge.className = `badge ${CURRENT_USER.role === 'admin' ? 'partial' : 'open'}`;
  META = await api('/api/meta');
  document.getElementById('demo-banner').hidden = !META.demo_mode;
  const sel = document.getElementById('entity-select');
  let saved = null;
  try {
    saved = localStorage.getItem('nb-entity');
  } catch {
    /* remembering the entity is optional */
  }
  CURRENT_ENTITY = saved !== null && (saved === '' || META.entities.some((e) => String(e.id) === saved)) ? saved : String(META.entities[0].id);
  sel.innerHTML = META.entities.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('') + '<option value="">All entities</option>';
  sel.value = CURRENT_ENTITY;
  sel.addEventListener('change', () => {
    CURRENT_ENTITY = sel.value;
    try {
      localStorage.setItem('nb-entity', CURRENT_ENTITY);
    } catch {
      /* optional */
    }
    refreshActive();
  });
  await Promise.all([loadAccounts(), loadCostCenters(), loadPeriods()]);
  showTab(location.hash.slice(1) || 'suppliers');
}

startApp();
