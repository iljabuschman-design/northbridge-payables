'use strict';

/**
 * Reimbursements: expense claims for receipts that someone paid personally.
 *
 * A receipt is photographed (or uploaded as PDF) in the browser, which reads
 * its text (OCR with Tesseract for photos, pdf.js for PDFs); this module then
 * suggests the merchant, date, currency, total and VAT, plus how to book it,
 * learned per merchant from earlier claims.
 *
 *   submitted -> Approve & book:  Dr expense account (net, cost centre)
 *                                 Dr input VAT (VAT code's account)
 *                                 Cr Employee expenses payable (total)
 *             -> Reject
 *   approved  -> Mark as paid:    Dr Employee expenses payable / Cr bank (GBP)
 * Foreign-currency receipts are translated at the rate on the claim; the
 * reimbursement is paid in GBP at that same amount.
 */

const { db, round2, transaction, nowText } = require('./db');
const acct = require('./accounting');
const rec = require('./recognition');

const { httpError, ROLES } = acct;

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const merchantKey = (name) => compact(name).slice(0, 40);

/** One-off set-up on start: the liability account claims are booked against. */
async function setUpReimbursements() {
  if (!(await acct.getCompany())) return;
  if (await db.get('SELECT 1 FROM accounts WHERE role = ?', ROLES.REIMBURSEMENTS)) return;
  const code = (await acct.getAccount('2400')) ? '2410' : '2400';
  await acct.createAccount({ code, name: 'Employee expenses payable', category: 'other_current_liabilities', role: ROLES.REIMBURSEMENTS });
}

// ---------- reading a receipt ----------

const TOTAL_LABELS = ['total due', 'amount due', 'balance due', 'grand total', 'total to pay', 'to pay', 'total', 'amount paid', 'card payment', 'contactless', 'visa', 'mastercard', 'debit card', 'card', 'summe', 'gesamt', 'totaal', 'montant'];
const VAT_LABELS = ['vat total', 'total vat', 'vat amount', 'vat', 'tax', 'mwst', 'tva', 'btw'];
const NOT_MERCHANT = /(receipt|invoice|tel|phone|www\.|http|@|vat\s*(no|reg)|date|time|till|cashier|order|table|thank)/i;

/** Find the merchant: a learned merchant mentioned on the receipt, else its first proper line of text. */
async function guessMerchant(lines) {
  const text = compact(lines.join(' '));
  const known = await db.all('SELECT * FROM merchant_profiles ORDER BY uses DESC');
  const hit = known.find((m) => m.merchant_key.length >= 4 && text.includes(m.merchant_key));
  if (hit) return { value: hit.name, source: 'learned', profile: hit };
  const line = lines
    .map((l) => l.replace(/\|/g, ' ').trim())
    .find((l) => /[a-z]{3}/i.test(l) && l.length <= 40 && !NOT_MERCHANT.test(l) && !rec.findAmounts(l).length && !rec.findDates(l).length);
  return line ? { value: line.replace(/\s+/g, ' '), source: 'guess' } : null;
}

function amountByLabels(lines, labels, skip = () => false) {
  for (const label of labels) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].toLowerCase();
      if (!l.includes(label) || skip(l)) continue;
      const amounts = rec.findAmounts(lines[i]);
      if (amounts.length) return { value: amounts[amounts.length - 1].value, label };
    }
  }
  return null;
}

/**
 * Store a scanned receipt and suggest the claim. lines: the receipt's text
 * (from OCR or pdf.js). file_base64 + content_type: the (downsized) image or PDF.
 */
