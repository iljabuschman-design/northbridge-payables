'use strict';

const CCY_SYMBOL = { GBP: '£', EUR: '€', USD: '$' };
let SUPPLIERS = [];

function fmt(n, ccy) {
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(Number(n) || 0).toFixed(2);
  const withCommas = v.replace(/\d(?=(\d{3})+\.)/g, '$&,');
  return `${sign}${ccy ? (CCY_SYMBOL[ccy] || ccy + ' ') : ''}${withCommas}`;
}

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- Tabs ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  document.getElementById(`view-${btn.dataset.tab}`).hidden = false;
  if (btn.dataset.tab === 'dashboard') loadDashboard();
  if (btn.dataset.tab === 'invoices') loadInvoices();
  if (btn.dataset.tab === 'ledger') loadLedger();
  if (btn.dataset.tab === 'suppliers') loadSuppliers();
});

// ---------- Dashboard ----------
async function loadDashboard() {
  const d = await api('/api/dashboard');
  const cards = document.getElementById('summary-cards');
  cards.innerHTML = `
    <div class="card">
      <div class="label">Open invoices</div>
      <div class="value">${d.open_invoices}</div>
      <div class="sub">of ${d.total_invoices} total</div>
    </div>
    <div class="card">
      <div class="label">Total outstanding</div>
      <div class="value">${fmt(d.total_outstanding_base, 'GBP')}</div>
      <div class="sub">GBP equivalent, all currencies</div>
    </div>
    <div class="card">
      <div class="label">Realised FX to date</div>
      <div class="value ${d.realised_fx_total >= 0 ? 'pos' : 'neg'}">${d.realised_fx_total >= 0 ? '+' : ''}${fmt(d.realised_fx_total, 'GBP')}</div>
      <div class="sub">${d.realised_fx_total >= 0 ? 'net gain' : 'net loss'} on settled payments</div>
    </div>
    <div class="card">
      <div class="label">Books balanced?</div>
      <div class="value ${d.trial_balance_balanced ? 'pos' : 'neg'}">${d.trial_balance_balanced ? 'Yes' : 'No'}</div>
      <div class="sub">debits vs credits, all entries</div>
    </div>
  `;

  const tbody = document.querySelector('#currency-table tbody');
  tbody.innerHTML = '';
  for (const ccy of ['GBP', 'EUR', 'USD']) {
    const row = d.by_currency[ccy];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${ccy}</strong></td><td>${row.open_invoices}</td><td class="num">${fmt(row.outstanding_foreign, ccy)}</td><td class="num">${fmt(row.outstanding_base, 'GBP')}</td>`;
    tbody.appendChild(tr);
  }

  const tbStatus = document.getElementById('tb-status');
  tbStatus.textContent = d.trial_balance_balanced
    ? 'Trial balance is in balance — every invoice and payment posted a fully double-entry journal.'
    : 'Trial balance is OUT of balance — check the ledger.';
  tbStatus.className = 'tb-status ' + (d.trial_balance_balanced ? 'ok' : 'bad');

  const tbBody = document.querySelector('#tb-mini-table tbody');
  tbBody.innerHTML = d.trial_balance
    .map((r) => `<tr><td>${r.account}</td><td class="num">${fmt(r.debit, 'GBP')}</td><td class="num">${fmt(r.credit, 'GBP')}</td></tr>`)
    .join('');
}

// ---------- Invoices ----------
function statusBadge(status) {
  const cls = status === 'Paid' ? 'paid' : status === 'Partially Paid' ? 'partial' : 'open';
  return `<span class="badge ${cls}">${status}</span>`;
}

async function loadInvoices() {
  const invoices = await api('/api/invoices');
  const tbody = document.querySelector('#invoices-table tbody');
  tbody.innerHTML = invoices
    .map(
      (i) => `
    <tr class="clickable" data-id="${i.id}">
      <td>${i.supplier_name}</td>
      <td>${i.invoice_number}</td>
      <td>${i.invoice_date}</td>
      <td>${i.currency}</td>
      <td class="num">${fmt(i.net_amount)}</td>
      <td class="num">${fmt(i.vat_amount)}</td>
      <td class="num">${fmt(i.total_amount)}</td>
      <td class="num">${i.exchange_rate}</td>
      <td class="num">${fmt(i.base_total, 'GBP')}</td>
      <td class="num">${fmt(i.paid_amount)}</td>
      <td class="num">${fmt(i.remaining_amount)}</td>
      <td class="num">${fmt(i.remaining_base, 'GBP')}</td>
      <td>${statusBadge(i.status)}</td>
    </tr>`
    )
    .join('');
  tbody.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => openInvoiceDetail(Number(tr.dataset.id))));
}

// ---------- Ledger ----------
async function loadLedger() {
  const [entries, tb] = await Promise.all([api('/api/ledger'), api('/api/trial-balance')]);
  const tbody = document.querySelector('#ledger-table tbody');
  tbody.innerHTML = entries
    .map(
      (e) => `
    <tr>
      <td>${e.entry_date}</td>
      <td>${e.account}</td>
      <td>${e.description}</td>
      <td>${e.fx_note || ''}</td>
      <td class="num">${e.debit ? fmt(e.debit) : ''}</td>
      <td class="num">${e.credit ? fmt(e.credit) : ''}</td>
    </tr>`
    )
    .join('');
  const tbBody = document.querySelector('#tb-full-table tbody');
  tbBody.innerHTML = tb
    .map((r) => `<tr><td>${r.account}</td><td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td><td class="num">${fmt(r.balance)}</td></tr>`)
    .join('');
}

// ---------- Suppliers ----------
async function loadSuppliers() {
  SUPPLIERS = await api('/api/suppliers');
  const tbody = document.querySelector('#suppliers-table tbody');
  tbody.innerHTML = SUPPLIERS
    .map((s) => `<tr><td>${s.name}</td><td>${s.country || ''}</td><td>${s.currency}</td><td>${s.vat_number || ''}</td></tr>`)
    .join('');
}

async function ensureSuppliersLoaded() {
  if (SUPPLIERS.length === 0) SUPPLIERS = await api('/api/suppliers');
}

// ---------- Invoice detail + payment ----------
let currentInvoiceId = null;

async function openInvoiceDetail(id) {
  const data = await api(`/api/invoices/${id}`);
  currentInvoiceId = id;
  const inv = data.invoice;
  const body = document.getElementById('invoice-detail-body');
  body.innerHTML = `
    <h2>${inv.invoice_number} — ${inv.supplier_name}</h2>
    <div class="detail-grid">
      <div><span class="k">Date:</span> ${inv.invoice_date}</div>
      <div><span class="k">Currency:</span> ${inv.currency} @ ${inv.exchange_rate}</div>
      <div><span class="k">Net / VAT / Total:</span> ${fmt(inv.net_amount)} / ${fmt(inv.vat_amount)} / ${fmt(inv.total_amount)}</div>
      <div><span class="k">Total (GBP):</span> ${fmt(inv.base_total, 'GBP')}</div>
      <div><span class="k">Paid:</span> ${fmt(inv.paid_amount)} (${fmt(inv.paid_base, 'GBP')})</div>
      <div><span class="k">Remaining:</span> ${fmt(inv.remaining_amount)} (${fmt(inv.remaining_base, 'GBP')})</div>
      <div><span class="k">Realised FX:</span> ${fmt(inv.realised_fx, 'GBP')}</div>
      <div><span class="k">Status:</span> ${statusBadge(inv.status)}</div>
    </div>
    ${inv.notes ? `<p class="hint">${inv.notes}</p>` : ''}

    <div class="section-title">Payments</div>
    <table class="table">
      <thead><tr><th>Date</th><th class="num">Amount</th><th class="num">Rate</th><th class="num">Cash (GBP)</th><th class="num">FX gain/loss</th></tr></thead>
      <tbody>
        ${data.payments
          .map(
            (p) => `<tr><td>${p.payment_date}</td><td class="num">${fmt(p.amount, inv.currency)}</td><td class="num">${p.exchange_rate}</td><td class="num">${fmt(p.base_cash, 'GBP')}</td><td class="num">${fmt(p.fx_gain_loss, 'GBP')}</td></tr>`
          )
          .join('') || '<tr><td colspan="5" class="hint">No payments recorded yet.</td></tr>'}
      </tbody>
    </table>

    <div class="section-title">Journal entries</div>
    <table class="table">
      <thead><tr><th>Date</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>
        ${data.ledger.map((e) => `<tr><td>${e.entry_date}</td><td>${e.account}</td><td class="num">${e.debit ? fmt(e.debit) : ''}</td><td class="num">${e.credit ? fmt(e.credit) : ''}</td></tr>`).join('')}
      </tbody>
    </table>

    ${inv.remaining_amount > 0.005 ? `<div class="dialog-actions" style="padding:16px 0 0;"><button class="btn btn-primary" id="btn-record-payment">Record payment</button></div>` : ''}
  `;
  const dlg = document.getElementById('dialog-invoice-detail');
  dlg.showModal();
  const payBtn = document.getElementById('btn-record-payment');
  if (payBtn) {
    payBtn.addEventListener('click', () => {
      dlg.close();
      openPaymentDialog(inv);
    });
  }
}

function openPaymentDialog(inv) {
  const dlg = document.getElementById('dialog-payment');
  const form = document.getElementById('form-payment');
  form.reset();
  document.getElementById('payment-error').textContent = '';
  document.getElementById('payment-context').textContent =
    `Invoice ${inv.invoice_number} (${inv.supplier_name}) — remaining ${fmt(inv.remaining_amount, inv.currency)} of ${fmt(inv.total_amount, inv.currency)}.`;
  form.exchange_rate.value = inv.exchange_rate;
  form.amount.max = inv.remaining_amount;
  form.amount.value = inv.remaining_amount;
  document.getElementById('payment-fx-hint').textContent =
    inv.currency === 'GBP' ? 'Base-currency invoice: rate is fixed at 1.' : 'Enter the rate actually achieved on the payment date to see the resulting FX gain/loss.';
  dlg.dataset.invoiceId = inv.id;
  dlg.showModal();
}

// ---------- Dialog wiring ----------
document.querySelectorAll('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

document.getElementById('btn-new-invoice').addEventListener('click', async () => {
  await ensureSuppliersLoaded();
  const sel = document.getElementById('invoice-supplier-select');
  sel.innerHTML = SUPPLIERS.map((s) => `<option value="${s.id}" data-currency="${s.currency}">${s.name} (${s.currency})</option>`).join('');
  document.getElementById('form-invoice').reset();
  document.getElementById('invoice-error').textContent = '';
  syncInvoiceCurrencyFromSupplier();
  document.getElementById('dialog-invoice').showModal();
});

function syncInvoiceCurrencyFromSupplier() {
  const sel = document.getElementById('invoice-supplier-select');
  const opt = sel.selectedOptions[0];
  if (opt) {
    const ccySel = document.getElementById('invoice-currency-select');
    ccySel.value = opt.dataset.currency;
    updateInvoiceRateDefault();
  }
}
document.getElementById('invoice-supplier-select').addEventListener('change', syncInvoiceCurrencyFromSupplier);

function updateInvoiceRateDefault() {
  const ccy = document.getElementById('invoice-currency-select').value;
  const rateInput = document.getElementById('invoice-rate-input');
  if (ccy === 'GBP') rateInput.value = 1;
  updateInvoiceTotalHint();
}
document.getElementById('invoice-currency-select').addEventListener('change', updateInvoiceRateDefault);

function updateInvoiceTotalHint() {
  const form = document.getElementById('form-invoice');
  const net = parseFloat(form.net_amount.value) || 0;
  const vat = parseFloat(form.vat_amount.value) || 0;
  const rate = parseFloat(form.exchange_rate.value) || 0;
  const ccy = form.currency.value;
  document.getElementById('invoice-total-hint').textContent =
    `Total: ${fmt(net + vat, ccy)}  →  GBP equivalent: ${fmt((net + vat) * rate, 'GBP')}`;
}
document.getElementById('form-invoice').addEventListener('input', updateInvoiceTotalHint);

document.getElementById('btn-new-supplier').addEventListener('click', () => {
  document.getElementById('form-supplier').reset();
  document.getElementById('supplier-error').textContent = '';
  document.getElementById('dialog-supplier').showModal();
});

document.getElementById('form-invoice').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    supplier_id: Number(form.supplier_id.value),
    invoice_number: form.invoice_number.value.trim(),
    invoice_date: form.invoice_date.value,
    currency: form.currency.value,
    net_amount: parseFloat(form.net_amount.value),
    vat_amount: parseFloat(form.vat_amount.value),
    exchange_rate: parseFloat(form.exchange_rate.value),
    notes: form.notes.value.trim(),
  };
  try {
    await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('dialog-invoice').close();
    loadInvoices();
    loadDashboard();
  } catch (err) {
    document.getElementById('invoice-error').textContent = err.message;
  }
});

document.getElementById('form-supplier').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    name: form.name.value.trim(),
    country: form.country.value.trim(),
    currency: form.currency.value,
    vat_number: form.vat_number.value.trim(),
  };
  try {
    await api('/api/suppliers', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('dialog-supplier').close();
    loadSuppliers();
  } catch (err) {
    document.getElementById('supplier-error').textContent = err.message;
  }
});

document.getElementById('form-payment').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const dlg = document.getElementById('dialog-payment');
  const invoiceId = Number(dlg.dataset.invoiceId);
  const payload = {
    payment_date: form.payment_date.value,
    amount: parseFloat(form.amount.value),
    exchange_rate: parseFloat(form.exchange_rate.value),
    notes: form.notes.value.trim(),
  };
  try {
    await api(`/api/invoices/${invoiceId}/payments`, { method: 'POST', body: JSON.stringify(payload) });
    dlg.close();
    loadInvoices();
    loadDashboard();
  } catch (err) {
    document.getElementById('payment-error').textContent = err.message;
  }
});

// ---------- Init ----------
loadDashboard();

