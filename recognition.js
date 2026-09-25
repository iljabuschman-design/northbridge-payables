'use strict';

/**
 * Invoice recognition: reads the text of an uploaded supplier invoice (PDF)
 * and suggests the supplier, invoice number, dates, currency, amounts and how
 * to book it. The browser extracts the text (pdf.js) as lines in reading
 * order, with " | " between text that sits in separate columns; this module
 * only works on that text.
 *
 * Recognition is rule-based and learns per supplier. When an invoice made from
 * a document is saved, the final values are compared with the suggestion and
 * the supplier's profile remembers:
 *   - the label that precedes each field on that supplier's invoices
 *     (e.g. "Rechnungsnummer", "Invoice #"), tried before the generic labels,
 *   - its date order (day/month vs month/day) and currency,
 *   - text that identifies the supplier (e.g. its letterhead),
 *   - how its invoices are booked (GL account, cost centre, VAT code, description),
 *   - how many fields were right, so accuracy per supplier can be shown,
 *   - and where on the page a field is, when the user marked it by dragging a
 *     box on the PDF (a "zone"). Zones are tried before any label rule.
 *
 * Text positions come from the browser too: each text item with its page and
 * its box as fractions of the page (0-1, measured from the top left), so a
 * zone means the same place whatever size the PDF is drawn at.
 */

const { db, round2 } = require('./db');
const acct = require('./accounting');

const { httpError } = acct;

const MAX_PDF_BYTES = 3 * 1024 * 1024;
const FIELDS = ['supplier', 'invoice_number', 'invoice_date', 'due_date', 'currency', 'net', 'vat', 'total'];
// Fields whose position can be taught by marking them on the PDF.
const ZONE_FIELDS = ['invoice_number', 'invoice_date', 'due_date', 'description', 'net', 'vat', 'total'];

// Generic labels (English, German, French, Dutch), most specific first.
const LABELS = {
  invoice_number: ['invoice number', 'invoice no', 'invoice #', 'invoice nr', 'inv no', 'inv #', 'rechnungsnummer', 'rechnungs-nr', 'rechnung nr', 'numéro de facture', 'facture n', 'factuurnummer', 'factuur nr', 'invoice'],
  invoice_date: ['invoice date', 'date of invoice', 'tax point', 'rechnungsdatum', 'date de facture', 'factuurdatum', 'datum', 'date'],
  due_date: ['due date', 'payment due', 'pay by', 'due by', 'zahlbar bis', 'fällig am', 'fällig', 'échéance', 'date d\'échéance', 'vervaldatum', 'uiterste betaaldatum'],
  net: ['subtotal', 'sub total', 'sub-total', 'net amount', 'total net', 'net total', 'total excl', 'amount excl', 'nettobetrag', 'netto', 'zwischensumme', 'total ht', 'montant ht', 'subtotaal', 'totaal excl'],
  vat: ['vat amount', 'total vat', 'vat', 'sales tax', 'tax', 'mwst', 'mehrwertsteuer', 'ust', 'tva', 'btw'],
  total: ['total due', 'amount due', 'balance due', 'grand total', 'invoice total', 'total amount', 'total to pay', 'gesamtbetrag', 'rechnungsbetrag', 'endbetrag', 'total ttc', 'montant ttc', 'net à payer', 'totaal incl', 'te betalen', 'totaal', 'total'],
};
// Lines with these words carry identifiers, not amounts (e.g. "VAT Reg No").
const NOT_AMOUNT_LINE = /\b(reg(istration)?\.?\s*(no|number)|vat\s*(no|number|id)|ust-?id|steuer-?nr|tva intracom|btw-?nr|kvk|company no)\b/i;

const MONTHS = {
  jan: 1, january: 1, januar: 1, janvier: 1, januari: 1,
  feb: 2, february: 2, februar: 2, février: 2, februari: 2,
  mar: 3, march: 3, märz: 3, maerz: 3, mars: 3, maart: 3,
  apr: 4, april: 4, avril: 4,
  may: 5, mai: 5, mei: 5,
  jun: 6, june: 6, juni: 6, juin: 6,
  jul: 7, july: 7, juli: 7, juillet: 7,
  aug: 8, august: 8, août: 8, augustus: 8,
  sep: 9, sept: 9, september: 9, septembre: 9,
  oct: 10, october: 10, oktober: 10, octobre: 10, okt: 10,
  nov: 11, november: 11, novembre: 11,
  dec: 12, december: 12, dezember: 12, décembre: 12, dez: 12,
};