async function scanReceipt({ filename, content_type, file_base64, lines, entity_id }, user) {
  const entity = await acct.requireEntity(entity_id);
  if (!TYPES[content_type]) throw httpError(400, 'Upload a photo (JPEG/PNG) or a PDF');
  const data = Buffer.from(String(file_base64 || ''), 'base64');
  if (!data.length) throw httpError(400, 'The file is empty');
  if (data.length > MAX_BYTES) throw httpError(400, 'The file is larger than 3 MB');
  const textLines = (Array.isArray(lines) ? lines : []).map((l) => String(l).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 300);
  const text = textLines.join('\n');

  const merchant = await guessMerchant(textLines);
  const profile = merchant && merchant.profile;
  const today = new Date().toISOString().slice(0, 10);
  const dates = rec.findDates(text, 'DMY').filter((d) => d.iso <= today && d.iso >= '2000-01-01');
  const total = amountByLabels(textLines, TOTAL_LABELS, (l) => /sub\s*-?total|vat|tax|change|cash back|tip/.test(l));
  let totalGuess = total;
  if (!totalGuess) {
    const all = textLines.flatMap((l) => rec.findAmounts(l));
    if (all.length) totalGuess = { value: Math.max(...all.map((a) => a.value)), guess: true };
  }
  const vat = amountByLabels(textLines, VAT_LABELS, (l) => /vat\s*(no|reg|number)/.test(l));
  const counts = { GBP: (text.match(/£|\bGBP\b/g) || []).length, EUR: (text.match(/€|\bEUR\b/g) || []).length, USD: (text.match(/\$|\bUSD\b/g) || []).length };
  const currency = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  // VAT code: from the VAT on the receipt, else the merchant's usual code, else standard rate when VAT is mentioned.
  const codes = (await acct.listVatCodes()).filter((v) => v.active);
  let vatCode = null;
  if (vat && totalGuess && totalGuess.value > vat.value && vat.value > 0) {
    const rate = (vat.value / (totalGuess.value - vat.value)) * 100;
    const nearest = codes.reduce((a, b) => (!a || Math.abs(b.rate - rate) < Math.abs(a.rate - rate) ? b : a), null);
    if (nearest && Math.abs(nearest.rate - rate) <= 1.5) vatCode = { value: nearest.code, source: 'calculated' };
  }
  if (!vatCode && profile && profile.vat_code) vatCode = { value: profile.vat_code, source: 'learned' };
  if (!vatCode && vat && vat.value === 0) vatCode = { value: (codes.find((c) => c.rate === 0) || {}).code, source: 'generic' };

  const suggestion = {
    merchant: merchant ? { value: merchant.value, source: merchant.source } : null,
    receipt_date: dates.length ? { value: dates[0].iso, source: 'generic' } : null,
    currency: currency[1] > 0 ? { value: currency[0], source: 'generic' } : { value: 'GBP', source: 'guess' },
    total: totalGuess ? { value: totalGuess.value, source: totalGuess.guess ? 'guess' : 'generic', label: totalGuess.label } : null,
    vat: vat ? { value: vat.value, source: 'generic', label: vat.label } : null,
    vat_code: vatCode,
    account_code: profile && profile.account_code ? { value: profile.account_code, source: 'learned' } : null,
    cost_center: profile && profile.cost_center ? { value: profile.cost_center, source: 'learned' } : null,
    description: profile && profile.description ? { value: profile.description, source: 'learned' } : null,
    no_text: !text.trim(),
    uses: profile ? profile.uses : 0,
  };
  const { row } = await db.run(
    "INSERT INTO documents (entity_id, filename, content_type, size, data, text_lines, suggestion_json, uploaded_by, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'receipt', 'receipt')",
    entity.id, String(filename || `receipt.${TYPES[content_type]}`).slice(0, 200), content_type, data.length, data, JSON.stringify(textLines), JSON.stringify(suggestion), user ? user.name : null
  );
  return { document_id: row.id, ...suggestion };
}

// ---------- claims ----------

const claimSelect = `SELECT r.*, e.code AS entity_code, a.name AS account_name, cc.name AS cost_center_name, d.filename AS document_name
  FROM reimbursements r JOIN entities e ON e.id = r.entity_id
  LEFT JOIN accounts a ON a.code = r.account_code
  LEFT JOIN cost_centers cc ON cc.code = r.cost_center
  LEFT JOIN documents d ON d.id = r.document_id`;

async function listClaims(entityId) {
  const E = acct.entityOf(entityId);
  return db.all(`${claimSelect} WHERE (?::int IS NULL OR r.entity_id = ?) ORDER BY r.receipt_date DESC, r.id DESC`, E, E);
}

