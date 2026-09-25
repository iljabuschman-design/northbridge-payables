'use strict';

/**
 * Writes a few text-based sample supplier invoices (PDF) to
 * public/samples/invoices/, for trying out invoice recognition.
 * Run: node scripts/make-sample-invoices.js
 *
 * A minimal single-page PDF writer: Helvetica text only, WinAnsi encoding
 * (so £, € and ü work).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'samples', 'invoices');

// WinAnsi byte for the few non-ASCII characters used.
const WINANSI = { '€': 0x80, '£': 0xa3, 'ü': 0xfc, 'ä': 0xe4, 'ö': 0xf6, 'é': 0xe9, 'ß': 0xdf };

function pdfString(text) {
  let out = '';
  for (const ch of text) {
    const code = WINANSI[ch] || ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (code > 126) out += '\\' + code.toString(8).padStart(3, '0');
    else out += ch;
  }
  return `(${out})`;
}

/** items: [x, y, text, size?, bold?] with y measured from the top of an A4 page. */
function makePdf(items) {
  const H = 842;
  const content = items
    .map(([x, y, text, size = 10, bold = false]) => `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${H - y} Td ${pdfString(text)} Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const invoices = {
  'fenwick-doyle-FD-1107.pdf': [
    [50, 60, 'Fenwick & Doyle Ltd', 18, true],
    [50, 80, '14 Canal Street, Manchester M1 3HE, United Kingdom'],
    [50, 94, 'VAT Reg No: GB 123 4567 89'],
    [420, 60, 'INVOICE', 20, true],
    [50, 140, 'Bill to:', 10, true],
    [50, 154, 'Northbridge Trading Ltd'],
    [50, 168, '1 Quay Road, London E14 5AB'],
    [350, 140, 'Invoice No:'],
    [450, 140, 'FD-1107'],
    [350, 154, 'Invoice Date:'],
    [450, 154, '14/09/2026'],
    [350, 168, 'Due Date:'],
    [450, 168, '14/10/2026'],
    [50, 220, 'Description', 10, true],
    [380, 220, 'Qty', 10, true],
    [470, 220, 'Amount', 10, true],
    [50, 240, 'Office signage, 2 aluminium panels incl. fitting'],
    [385, 240, '1'],
    [470, 240, '£850.00'],
    [50, 256, 'Wall graphics, meeting room'],
    [385, 256, '1'],
    [470, 256, '£210.00'],
    [350, 300, 'Subtotal'],
    [470, 300, '£1,060.00'],
    [350, 316, 'VAT 20%'],
    [470, 316, '£212.00'],
    [350, 336, 'Total due', 11, true],
    [470, 336, '£1,272.00', 11, true],
    [50, 400, 'Please pay to: Fenwick & Doyle Ltd, sort code 20-00-00, account 55779911'],
    [50, 414, 'Payment terms: 30 days. Please quote the invoice number as reference.'],
  ],
  'rheinmetall-bauteile-RB-2318.pdf': [
    [50, 60, 'Rheinmetall Bauteile GmbH', 18, true],
    [50, 80, 'Industriestraße 12, 40210 Düsseldorf, Deutschland'],
    [50, 94, 'USt-IdNr.: DE987654321'],
    [420, 60, 'RECHNUNG', 20, true],
    [50, 140, 'An:', 10, true],
    [50, 154, 'Northbridge Trading Ltd, London, UK'],
    [340, 140, 'Rechnungsnummer:'],
    [460, 140, 'RB-2318'],
    [340, 154, 'Rechnungsdatum:'],
    [460, 154, '03.09.2026'],
    [340, 168, 'Zahlbar bis:'],
    [460, 168, '03.10.2026'],
    [50, 220, 'Position', 10, true],
    [460, 220, 'Betrag', 10, true],
    [50, 240, 'Präzisionsbauteile, Charge 9 (400 Stück)'],
    [460, 240, '3.950,00 EUR'],
    [50, 256, 'Fracht und Verpackung'],
    [460, 256, '400,00 EUR'],
    [340, 300, 'Nettobetrag'],
    [460, 300, '4.350,00 EUR'],
    [340, 316, 'MwSt 0% (Reverse Charge)'],
    [460, 316, '0,00 EUR'],
    [340, 336, 'Gesamtbetrag', 11, true],
    [460, 336, '4.350,00 EUR', 11, true],
    [50, 400, 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge).'],
    [50, 414, 'Bankverbindung: IBAN DE75 5121 0800 1245 1261 99, BIC SOGEDEFFXXX'],
  ],
  'rheinmetall-bauteile-RB-2355.pdf': [
    [50, 60, 'Rheinmetall Bauteile GmbH', 18, true],
    [50, 80, 'Industriestraße 12, 40210 Düsseldorf, Deutschland'],
    [50, 94, 'USt-IdNr.: DE987654321'],
    [420, 60, 'RECHNUNG', 20, true],
    [50, 140, 'An:', 10, true],
    [50, 154, 'Northbridge Trading Ltd, London, UK'],
    [340, 140, 'Rechnungsnummer:'],
    [460, 140, 'RB-2355'],
    [340, 154, 'Rechnungsdatum:'],
    [460, 154, '17.09.2026'],
    [340, 168, 'Zahlbar bis:'],
    [460, 168, '17.10.2026'],
    [50, 220, 'Position', 10, true],
    [460, 220, 'Betrag', 10, true],
    [50, 240, 'Präzisionsbauteile, Charge 10 (250 Stück)'],
    [460, 240, '2.480,00 EUR'],
    [340, 300, 'Nettobetrag'],
    [460, 300, '2.480,00 EUR'],
    [340, 316, 'MwSt 0% (Reverse Charge)'],
    [460, 316, '0,00 EUR'],
    [340, 336, 'Gesamtbetrag', 11, true],
    [460, 336, '2.480,00 EUR', 11, true],
    [50, 414, 'Bankverbindung: IBAN DE75 5121 0800 1245 1261 99, BIC SOGEDEFFXXX'],
  ],
  'atlas-fasteners-AF-7830.pdf': [
    [50, 60, 'ATLAS FASTENERS INC.', 18, true],
    [50, 80, '2200 Industrial Pkwy, Cleveland, OH 44114, USA'],
    [420, 60, 'INVOICE', 20, true],
    [50, 140, 'Sold to:', 10, true],
    [50, 154, 'Northbridge Trading Ltd'],
    [340, 140, 'Invoice #AF-7830'],
    [340, 154, 'Date: 09/12/2026'],
    [340, 168, 'Terms: Net 30'],
    [50, 220, 'Item', 10, true],
    [470, 220, 'Total', 10, true],
    [50, 240, 'Hex bolts M10 x 60, zinc plated (5,000 pcs)'],
    [470, 240, '$1,650.00'],
    [50, 256, 'Angle brackets 90 degree (1,500 pcs)'],
    [470, 256, '$750.00'],
    [350, 300, 'Subtotal'],
    [470, 300, '$2,400.00'],
    [350, 316, 'Sales tax (export)'],
    [470, 316, '$0.00'],
    [350, 336, 'Amount Due USD', 11, true],
    [470, 336, '2,400.00', 11, true],
    [50, 400, 'Wire to: Barclays, IBAN GB94 BARC 1020 1530 0934 59'],
  ],
};

/** The text lines the app's PDF reader produces: items on the same line, left to right, columns split by " | ". */
function textLines(items) {
  const rows = {};
  for (const [x, y, text] of items) (rows[y] ||= []).push([x, text]);
  return Object.keys(rows)
    .map(Number)
    .sort((a, b) => a - b)
    .map((y) => rows[y].sort((a, b) => a[0] - b[0]).map((i) => i[1]).join(' | '));
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, items] of Object.entries(invoices)) {
    fs.writeFileSync(path.join(OUT, name), makePdf(items));
    console.log('wrote', name);
  }
}

/** Text items with their box as fractions of the page (from the top left), like the app's PDF reader sends. */
function textItems(items) {
  return items.map(([x, y, text, size = 10]) => ({
    p: 1,
    x: x / 595,
    y: (y - size) / 842,
    w: (text.length * size * 0.5) / 595,
    h: size / 842,
    s: text,
  }));
}

module.exports = { invoices, textLines, textItems, makePdf };
