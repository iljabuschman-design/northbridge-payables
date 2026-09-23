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
const SOURCE_LABEL = { manual: 'Manual', invoice: 'Invoice', payment: 'Payment', bank: 'Bank', opening: 'Opening' };

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

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const post = (pathname, body, method = 'POST') => api(pathname, { method, body: JSON.stringify(body) });

function accountLabel(a) {
  return `${a.code} ${a.name}`;
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
  dashboard: loadDashboard,
  sales: () => loadInvoices('sale'),
  purchases: () => loadInvoices('purchase'),
  bank: loadBank,
  journals: loadJournals,
  ledger: loadLedger,
  financials: loadFinancials,
  setup: loadSetup,
};

function showTab(name) {
  if (!document.getElementById(`view-${name}`)) name = 'dashboard';
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (LOADERS[name]) LOADERS[name]().catch((err) => console.error(err));
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) showTab(btn.dataset.tab);
});

function refreshActive() {
  const active = document.querySelector('.tab.active');
  if (active) showTab(active.dataset.tab);
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
    .map((r) => `<tr><td>${esc(r.account_code)} ${esc(r.account_name)}</td><td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td></tr>`)
    .join('');
}

// ---------- Invoices ----------

async function loadInvoices(type) {
  const invoices = await api(`/api/invoices?type=${type}`);
  const table = document.getElementById(type === 'sale' ? 'sales-table' : 'purchases-table');
  table.innerHTML = `
    <thead><tr>
      <th>${type === 'sale' ? 'Customer' : 'Supplier'}</th><th>Invoice #</th><th>Date</th><th>Ccy</th>
      <th class="num">Net</th><th class="num">VAT</th><th class="num">Total</th>
      <th class="num">Rate</th><th class="num">Total (GBP)</th>
      <th class="num">${type === 'sale' ? 'Received' : 'Paid'}</th><th class="num">Remaining</th><th class="num">Remaining (GBP)</th>
      <th>Status</th>
    </tr></thead>
    <tbody>${
      invoices
        .map(
          (i) => `
      <tr class="clickable" data-id="${i.id}">
        <td>${esc(i.party_name)}</td><td>${esc(i.invoice_number)}</td><td>${esc(i.invoice_date)}</td><td>${i.currency}</td>
        <td class="num">${fmt(i.net_amount)}</td><td class="num">${fmt(i.vat_amount)}</td><td class="num">${fmt(i.total_amount)}</td>
        <td class="num">${i.exchange_rate}</td><td class="num">${fmt(i.base_total, BASE)}</td>
        <td class="num">${fmt(i.paid_amount)}</td><td class="num">${fmt(i.remaining_amount)}</td><td class="num">${fmt(i.remaining_base, BASE)}</td>
        <td>${statusBadge(i.status)}</td>
      </tr>`
        )
        .join('') || `<tr><td colspan="13" class="hint">No ${type === 'sale' ? 'sales' : 'purchase'} invoices yet.</td></tr>`
    }</tbody>`;
  table.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openInvoiceDetail(Number(tr.dataset.id))));
}

async function openInvoiceDetail(id) {
  const { invoice: inv, lines, payments, ledger } = await api(`/api/invoices/${id}`);
  const isSale = inv.type === 'sale';
  const body = document.getElementById('detail-body');
  body.innerHTML = `
    <h2>${isSale ? 'Sales' : 'Purchase'} invoice ${esc(inv.invoice_number)} - ${esc(inv.party_name)}</h2>
    <div class="detail-grid">
      <div><span class="k">Date:</span> ${esc(inv.invoice_date)}</div>
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
      <thead><tr><th>Description</th><th>Account</th><th class="num">Net</th><th class="num">VAT %</th><th class="num">VAT</th><th class="num">Net (GBP)</th></tr></thead>
      <tbody>${lines
        .map((l) => `<tr><td>${esc(l.description || '')}</td><td>${esc(l.account_code)} ${esc(l.account_name)}</td><td class="num">${fmt(l.net_amount)}</td><td class="num">${l.vat_rate}</td><td class="num">${fmt(l.vat_amount)}</td><td class="num">${fmt(l.base_net)}</td></tr>`)
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

    <div class="section-title">Journal entries</div>
    ${ledgerTable(ledger)}

    ${inv.remaining_amount > 0.005 ? `<div class="dialog-actions inline"><button class="btn btn-primary" id="btn-record-payment">${isSale ? 'Record receipt' : 'Record payment'}</button></div>` : ''}
  `;
  const dlg = document.getElementById('dialog-detail');
  dlg.showModal();
  const payBtn = document.getElementById('btn-record-payment');
  if (payBtn) {
    payBtn.addEventListener('click', () => {
      dlg.close();
      openPaymentDialog(inv);
    });
  }
}