async function getClaim(id) {
  return db.get(`${claimSelect} WHERE r.id = ?`, Number(id));
}

async function learnMerchant(c) {
  const key = merchantKey(c.merchant);
  if (key.length < 3) return;
  const existing = await db.get('SELECT * FROM merchant_profiles WHERE merchant_key = ?', key);
  if (existing) {
    await db.run(
      'UPDATE merchant_profiles SET name = ?, account_code = ?, cost_center = ?, vat_code = ?, description = ?, uses = uses + 1 WHERE merchant_key = ?',
      c.merchant, c.account_code, c.cost_center, c.vat_code, c.description, key
    );
  } else {
    await db.run(
      'INSERT INTO merchant_profiles (merchant_key, name, account_code, cost_center, vat_code, description, uses) VALUES (?, ?, ?, ?, ?, ?, 1)',
      key, c.merchant, c.account_code, c.cost_center, c.vat_code, c.description
    );
  }
}

/** Save a claim (status "submitted"). The merchant's booking is learned for next time. */
async function createClaim(body, user) {
  const entity = await acct.requireEntity(body.entity_id);
  const merchant = String(body.merchant || '').trim();
  if (!merchant) throw httpError(400, 'Who was paid? Fill in the merchant');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.receipt_date || '')) throw httpError(400, 'Fill in the date on the receipt');
  if (!acct.CURRENCIES.includes(body.currency)) throw httpError(400, 'Unsupported currency');
  const total = round2(Number(body.total_amount));
  if (!(total > 0)) throw httpError(400, 'The total must be more than zero');
  const account = await acct.getAccount(body.account_code);
  if (!account || account.statement !== 'PL') throw httpError(400, 'Choose the expense account (a P&L account)');
  let vatCode = null;
  if (body.vat_code) {
    vatCode = await acct.getVatCode(body.vat_code);
    if (!vatCode) throw httpError(400, `Unknown VAT code ${body.vat_code}`);
  }
  const vat = round2(Number(body.vat_amount) || 0);
  if (vat < 0 || vat >= total) throw httpError(400, 'The VAT must be less than the total');
  if (vat > 0 && !vatCode) throw httpError(400, 'Choose the VAT code for the VAT on the receipt');
  const rate = body.currency === 'GBP' ? 1 : Number(body.exchange_rate);
  if (!(rate > 0)) throw httpError(400, 'Exchange rate must be a positive number');
  const costCenter = body.cost_center || null;
  if (costCenter && !(await db.get('SELECT 1 FROM cost_centers WHERE code = ?', costCenter))) throw httpError(400, 'Unknown cost centre');
  const claim = {
    entity_id: entity.id,
    claimant: String(body.claimant || (user && user.name) || '').trim().slice(0, 80) || 'Unknown',
    receipt_date: body.receipt_date,
    merchant: merchant.slice(0, 100),
    description: String(body.description || '').trim().slice(0, 200) || null,
    currency: body.currency,
    total_amount: total,
    vat_amount: vat,
    vat_code: vatCode ? vatCode.code : null,
    account_code: account.code,
    cost_center: costCenter,
    exchange_rate: rate,
    base_total: round2(total * rate),
    base_vat: round2(vat * rate),
    document_id: body.document_id ? Number(body.document_id) : null,
    notes: String(body.notes || '').trim().slice(0, 300) || null,
  };
  return transaction(async () => {
    const { row } = await db.run(
      `INSERT INTO reimbursements (entity_id, claimant, receipt_date, merchant, description, currency, total_amount, vat_amount, vat_code, account_code, cost_center, exchange_rate, base_total, base_vat, status, document_id, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
      claim.entity_id, claim.claimant, claim.receipt_date, claim.merchant, claim.description, claim.currency, claim.total_amount, claim.vat_amount, claim.vat_code, claim.account_code, claim.cost_center, claim.exchange_rate, claim.base_total, claim.base_vat, claim.document_id, claim.notes, user ? user.name : null
    );
    if (claim.document_id) await db.run("UPDATE documents SET status = 'claimed' WHERE id = ?", claim.document_id);
    await learnMerchant(claim);
    return getClaim(row.id);
  });
}

async function approveClaim(id, user) {
  const c = await getClaim(id);
  if (!c) throw httpError(404, 'Claim not found');
  if (c.status !== 'submitted') throw httpError(400, `This claim is already ${c.status}`);
  const payable = await acct.accountByRole(ROLES.REIMBURSEMENTS);
  const lines = [
    { account_code: c.account_code, debit: round2(c.base_total - c.base_vat), cost_center: c.cost_center, currency: c.currency },
    { account_code: payable.code, credit: c.base_total, currency: c.currency, description: `Expense claim ${c.claimant} - ${c.merchant}` },
  ];
  if (c.base_vat > 0) {
    const code = await acct.getVatCode(c.vat_code);
    lines.push({ account_code: code.purchase_account, debit: c.base_vat, currency: c.currency, description: `Expense claim ${c.claimant} - ${c.merchant} - VAT (${code.code})` });
  }
  const note = c.currency === 'GBP' ? null : `${c.total_amount.toFixed(2)} ${c.currency} @ ${c.exchange_rate}`;
  for (const l of lines) l.fx_note = note;
  return transaction(async () => {
    const journalId = await acct.postJournal({
      entity_id: c.entity_id,
      journal_date: c.receipt_date,
      reference: `CLAIM-${c.id}`,
      description: `Expense claim ${c.claimant} - ${c.merchant}${c.description ? ` - ${c.description}` : ''}`,
      source_type: 'reimbursement',
      source_id: c.id,
      lines,
    });
    await db.run("UPDATE reimbursements SET status = 'approved', journal_id = ?, approved_by = ?, approved_at = ? WHERE id = ?", journalId, user ? user.name : null, nowText(), c.id);
    return getClaim(c.id);
  });
}

async function payClaim(id, { bank_account, payment_date }, user) {
  const c = await getClaim(id);
  if (!c) throw httpError(404, 'Claim not found');
  if (c.status !== 'approved') throw httpError(400, c.status === 'paid' ? 'This claim is already paid' : 'Approve the claim before paying it');
  const bank = await acct.getAccount(bank_account);
  if (!bank || bank.bank_currency !== 'GBP') throw httpError(400, 'Choose a GBP bank account to pay from');
  const date = payment_date || new Date().toISOString().slice(0, 10);
  const payable = await acct.accountByRole(ROLES.REIMBURSEMENTS);
  return transaction(async () => {
    const journalId = await acct.postJournal({
      entity_id: c.entity_id,
      journal_date: date,
      reference: `CLAIM-${c.id}`,
      description: `Reimbursement to ${c.claimant} - ${c.merchant}`,
      source_type: 'reimbursement_payment',
      source_id: c.id,
      lines: [
        { account_code: payable.code, debit: c.base_total },
        { account_code: bank.code, credit: c.base_total, currency: 'GBP' },
      ],
    });
    await db.run("UPDATE reimbursements SET status = 'paid', payment_journal_id = ?, bank_account = ?, paid_at = ? WHERE id = ?", journalId, bank.code, date, c.id);
    return getClaim(c.id);
  });
}

async function rejectClaim(id) {
  const c = await getClaim(id);
  if (!c) throw httpError(404, 'Claim not found');
  if (c.status !== 'submitted') throw httpError(400, `A claim that is ${c.status} can't be rejected`);
  await db.run("UPDATE reimbursements SET status = 'rejected' WHERE id = ?", c.id);
  return getClaim(c.id);
}

async function deleteClaim(id) {
  const c = await getClaim(id);
  if (!c) throw httpError(404, 'Claim not found');
  if (c.status === 'approved' || c.status === 'paid') throw httpError(400, 'This claim is booked: delete its journal first (Journals), which sets it back to submitted');
  await db.run('DELETE FROM reimbursements WHERE id = ?', c.id);
  return { deleted: `Claim of ${c.claimant} (${c.merchant})` };
}

module.exports = { setUpReimbursements, scanReceipt, listClaims, getClaim, createClaim, approveClaim, payClaim, rejectClaim, deleteClaim };