// ---------- text helpers ----------

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Dates in a piece of text, as { iso, raw, index, order }; order says which reading was used for dd/mm vs mm/dd. */
function findDates(text, preferOrder = 'DMY') {
  const out = [];
  let m;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) {
    const v = validDate(+m[1], +m[2], +m[3]);
    if (v) out.push({ iso: v, raw: m[0], index: m.index, order: 'YMD' });
  }
  const num = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g;
  while ((m = num.exec(text))) {
    if (out.some((o) => o.index === m.index)) continue;
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    const dmy = validDate(y, b, a);
    const mdy = validDate(y, a, b);
    // Only one reading possible -> that one; both possible -> the supplier's (or default) order.
    let v = null;
    let order = preferOrder;
    if (dmy && !mdy) [v, order] = [dmy, 'DMY'];
    else if (mdy && !dmy) [v, order] = [mdy, 'MDY'];
    else if (dmy && mdy) v = preferOrder === 'MDY' ? mdy : dmy;
    if (v) out.push({ iso: v, raw: m[0], index: m.index, order });
  }
  const words = /\b(\d{1,2})\.?\s+([A-Za-zäéû]{3,10})\.?,?\s+(\d{4})\b|\b([A-Za-zäéû]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
  while ((m = words.exec(text))) {
    const [d, mon, y] = m[1] ? [+m[1], m[2], +m[3]] : [+m[5], m[4], +m[6]];
    const month = MONTHS[mon.toLowerCase()];
    const v = month && validDate(y, month, d);
    if (v) out.push({ iso: v, raw: m[0], index: m.index, order: 'TEXT' });
  }
  return out.sort((x, y) => x.index - y.index);
}