function ledgerTable(entries) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Date</th><th>Account</th><th>FX note</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>${entries
      .map((e) => `<tr><td>${esc(e.entry_date)}</td><td>${esc(e.account_code)} ${esc(e.account_name)}</td><td class="muted">${esc(e.fx_note || '')}</td><td class="num">${e.debit ? fmt(e.debit) : ''}</td><td class="num">${e.credit ? fmt(e.credit) : ''}</td></tr>`)
      .join('')}</tbody>
  </table></div>`;
}

// ----- New invoice dialog -----

const invoiceForm = document.getElementById('form-invoice');
let invoiceType = 'purchase';

const invoiceLineAccounts = (type) =>
  type === 'sale'
    ? (a) => a.category === 'revenue'
    : (a) => ['cost_of_sales', 'overheads', 'fixed_assets', 'other_current_assets'].includes(a.category) && !a.role;

document.querySelectorAll('[data-new-invoice]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    invoiceType = btn.dataset.newInvoice;
    await Promise.all([loadAccounts(), loadParties()]);
    const parties = invoiceType === 'sale' ? CUSTOMERS : SUPPLIERS;
    invoiceForm.reset();
    document.getElementById('invoice-dialog-title').textContent = invoiceType === 'sale' ? 'New sales invoice' : 'New purchase invoice';
    document.getElementById('invoice-party-label').textContent = invoiceType === 'sale' ? 'Customer' : 'Supplier';
    invoiceForm.party_id.innerHTML = parties.map((p) => `<option value="${p.id}" data-currency="${p.currency}">${esc(p.name)} (${p.currency})</option>`).join('');
    invoiceForm.currency.innerHTML = currencyOptions(BASE);
    invoiceForm.invoice_date.value = today();
    document.getElementById('invoice-error').textContent = '';
    document.querySelector('#invoice-lines tbody').innerHTML = '';
    addInvoiceLine();
    syncInvoiceCurrency();
    document.getElementById('dialog-invoice').showModal();
  })
);

function addInvoiceLine() {
  const tbody = document.querySelector('#invoice-lines tbody');
  const defaultAccount = invoiceType === 'sale' ? '4000' : '5000';
  const vat = invoiceForm.currency.value === BASE ? 20 : 0;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="l-desc" maxlength="120" placeholder="Description" /></td>
    <td><select class="l-account">${accountOptions(invoiceLineAccounts(invoiceType), defaultAccount)}</select></td>
    <td class="num"><input class="l-net num" type="number" step="0.01" min="0" required /></td>
    <td class="num"><input class="l-vat-rate num narrow" type="number" step="any" min="0" max="100" value="${vat}" /></td>
    <td class="num l-vat">0.00</td>
    <td><button type="button" class="btn btn-small btn-icon" title="Remove line">×</button></td>`;
  tr.querySelector('.btn-icon').addEventListener('click', () => {
    if (tbody.children.length > 1) tr.remove();
    updateInvoiceTotals();
  });
  tbody.appendChild(tr);
  updateInvoiceTotals();
}
document.getElementById('btn-add-invoice-line').addEventListener('click', addInvoiceLine);

