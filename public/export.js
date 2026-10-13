'use strict';

/**
 * Export of any table in the app to CSV, Excel (.xlsx) or PDF.
 * Everything happens in the browser, from the table as it is shown (so it
 * follows the selected company, period and filters). Adds a small
 * "Export" bar above every table that has an id.
 *   CSV   UTF-8 with a byte-order mark, comma separated, numbers as plain numbers
 *   Excel a real .xlsx workbook (zip of XML, written here without a library)
 *   PDF   a clean print view; choose "Save as PDF" in the print dialog
 */

// ----- Reading a table -----

/** Text and number of one cell: "£1,234.50" and "-12.00" in a numeric column become numbers. */
function exportCellValue(cell) {
  const clone = cell.cloneNode(true);
  clone.querySelectorAll('button, select, input, script, style').forEach((el) => el.remove());
  const text = clone.innerText !== undefined ? clone.innerText : clone.textContent;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const numeric = cell.classList.contains('num') || cell.closest('table.fin') !== null;
  if (numeric && /^-?[£$€]?\s?-?[\d,]+(\.\d+)?$/.test(clean)) {
    const n = Number(clean.replace(/[£$€,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return clean;
}

/** The table as rows of values, header row first; empty columns (action buttons) are dropped. */
function exportTableRows(table) {
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.closest('table') !== table) continue;
    const row = [];
    for (const cell of tr.children) {
      row.push(exportCellValue(cell));
      for (let i = 1; i < (Number(cell.colSpan) || 1); i++) row.push('');
    }
    if (row.some((v) => v !== '')) rows.push(row);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push('');
  const keep = [];
  for (let c = 0; c < width; c++) if (rows.some((r) => r[c] !== '')) keep.push(c);
  return rows.map((r) => keep.map((c) => r[c]));
}

// ----- Naming -----

function exportTitle(table) {
  const panel = table.closest('.panel, dialog, section');
  const heading = panel && panel.querySelector('h2');
  const base = (heading && heading.textContent.trim()) || table.id || 'export';
  return base;
}

function exportContext() {
  const sel = document.getElementById('entity-select');
  const company = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
  return `${company} · exported ${new Date().toLocaleString('en-GB')}`;
}

function exportFileName(table, ext) {
  const slug = exportTitle(table).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'export';
  return `sc-technology-${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function exportDownload(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ----- CSV -----

function buildCsv(rows) {
  const q = (v) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// ----- XLSX (zip with stored entries) -----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip of [{ name, data: string }] without compression. */
function buildZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);
    const header = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    chunks.push(new Uint8Array(header), name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += header.length + name.length + data.length;
  }
  const centralStart = offset;
  for (const c of central) {
    const h = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(c.crc), ...u32(c.size), ...u32(c.size),
      ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)];
    chunks.push(new Uint8Array(h), c.name);
    offset += h.length + c.name.length;
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(offset - centralStart), ...u32(centralStart), ...u16(0)];
  chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: 'application/zip' });
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function buildXlsx(rows, sheetName) {
  const widths = rows[0] ? rows[0].map((_, c) => Math.min(60, Math.max(8, ...rows.map((r) => String(r[c]).length)) + 2)) : [];
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          if (typeof v === 'number') return `<c r="${ref}" s="${ri === 0 ? 1 : 2}"><v>${v}</v></c>`;
          if (v === '') return '';
          return `<c r="${ref}" t="inlineStr" s="${ri === 0 ? 1 : 0}"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const name = xmlEscape(String(sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
  ]);
}

// ----- PDF (print view in a hidden frame; "Save as PDF" in the print dialog) -----

function exportPdf(table, rows) {
  const numeric = rows[0].map((_, c) => rows.slice(1).some((r) => typeof r[c] === 'number'));
  const fmtNum = (n) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${xmlEscape(exportTitle(table))}</title>
    <style>
      @page { size: A4 landscape; margin: 14mm; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; color: #1b2430; }
      h1 { font-size: 15pt; margin: 0 0 2px; }
      p { margin: 0 0 10px; color: #667085; font-size: 9pt; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #d9dee5; padding: 4px 6px; text-align: left; vertical-align: top; }
      th { background: #eef2f7; font-weight: 700; }
      td.n, th.n { text-align: right; white-space: nowrap; }
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
    </style></head><body>
    <h1>${xmlEscape(exportTitle(table))}</h1><p>${xmlEscape(exportContext())}</p>
    <table><thead><tr>${rows[0].map((h, c) => `<th class="${numeric[c] ? 'n' : ''}">${xmlEscape(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .slice(1)
      .map((r) => `<tr>${r.map((v, c) => `<td class="${numeric[c] ? 'n' : ''}">${xmlEscape(typeof v === 'number' ? fmtNum(v) : v)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  frame.contentDocument.open();
  frame.contentDocument.write(html);
  frame.contentDocument.close();
  const done = () => setTimeout(() => frame.remove(), 1000);
  frame.contentWindow.onafterprint = done;
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, 150);
}

// ----- The buttons -----

function exportTable(table, kind) {
  const rows = exportTableRows(table);
  if (!rows.length) {
    alert('There is nothing to export yet.');
    return;
  }
  if (kind === 'csv') exportDownload(exportFileName(table, 'csv'), new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  else if (kind === 'xlsx') exportDownload(exportFileName(table, 'xlsx'), buildXlsx(rows, exportTitle(table)));
  else exportPdf(table, rows);
}

/** Add an export bar above every table that has an id (safe to call again). */
function installExportButtons(root = document) {
  root.querySelectorAll('.table-wrap').forEach((wrap) => {
    const table = wrap.querySelector('table');
    if (!table || !table.id || table.id.startsWith('invoice-lines') || table.id === 'journal-lines') return;
    if (wrap.previousElementSibling && wrap.previousElementSibling.classList.contains('export-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'export-bar';
    bar.innerHTML = '<span>Export</span><button type="button" class="btn btn-small" data-export="csv">CSV</button><button type="button" class="btn btn-small" data-export="xlsx">Excel</button><button type="button" class="btn btn-small" data-export="pdf">PDF</button>';
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-export]');
      if (b) exportTable(table, b.dataset.export);
    });
    wrap.before(bar);
  });
}

if (typeof window !== 'undefined') {
  window.installExportButtons = installExportButtons;
  window.exportTableRows = exportTableRows;
  window.buildXlsx = buildXlsx;
  window.buildCsv = buildCsv;
}