/** Money amounts in a piece of text (1,234.56 / 1.234,56 / 1 234,56 / 850.00), as { value, raw, index, style }. */
function findAmounts(text) {
  const out = [];
  const re = /(?<![\d.,])-?\d{1,3}(?:([.,\s '])\d{3})*(?:[.,]\d{2})(?![\d])|(?<![\d.,])-?\d+[.,]\d{2}(?![\d])/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const lastSep = raw.search(/[.,](?=\d{2}$)/);
    const intPart = raw.slice(0, lastSep).replace(/[.,\s ']/g, '');
    const value = Number(`${intPart}.${raw.slice(lastSep + 1)}`);
    if (Number.isFinite(value)) out.push({ value, raw, index: m.index, style: raw[lastSep] === ',' ? 'EU' : 'UK' });
  }
  return out;
}

/** The text a document uses to show an amount, in both number styles (to find it again when learning). */
function amountSpellings(v) {
  const [i, d] = Math.abs(v).toFixed(2).split('.');
  const withSep = (sep) => i.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return [...new Set([`${withSep(',')}.${d}`, `${i}.${d}`, `${withSep('.')},${d}`, `${i},${d}`, `${withSep(' ')},${d}`])];
}

function dateSpellings(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return [
    { raw: iso, order: 'YMD' },
    { raw: `${pad(d)}/${pad(m)}/${y}`, order: 'DMY' },
    { raw: `${d}/${m}/${y}`, order: 'DMY' },
    { raw: `${pad(d)}.${pad(m)}.${y}`, order: 'DMY' },
    { raw: `${d}.${m}.${y}`, order: 'DMY' },
    { raw: `${pad(d)}-${pad(m)}-${y}`, order: 'DMY' },
    { raw: `${pad(m)}/${pad(d)}/${y}`, order: 'MDY' },
    { raw: `${m}/${d}/${y}`, order: 'MDY' },
    { raw: `${pad(m)}-${pad(d)}-${y}`, order: 'MDY' },
  ].filter((x, i, all) => all.findIndex((o) => o.raw === x.raw) === i);
}

// ---------- supplier matching ----------

const LEGAL_WORDS = new Set(['ltd', 'limited', 'gmbh', 'inc', 'llc', 'plc', 'sarl', 'sas', 'bv', 'nv', 'ag', 'co', 'the', 'and']);

function scoreSupplier(s, text, profile) {
  const flat = compact(text);
  let score = 0;
  const reasons = [];
  if (s.vat_number && compact(s.vat_number).length >= 6 && flat.includes(compact(s.vat_number))) {
    score += 100;
    reasons.push('VAT number');
  }
  if (s.iban && flat.includes(compact(s.iban))) {
    score += 100;
    reasons.push('IBAN');
  }
  if (s.account_number && flat.includes(compact(s.account_number)) && (!s.sort_code || flat.includes(compact(s.sort_code)))) {
    score += 60;
    reasons.push('bank account');
  }
  for (const alias of (profile && profile.aliases) || []) {
    if (compact(alias).length >= 4 && flat.includes(compact(alias))) {
      score += 80;
      reasons.push('learned letterhead');
      break;
    }
  }
  if (flat.includes(compact(s.name))) {
    score += 70;
    reasons.push('name');
  } else {
    const words = norm(s.name).split(/[^a-z0-9äöüéè]+/).filter((w) => w.length >= 4 && !LEGAL_WORDS.has(w));
    const found = words.filter((w) => norm(text).includes(w));
    if (words.length && found.length) {
      score += Math.round((40 * found.length) / words.length);
      reasons.push('part of name');
    }
  }
  return { score, reasons };
}

// ---------- zones (positions marked on the PDF) ----------

function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 4000)
    .map((i) => ({ p: Number(i.p) || 1, x: +i.x, y: +i.y, w: +i.w, h: +i.h, s: String(i.s || '').slice(0, 200) }))
    .filter((i) => [i.x, i.y, i.w, i.h].every(Number.isFinite) && i.s.trim());
}

function cleanZone(z) {
  if (!z) return null;
  const n = (v) => Math.min(1, Math.max(0, Number(v)));
  const zone = { page: Math.max(1, Math.floor(Number(z.page) || 1)), x0: n(Math.min(z.x0, z.x1)), y0: n(Math.min(z.y0, z.y1)), x1: n(Math.max(z.x0, z.x1)), y1: n(Math.max(z.y0, z.y1)) };
  return zone.x1 - zone.x0 > 0.003 && zone.y1 - zone.y0 > 0.003 ? zone : null;
}

/** The text inside a zone: items whose middle lies in it (with a little slack), in reading order. */
function zoneText(items, zone) {
  const slack = 0.006;
  const inside = items
    .filter((i) => i.p === zone.page)
    .filter((i) => {
      const cx = i.x + i.w / 2;
      const cy = i.y + i.h / 2;
      return cx >= zone.x0 - slack && cx <= zone.x1 + slack && cy >= zone.y0 - slack && cy <= zone.y1 + slack;
    })
    .sort((a, b) => (Math.abs(a.y - b.y) < 0.005 ? a.x - b.x : a.y - b.y));
  let text = '';
  let lastY = null;
  for (const i of inside) {
    if (lastY !== null) text += Math.abs(i.y - lastY) < 0.005 ? ' ' : '\n';
    text += i.s;
    lastY = i.y;
  }
  return text.trim();
}

/** Read one field's value from a piece of text, the same way the label rules do. */
function parseField(field, text, order) {
  if (!text) return null;
  if (field === 'invoice_number') {
    return pickNumber(text) || (text.split(/\s+/).find((t) => /\d/.test(t)) || '').replace(/^[#:]+|[.,:]+$/g, '') || null;
  }
  if (field === 'invoice_date' || field === 'due_date') {
    const d = findDates(text, order)[0];
    return d ? d.iso : null;
  }
  if (field === 'net' || field === 'vat' || field === 'total') {
    const a = findAmounts(text);
    return a.length ? a[a.length - 1].value : null;
  }
  if (field === 'description') return text.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  return null;
}

// ---------- field extraction ----------

/** Find the value for a field next to one of its labels: same line after the label, or the next line. */
function byLabel(lines, labels, pick) {
  for (const label of labels) {
    const l = norm(label);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pos = norm(line).indexOf(l);
      if (pos < 0) continue;
      // Label must start at a word boundary.
      const before = norm(line)[pos - 1];
      if (before && /[a-z0-9]/.test(before)) continue;
      const after = line.slice(pos + l.length);
      // The label's own column (between " | " separators), e.g. to skip "VAT Reg No" lines.
      const colStart = line.lastIndexOf('|', pos) + 1;
      const colEnd = line.indexOf('|', pos);
      const column = line.slice(colStart, colEnd < 0 ? undefined : colEnd);
      const v = pick(after, column) ?? (lines[i + 1] !== undefined ? pick(lines[i + 1], lines[i + 1]) : null);
      if (v !== null && v !== undefined) return { value: v, label, line: i };
    }
  }
  return null;
}

const pickNumber = (text) => {
  const m = String(text).match(/^[\s:#.\-–|]*(?:no\.?|nr\.?|number|#)?[\s:#.\-–|]*([A-Z0-9][A-Z0-9\-/._]{1,30})/i);
  return m && /\d/.test(m[1]) ? m[1].replace(/[.,]$/, '') : null;
};

function extractFields(lines, profile, preferOrder, zoneValues = {}) {
  const learned = (profile && profile.labels) || {};
  const result = {};
  // Values read from positions the user marked on this supplier's invoices come first.
  for (const [field, value] of Object.entries(zoneValues)) {
    if (field !== 'description') result[field] = { value, source: 'learned', label: 'its marked position on the invoice', zone: true };
  }
  const labelsFor = (field) => [...(learned[field] || []), ...LABELS[field]];
  const source = (field, hit) => (hit && (learned[field] || []).includes(hit.label) ? 'learned' : 'generic');

  const num = result.invoice_number ? null : byLabel(lines, labelsFor('invoice_number'), pickNumber);
  if (num) result.invoice_number = { value: num.value, source: source('invoice_number', num), label: num.label };

  for (const field of ['invoice_date', 'due_date']) {
    if (result[field]) continue;
    const hit = byLabel(lines, labelsFor(field), (t) => {
      const d = findDates(t, preferOrder)[0];
      return d ? d : null;
    });
    if (hit) result[field] = { value: hit.value.iso, source: source(field, hit), label: hit.label, order: hit.value.order };
  }
  if (!result.invoice_date) {
    // First date anywhere is usually the invoice date.
    const d = findDates(lines.join('\n'), preferOrder)[0];
    if (d) result.invoice_date = { value: d.iso, source: 'guess', order: d.order };
  }

  for (const field of ['net', 'vat', 'total']) {
    if (result[field]) continue;
    const hit = byLabel(lines, labelsFor(field), (t, line) => {
      if (NOT_AMOUNT_LINE.test(line)) return null;
      const amounts = findAmounts(t);
      return amounts.length ? amounts[amounts.length - 1] : null;
    });
    if (hit) result[field] = { value: hit.value.value, source: source(field, hit), label: hit.label, style: hit.value.style };
  }
  if (!result.total) {
    const all = lines.flatMap((l) => (NOT_AMOUNT_LINE.test(l) ? [] : findAmounts(l)));
    if (all.length) result.total = { value: Math.max(...all.map((a) => a.value)), source: 'guess' };
  }
  // Fill a missing amount from the other two; flag totals that don't add up.
  const n = result.net && result.net.value;
  const v = result.vat && result.vat.value;
  const t = result.total && result.total.value;
  if (t !== undefined && v !== undefined && n === undefined) result.net = { value: round2(t - v), source: 'calculated' };
  if (t !== undefined && n !== undefined && v === undefined) result.vat = { value: round2(t - n), source: 'calculated' };
  if (n !== undefined && v !== undefined && t === undefined) result.total = { value: round2(n + v), source: 'calculated' };
  if (t !== undefined && result.net && result.vat && Math.abs(result.net.value + result.vat.value - t) > 0.011) {
    result.total.mismatch = true;
  }
  return result;
}

function detectCurrency(text, supplier, profile) {
  const counts = {
    GBP: (text.match(/£|\bGBP\b/g) || []).length,
    EUR: (text.match(/€|\bEUR\b/g) || []).length,
    USD: (text.match(/\$|\bUSD\b/g) || []).length,
  };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (best[1] > 0) return { value: best[0], source: profile && profile.currency === best[0] ? 'learned' : 'generic' };
  if (profile && profile.currency) return { value: profile.currency, source: 'learned' };
  if (supplier) return { value: supplier.currency, source: 'supplier' };
  return { value: 'GBP', source: 'guess' };
}

// ---------- profiles & documents ----------

async function getProfile(supplierId) {
  const row = await db.get('SELECT * FROM vendor_profiles WHERE supplier_id = ?', supplierId);
  return row ? { ...JSON.parse(row.profile_json), documents: row.documents, fields_checked: row.fields_checked, fields_correct: row.fields_correct } : null;
}

async function saveProfile(supplierId, profile, stats) {
  const json = JSON.stringify({ labels: profile.labels, date_order: profile.date_order, currency: profile.currency, aliases: profile.aliases, defaults: profile.defaults, zones: profile.zones, last: profile.last });
  const existing = await db.get('SELECT supplier_id FROM vendor_profiles WHERE supplier_id = ?', supplierId);
  if (existing) {
    await db.run(
      'UPDATE vendor_profiles SET profile_json = ?, documents = documents + 1, fields_checked = fields_checked + ?, fields_correct = fields_correct + ?, updated_at = CURRENT_TIMESTAMP WHERE supplier_id = ?',
      json, stats.checked, stats.correct, supplierId
    );
  } else {
    await db.run(
      'INSERT INTO vendor_profiles (supplier_id, profile_json, documents, fields_checked, fields_correct) VALUES (?, ?, 1, ?, ?)',
      supplierId, json, stats.checked, stats.correct
    );
  }
}

async function listProfiles() {
  const rows = await db.all(
    `SELECT p.*, s.name AS supplier_name FROM vendor_profiles p JOIN suppliers s ON s.id = p.supplier_id ORDER BY s.name`
  );
  return rows.map((r) => {
    const p = JSON.parse(r.profile_json);
    return {
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      documents: r.documents,
      accuracy: r.fields_checked ? round2(r.fields_correct / r.fields_checked) : null,
      last: p.last || null,
      labels: p.labels || {},
      date_order: p.date_order || null,
      currency: p.currency || null,
      aliases: p.aliases || [],
      defaults: p.defaults || null,
      zones: Object.keys(p.zones || {}),
      updated_at: r.updated_at,
    };
  });
}

async function forgetProfile(supplierId) {
  await db.run('DELETE FROM vendor_profiles WHERE supplier_id = ?', Number(supplierId));
  return { ok: true };
}

// ---------- recognise ----------

/**
 * Store an uploaded PDF and suggest the invoice fields.
 *   pdf_base64: the file; lines: its text in reading order (from pdf.js in the browser).
 */
async function recognise({ filename, pdf_base64, lines, items, entity_id }, user) {
  const entity = await acct.requireEntity(entity_id);
  const pdf = Buffer.from(String(pdf_base64 || ''), 'base64');
  if (!pdf.length) throw httpError(400, 'The file is empty');
  if (pdf.length > MAX_PDF_BYTES) throw httpError(400, 'The PDF is larger than 3 MB');
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'This is not a PDF file');
  const textLines = (Array.isArray(lines) ? lines : []).map((l) => String(l).replace(/\s+/g, ' ').trim().slice(0, 500)).slice(0, 400);
  const text = textLines.join('\n');
  const textItems = cleanItems(items);

  const suppliers = await acct.listParties('supplier');
  const profiles = Object.fromEntries((await db.all('SELECT supplier_id, profile_json FROM vendor_profiles')).map((r) => [r.supplier_id, JSON.parse(r.profile_json)]));
  const scored = suppliers.map((s) => ({ s, ...scoreSupplier(s, text, profiles[s.id]) })).sort((a, b) => b.score - a.score);
  const best = scored[0] && scored[0].score >= 40 ? scored[0] : null;
  const supplier = best ? best.s : null;
  const profile = supplier ? await getProfile(supplier.id) : null;

  // Suppliers from the US write month/day; learned order wins, otherwise guess from the country.
  const preferOrder = (profile && profile.date_order) || (supplier && /united states|usa/i.test(supplier.country || '') ? 'MDY' : 'DMY');
  const zones = (profile && profile.zones) || {};
  const zoneValues = {};
  for (const [field, zone] of Object.entries(zones)) {
    const v = parseField(field, zoneText(textItems, zone), preferOrder);
    if (v !== null) zoneValues[field] = v;
  }
  const f = extractFields(textLines, profile, preferOrder, zoneValues);
  const currency = detectCurrency(text, supplier, profile);

  // VAT code from the rate (VAT / net), otherwise the supplier's usual code.
  const vatCodes = (await acct.listVatCodes()).filter((v) => v.active);
  const defaults = (profile && profile.defaults) || null;
  let vatCode = null;
  if (f.net && f.vat && f.net.value > 0) {
    const rate = (f.vat.value / f.net.value) * 100;
    const nearest = vatCodes.reduce((a, b) => (!a || Math.abs(b.rate - rate) < Math.abs(a.rate - rate) ? b : a), null);
    if (nearest && Math.abs(nearest.rate - rate) <= 1) vatCode = { value: nearest.code, source: 'calculated' };
  }
  if (!vatCode && defaults && defaults.vat_code) vatCode = { value: defaults.vat_code, source: 'learned' };

  const net = f.net ? f.net.value : f.total ? f.total.value : 0;
  const line = {
    description: zoneValues.description || (defaults && defaults.description) || (f.invoice_number ? `Invoice ${f.invoice_number.value}` : 'Invoice'),
    account_code: (defaults && defaults.account_code) || '5000',
    cost_center: (defaults && defaults.cost_center) || null,
    vat_code: vatCode ? vatCode.value : null,
    net_amount: net,
    source: defaults ? 'learned' : 'default',
  };

  const suggestion = {
    supplier: supplier ? { value: supplier.id, name: supplier.name, source: best.reasons.includes('learned letterhead') ? 'learned' : 'generic', reasons: best.reasons, score: best.score } : null,
    invoice_number: f.invoice_number || null,
    invoice_date: f.invoice_date || null,
    due_date: f.due_date || null,
    currency,
    net: f.net || null,
    vat: f.vat || null,
    total: f.total || null,
    vat_code: vatCode,
    lines: [line],
    no_text: textLines.join('').trim().length === 0,
    zones,
    profile: profile ? { documents: profile.documents, accuracy: profile.fields_checked ? round2(profile.fields_correct / profile.fields_checked) : null } : null,
  };

  const { row } = await db.run(
    'INSERT INTO documents (entity_id, filename, content_type, size, data, text_lines, items_json, suggestion_json, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    entity.id,
    String(filename || 'invoice.pdf').slice(0, 200),
    'application/pdf',
    pdf.length,
    pdf,
    JSON.stringify(textLines),
    JSON.stringify(textItems),
    JSON.stringify(suggestion),
    user ? user.name : null
  );
  return { document_id: row.id, ...suggestion };
}

// ---------- learn ----------

/** The label in front of a value: text before it on its line, or the line above when the value stands alone. */
function labelBefore(lines, lineIndex, pos) {
  const clean = (s) =>
    norm(s)
      .replace(/[:#\s.\-–|]+$/, '')
      .split('|')
      .pop()
      .trim()
      .split(' ')
      .slice(-4)
      .join(' ')
      .trim();
  let label = clean(lines[lineIndex].slice(0, pos));
  // Ignore a leading amount/date that isn't a label.
  if (!/[a-zäöüé]{2}/.test(label) && lineIndex > 0) label = clean(lines[lineIndex - 1]);
  return /[a-zäöüé]{2}/.test(label) && label.length <= 40 ? label : null;
}

/** Where a value appears in the text; `last` searches from the bottom (totals come last). */
function locate(lines, spellings, last = false) {
  const order = lines.map((_, i) => i);
  if (last) order.reverse();
  for (const i of order) {
    for (const sp of spellings) {
      const raw = typeof sp === 'string' ? sp : sp.raw;
      const pos = lines[i].toLowerCase().indexOf(raw.toLowerCase());
      if (pos < 0) continue;
      // Must not be part of a longer number.
      const before = lines[i][pos - 1];
      const after = lines[i][pos + raw.length];
      if ((before && /[\d.,]/.test(before)) || (after && /\d/.test(after))) continue;
      return { line: i, pos, spelling: sp };
    }
  }
  return null;
}

/**
 * After an invoice made from a document is saved: link the document, compare the
 * final values with the suggestion and update the supplier's profile.
 * Returns what was learned, to show the user.
 */
async function learnFromInvoice(documentId, invoice, payload) {
  const doc = await db.get('SELECT * FROM documents WHERE id = ?', Number(documentId));
  if (!doc) return null;
  await db.run('UPDATE documents SET invoice_id = ? WHERE id = ?', invoice.id, doc.id);
  if (invoice.type !== 'purchase') return null;
  const lines = JSON.parse(doc.text_lines || '[]');
  const sug = JSON.parse(doc.suggestion_json || '{}');
  const supplierId = invoice.party_id;
  const profile = (await getProfile(supplierId)) || {};
  profile.labels = profile.labels || {};
  profile.aliases = profile.aliases || [];

  const final = {
    supplier: supplierId,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    due_date: invoice.due_date || null,
    currency: invoice.currency,
    net: invoice.net_amount,
    vat: invoice.vat_amount,
    total: invoice.total_amount,
  };
  const suggested = {
    supplier: sug.supplier ? sug.supplier.value : null,
    invoice_number: sug.invoice_number ? sug.invoice_number.value : null,
    invoice_date: sug.invoice_date ? sug.invoice_date.value : null,
    due_date: sug.due_date ? sug.due_date.value : null,
    currency: sug.currency ? sug.currency.value : null,
    net: sug.net ? sug.net.value : null,
    vat: sug.vat ? sug.vat.value : null,
    total: sug.total ? sug.total.value : null,
  };
  const same = (k) => (typeof final[k] === 'number' ? suggested[k] !== null && Math.abs(final[k] - suggested[k]) < 0.005 : String(suggested[k] ?? '') === String(final[k] ?? ''));
  const checked = FIELDS.filter((k) => final[k] !== null && final[k] !== undefined && !(k === 'due_date' && !final.due_date));
  const corrected = checked.filter((k) => !same(k));
  const learned = [];

  const remember = (field, label) => {
    if (!label) return;
    const list = profile.labels[field] || [];
    if (list[0] === label) return;
    profile.labels[field] = [label, ...list.filter((l) => l !== label)].slice(0, 3);
    learned.push(`${field.replace('_', ' ')} is labelled "${label}"`);
  };

  // Labels: find each final value in the document and remember what precedes it.
  const numHit = locate(lines, [final.invoice_number]);
  if (numHit) remember('invoice_number', labelBefore(lines, numHit.line, numHit.pos));
  for (const field of ['invoice_date', 'due_date']) {
    if (!final[field]) continue;
    const hit = locate(lines, dateSpellings(final[field]));
    if (!hit) continue;
    remember(field, labelBefore(lines, hit.line, hit.pos));
    // Learn day/month order from an unambiguous or corrected date.
    const order = hit.spelling.order;
    if ((order === 'DMY' || order === 'MDY') && profile.date_order !== order) {
      profile.date_order = order;
      learned.push(`dates are written ${order === 'MDY' ? 'month/day/year' : 'day/month/year'}`);
    }
  }
  for (const field of ['net', 'vat', 'total']) {
    if (final[field] === null || final[field] === undefined || (field === 'vat' && final.vat === 0 && !corrected.includes('vat'))) continue;
    // Net can equal the total (0% VAT): the total is the one furthest down.
    const hit = locate(lines, amountSpellings(final[field]), field === 'total');
    if (hit) remember(field, labelBefore(lines, hit.line, hit.pos));
  }
  if (profile.currency !== final.currency) {
    profile.currency = final.currency;
    if (corrected.includes('currency')) learned.push(`invoices are in ${final.currency}`);
  }
  // Letterhead: when the supplier wasn't recognised (or was recognised wrongly), remember its first lines.
  if (corrected.includes('supplier') || !sug.supplier || sug.supplier.score < 70) {
    const header = lines.map((l) => l.trim()).filter((l) => /[a-z]{3}/i.test(l) && l.length >= 4 && l.length <= 60 && !findAmounts(l).length).slice(0, 2);
    for (const h of header) if (!profile.aliases.includes(h)) profile.aliases.push(h);
    profile.aliases = profile.aliases.slice(-6);
    if (header.length) learned.push(`recognise the supplier by "${header[0]}"`);
  }
  // Booking: the first line's account, cost centre, VAT code and description.
  const first = (payload.lines || [])[0];
  if (first) {
    const def = { account_code: first.account_code, cost_center: first.cost_center || null, vat_code: first.vat_code || null, description: first.description || null };
    const prev = profile.defaults || {};
    if (prev.account_code !== def.account_code || prev.cost_center !== def.cost_center || prev.vat_code !== def.vat_code) {
      learned.push(`book on ${def.account_code}${def.cost_center ? ` / cost centre ${def.cost_center}` : ''}${def.vat_code ? ` with ${def.vat_code}` : ''}`);
    }
    // A description that is only this invoice's number isn't a useful default.
    if (def.description && def.description.includes(final.invoice_number)) def.description = null;
    profile.defaults = def;
  }
  // Positions the user marked on the PDF: tried first next time.
  profile.zones = profile.zones || {};
  for (const [field, z] of Object.entries(payload.zones || {})) {
    const zone = ZONE_FIELDS.includes(field) && cleanZone(z);
    if (!zone) continue;
    profile.zones[field] = zone;
    learned.push(`${field.replace('_', ' ')} is at the position you marked (page ${zone.page})`);
  }
  profile.last = { correct: checked.length - corrected.length, checked: checked.length, corrected, at: new Date().toISOString().slice(0, 10) };
  await saveProfile(supplierId, profile, { checked: checked.length, correct: checked.length - corrected.length });
  return { supplier_id: supplierId, checked: checked.length, correct: checked.length - corrected.length, corrected, learned };
}

/**
 * Read the text in a box the user just drew on the PDF and the value for the
 * field it was drawn for (the zone is remembered when the invoice is saved).
 */
async function readZone({ document_id, field, zone, supplier_id }) {
  if (!ZONE_FIELDS.includes(field)) throw httpError(400, 'This field can\'t be marked on the invoice');
  const z = cleanZone(zone);
  if (!z) throw httpError(400, 'Draw a box around the value on the invoice');
  const doc = await db.get('SELECT items_json FROM documents WHERE id = ?', Number(document_id));
  if (!doc) throw httpError(404, 'Document not found');
  const profile = supplier_id ? await getProfile(Number(supplier_id)) : null;
  const supplier = supplier_id ? await acct.getParty('supplier', Number(supplier_id)) : null;
  const order = (profile && profile.date_order) || (supplier && /united states|usa/i.test(supplier.country || '') ? 'MDY' : 'DMY');
  const text = zoneText(JSON.parse(doc.items_json || '[]'), z);
  return { field, zone: z, text, value: parseField(field, text, order) };
}

async function getDocument(id) {
  return db.get('SELECT id, entity_id, filename, content_type, size, data, invoice_id, uploaded_by, created_at FROM documents WHERE id = ?', Number(id));
}

async function documentForInvoice(invoiceId) {
  return db.get('SELECT id, filename, size, created_at FROM documents WHERE invoice_id = ? ORDER BY id DESC LIMIT 1', Number(invoiceId));
}

module.exports = { recognise, learnFromInvoice, readZone, listProfiles, forgetProfile, getDocument, documentForInvoice, findDates, findAmounts, zoneText };