function invoiceLinesFromForm() {
  return [...document.querySelectorAll('#invoice-lines tbody tr')].map((tr) => ({
    description: tr.querySelector('.l-desc').value.trim(),
    account_code: tr.querySelector('.l-account').value,
    net_amount: parseFloat(tr.querySelector('.l-net').value) || 0,
    vat_rate: parseFloat(tr.querySelector('.l-vat-rate').value) || 0,
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
    `Net ${fmt(net, ccy)} + VAT ${fmt(vat, ccy)} = <strong>${fmt(total, ccy)}</strong>` + (ccy !== BASE ? `  →  approx. ${fmt(total * rate, BASE)}` : '');
}
invoiceForm.addEventListener('input', updateInvoiceTotals);

function syncInvoiceCurrency() {
  const opt = invoiceForm.party_id.selectedOptions[0];
  if (opt) invoiceForm.currency.value = opt.dataset.currency;
  refreshInvoiceRate();
}

function refreshInvoiceRate() {
  const ccy = invoiceForm.currency.value;
  // Default VAT for new lines follows the currency (UK 20% vs overseas 0%).
  document.querySelectorAll('#invoice-lines .l-vat-rate').forEach((i) => {
    if (!i.dataset.touched) i.value = ccy === BASE ? 20 : 0;
  });
  autoRate(ccy, invoiceForm.invoice_date.value, invoiceForm.exchange_rate, document.getElementById('invoice-rate-hint')).then(updateInvoiceTotals);
}
invoiceForm.party_id.addEventListener('change', syncInvoiceCurrency);
invoiceForm.currency.addEventListener('change', refreshInvoiceRate);
invoiceForm.invoice_date.addEventListener('change', refreshInvoiceRate);
document.querySelector('#invoice-lines').addEventListener('input', (e) => {
  if (e.target.classList.contains('l-vat-rate')) e.target.dataset.touched = '1';
});

invoiceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    type: invoiceType,
    party_id: Number(invoiceForm.party_id.value),
    invoice_number: invoiceForm.invoice_number.value.trim(),
    invoice_date: invoiceForm.invoice_date.value,
    currency: invoiceForm.currency.value,
    exchange_rate: parseFloat(invoiceForm.exchange_rate.value),
    notes: invoiceForm.notes.value.trim(),
    lines: invoiceLinesFromForm().map(({ row, ...l }) => l),
  };
  try {
    await post('/api/invoices', payload);
    document.getElementById('dialog-invoice').close();
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
  const banks = bankAccounts();
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
      .map((b) => `<option value="${esc(b.code)}">${esc(accountLabel(b))} (${b.bank_currency}${b.iban ? ', ' + esc(b.iban) : ''})</option>`)
      .join('');
  sel.value = prev;

  const statements = await api('/api/bank/statements');
  const tbody = document.querySelector('#statements-table tbody');
  tbody.innerHTML =
    statements
      .map(
        (s) => `<tr class="clickable ${s.id === currentStatementId ? 'selected' : ''}" data-id="${s.id}">
          <td>${esc(s.uploaded_at.slice(0, 16))}</td><td>${esc(s.bank_account)} ${esc(s.bank_account_name)}</td>
          <td>${esc(s.statement_ref || '')}</td><td>${esc(s.from_date || '')} – ${esc(s.to_date || '')}</td><td class="muted">${esc(s.filename || '')}</td>
          <td class="num">${s.line_count}</td><td class="num">${s.open_lines ? `<span class="badge open">${s.open_lines}</span>` : '<span class="badge paid">0</span>'}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="7" class="hint">No statements uploaded yet.</td></tr>';
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
    const results = await post('/api/bank/statements', { filename: file.name, content, bank_account: form.bank_account.value || null });
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
  if (id !== currentStatementId) document.getElementById('statement-result').textContent = '';
  currentStatementId = id;
  document.querySelectorAll('#statements-table tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.id) === id));
  const [st, openInvoices] = await Promise.all([api(`/api/bank/statements/${id}`), api('/api/invoices')]);
  const open = openInvoices.filter((i) => i.status !== 'Paid');
  const bank = ACCOUNTS.find((a) => a.code === st.bank_account);
  document.getElementById('statement-panel').hidden = false;
  document.getElementById('statement-title').textContent = `Statement ${st.statement_ref || st.id} - ${st.bank_account} ${st.bank_account_name}`;
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
          <select class="p-account" ${suggested ? 'hidden' : ''}><option value="">Choose opposing account…</option>${accountOptions((a) => a.code !== st.bank_account)}</select>
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
    mode.addEventListener('change', () => {
      accSel.hidden = mode.value !== 'account';
      invSel.hidden = mode.value !== 'invoice';
      syncSettle();
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
        <td>${esc(j.journal_date)}</td><td>${esc(j.reference || '')}</td><td>${esc(j.description)}</td>
        <td><span class="badge src-${esc(j.source_type)}">${esc(SOURCE_LABEL[j.source_type] || j.source_type)}</span></td>
        <td class="num">${j.line_count}</td><td class="num">${fmt(j.total, BASE)}</td></tr>`
    )
    .join('');
  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openJournalDetail(Number(tr.dataset.id))));
}

async function openJournalDetail(id) {
  const j = await api(`/api/journals/${id}`);
  document.getElementById('detail-body').innerHTML = `
    <h2>Journal ${j.reference ? esc(j.reference) + ' - ' : ''}${esc(j.description)}</h2>
    <div class="detail-grid">
      <div><span class="k">Date:</span> ${esc(j.journal_date)}</div>
      <div><span class="k">Source:</span> ${esc(SOURCE_LABEL[j.source_type] || j.source_type)}</div>
    </div>
    ${ledgerTable(j.lines)}`;
  document.getElementById('dialog-detail').showModal();
}

const journalForm = document.getElementById('form-journal');

document.getElementById('btn-new-journal').addEventListener('click', async () => {
  await loadAccounts();
  journalForm.reset();
  journalForm.currency.innerHTML = currencyOptions(BASE);
  journalForm.journal_date.value = today();
  document.getElementById('journal-error').textContent = '';
  document.querySelector('#journal-lines tbody').innerHTML = '';
  addJournalLine();
  addJournalLine();
  refreshJournalRate();
  document.getElementById('dialog-journal').showModal();
});

function addJournalLine() {
  const tbody = document.querySelector('#journal-lines tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="j-account" required><option value="">Choose account…</option>${accountOptions()}</select></td>
    <td><input class="j-desc" maxlength="120" /></td>
    <td class="num"><input class="j-debit num" type="number" step="0.01" min="0" /></td>
    <td class="num"><input class="j-credit num" type="number" step="0.01" min="0" /></td>
    <td><button type="button" class="btn btn-small btn-icon" title="Remove line">×</button></td>`;
  tr.querySelector('.btn-icon').addEventListener('click', () => {
    if (tbody.children.length > 2) tr.remove();
    updateJournalTotals();
  });
  // Typing a debit clears the credit on the same line and vice versa.
  tr.querySelector('.j-debit').addEventListener('input', (e) => e.target.value && (tr.querySelector('.j-credit').value = ''));
  tr.querySelector('.j-credit').addEventListener('input', (e) => e.target.value && (tr.querySelector('.j-debit').value = ''));
  tbody.appendChild(tr);
  updateJournalTotals();
}
document.getElementById('btn-add-journal-line').addEventListener('click', addJournalLine);

function journalLinesFromForm() {
  return [...document.querySelectorAll('#journal-lines tbody tr')].map((tr) => ({
    account_code: tr.querySelector('.j-account').value,
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
    journal_date: journalForm.journal_date.value,
    reference: journalForm.reference.value.trim(),
    description: journalForm.description.value.trim(),
    currency: journalForm.currency.value,
    exchange_rate: parseFloat(journalForm.exchange_rate.value),
    lines: journalLinesFromForm(),
  };
  try {
    await post('/api/journals', payload);
    document.getElementById('dialog-journal').close();
    refreshActive();
  } catch (err) {
    document.getElementById('journal-error').textContent = err.message;
  }
});

// ---------- Ledger ----------

async function loadLedger() {
  const [entries, tb] = await Promise.all([api('/api/ledger'), api('/api/trial-balance')]);
  document.querySelector('#ledger-table tbody').innerHTML = entries
    .map(
      (e) => `<tr>
        <td>${esc(e.entry_date)}</td><td>${esc(e.account_code)} ${esc(e.account_name)}</td><td>${esc(e.description)}</td>
        <td class="muted">${esc(e.fx_note || '')}</td>
        <td class="num">${e.debit ? fmt(e.debit) : ''}</td><td class="num">${e.credit ? fmt(e.credit) : ''}</td></tr>`
    )
    .join('');
  const totDr = tb.reduce((s, r) => s + r.debit, 0);
  const totCr = tb.reduce((s, r) => s + r.credit, 0);
  document.querySelector('#tb-full-table tbody').innerHTML =
    tb
      .map((r) => `<tr><td>${esc(r.account_code)} ${esc(r.account_name)}</td><td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td><td class="num">${fmt(r.balance)}</td></tr>`)
      .join('') + `<tr class="total"><td>Total</td><td class="num">${fmt(totDr)}</td><td class="num">${fmt(totCr)}</td><td class="num">${fmt(totDr - totCr)}</td></tr>`;
}

// ---------- Financial statements ----------

const periodForm = document.getElementById('form-period');
periodForm.from.value = `${today().slice(0, 4)}-01-01`;
periodForm.to.value = today();
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
    .map((a) => `<tr class="acct"><td>${a.code ? esc(a.code) + ' ' : ''}${esc(a.name)}</td><td class="num">${fmt(a.amount)}</td></tr>`)
    .join('');
  return head + lines;
}

const subtotal = (label, value, cls = 'sub') => `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${fmt(value, BASE)}</td></tr>`;

async function loadFinancials() {
  const from = periodForm.from.value;
  const to = periodForm.to.value;
  let r;
  try {
    r = await api(`/api/reports?from=${from}&to=${to}`);
  } catch (err) {
    document.getElementById('pl-period').textContent = err.message;
    return;
  }
  const pl = r.profit_and_loss;
  document.getElementById('pl-period').textContent = `${r.from} to ${r.to}`;
  document.getElementById('pl-table').innerHTML =
    finGroupRows(pl.revenue) +
    finGroupRows(pl.cost_of_sales) +
    subtotal('Gross profit', pl.gross_profit) +
    finGroupRows(pl.overheads) +
    subtotal('Operating result', pl.operating_result) +
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
      rows.map((a) => `<tr class="acct"><td>${a.code ? esc(a.code) + ' ' : ''}${esc(a.name)}</td><td class="num">${fmt(a.o)}</td><td class="num">${fmt(a.c)}</td></tr>`).join('')
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
    cf.cash_accounts.map((a) => `<tr class="acct"><td>${esc(a.code)} ${esc(a.name)}</td><td class="num">${fmt(a.closing)}</td></tr>`).join('');
  const cfCheck = document.getElementById('cf-check');
  cfCheck.textContent = cf.reconciles ? '✓ Opening cash plus net change equals closing cash.' : '✗ Cash flow does not reconcile.';
  cfCheck.className = 'hint ' + (cf.reconciles ? 'pos' : 'neg');
}

// ---------- Setup: chart of accounts, customers, suppliers, FX ----------

async function loadSetup() {
  await Promise.all([loadAccounts(), loadParties()]);
  const catOptions = (selected, bankOnly) =>
    META.categories
      .filter((c) => !bankOnly || c.key === 'cash')
      .map((c) => `<option value="${c.key}" ${c.key === selected ? 'selected' : ''}>${esc(c.name)} (${c.statement === 'BS' ? 'balance sheet' : 'P&L'})</option>`)
      .join('');
  const tbody = document.querySelector('#accounts-table tbody');
  tbody.innerHTML = ACCOUNTS.map(
    (a) => `<tr data-code="${esc(a.code)}">
      <td><strong>${esc(a.code)}</strong></td>
      <td>${esc(a.name)}${a.bank_currency ? ` <span class="muted">(${a.bank_currency}${a.iban ? ', ' + esc(a.iban) : ''})</span>` : ''}</td>
      <td><select class="cat-select" ${a.bank_currency ? 'disabled title="Bank accounts stay in Cash & bank"' : ''}>${catOptions(a.category, !!a.bank_currency)}</select></td>
      <td>${a.statement === 'BS' ? 'Balance sheet' : 'P&amp;L'}</td>
      <td class="muted">${esc(ROLE_LABEL[a.role] || (a.bank_currency ? 'Bank' : ''))}</td>
      <td class="num">${fmt(a.balance)}</td>
      <td><button class="btn btn-small edit-account">Edit</button></td>
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

  const partyRows = (list) =>
    list.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.country || '')}</td><td>${p.currency}</td><td>${esc(p.vat_number || '')}</td></tr>`).join('');
  document.querySelector('#customers-table tbody').innerHTML = partyRows(CUSTOMERS);
  document.querySelector('#suppliers-table tbody').innerHTML = partyRows(SUPPLIERS);

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

document.querySelectorAll('[data-new-party]').forEach((btn) =>
  btn.addEventListener('click', () => {
    partyKind = btn.dataset.newParty;
    partyForm.reset();
    partyForm.currency.innerHTML = currencyOptions(BASE);
    document.getElementById('party-dialog-title').textContent = partyKind === 'customer' ? 'New customer' : 'New supplier';
    document.getElementById('party-error').textContent = '';
    document.getElementById('dialog-party').showModal();
  })
);

partyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: partyForm.name.value.trim(),
    country: partyForm.country.value.trim(),
    currency: partyForm.currency.value,
    vat_number: partyForm.vat_number.value.trim(),
  };
  try {
    await post(partyKind === 'customer' ? '/api/customers' : '/api/suppliers', payload);
    document.getElementById('dialog-party').close();
    loadSetup();
  } catch (err) {
    document.getElementById('party-error').textContent = err.message;
  }
});

// ---------- Dialog wiring & init ----------

document.querySelectorAll('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

(async function init() {
  META = await api('/api/meta');
  await loadAccounts();
  showTab(location.hash.slice(1) || 'dashboard');
})();
