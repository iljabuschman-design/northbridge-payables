'use strict';

const { db, round2, transaction } = require('./db');
const acct = require('./accounting');
const fx = require('./fx');

const { httpError } = acct;

// ---------- Minimal CAMT (ISO 20022) reader ----------
// CAMT files are plain XML; we only need a handful of elements, so rather than
// pull in an XML library this extracts them with a few small helpers.

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** All inner XML blocks of <name>...</name> directly findable in xml. */
function blocks(xml, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** Text of the element at a slash-separated path, e.g. "Acct/Id/IBAN". */
function text(xml, pathStr) {
  let cur = xml;
  for (const part of pathStr.split('/')) {
    const found = blocks(cur, part)[0];
    if (found === undefined) return null;
    cur = found;
  }
  return decodeXml(cur.trim());
}

function first(xml, ...paths) {
  for (const p of paths) {
    const v = text(xml, p);
    if (v) return v;
  }
  return null;
}

function parseCamt(xmlRaw) {
  // Drop namespace prefixes (<ns2:Ntry> -> <Ntry>) so paths match either way.
  const xml = String(xmlRaw).replace(/<(\/?)[A-Za-z0-9_.-]+:/g, '<$1');
  // camt.053 = statement, camt.052 = intraday report, camt.054 = notification.
  const stmts = [...blocks(xml, 'Stmt'), ...blocks(xml, 'Rpt'), ...blocks(xml, 'Ntfctn')];
  if (stmts.length === 0) throw httpError(400, 'No statement found - is this a CAMT.053 / .052 / .054 XML file?');

  return stmts.map((s) => {
    const acctXml = blocks(s, 'Acct')[0] || '';
    const entries = blocks(s, 'Ntry').map((n) => {
      const amtMatch = n.match(/<Amt(?:\s+Ccy="([A-Z]{3})")?[^>]*>([^<]+)<\/Amt>/);
      const direction = text(n, 'CdtDbtInd');
      const booking = first(n, 'BookgDt/Dt', 'BookgDt/DtTm', 'ValDt/Dt', 'ValDt/DtTm');
      const tx = blocks(n, 'TxDtls')[0] || n;
      const parties = blocks(tx, 'RltdPties')[0] || '';
      // For money coming in, the counterparty is the debtor; going out, the creditor.
      const counterparty =
        direction === 'CRDT'
          ? first(parties, 'Dbtr/Pty/Nm', 'Dbtr/Nm')
          : first(parties, 'Cdtr/Pty/Nm', 'Cdtr/Nm');
      const ustrd = blocks(tx, 'Ustrd').map((u) => decodeXml(u.trim()));
      const remittance = ustrd.length ? ustrd.join(' ') : first(tx, 'RmtInf/Strd/CdtrRefInf/Ref', 'AddtlTxInf') || first(n, 'AddtlNtryInf');
      return {
        amount: amtMatch ? Number(amtMatch[2]) : NaN,
        currency: amtMatch ? amtMatch[1] || null : null,
        direction,
        booking_date: booking ? booking.slice(0, 10) : null,
        counterparty,
        remittance,
        reference: first(n, 'AcctSvcrRef', 'NtryRef') || first(tx, 'Refs/AcctSvcrRef', 'Refs/EndToEndId'),
      };
    });
    return {
      statement_ref: text(s, 'Id'),
      iban: text(acctXml, 'Id/IBAN'),
      currency: text(acctXml, 'Ccy'),
      from_date: (first(s, 'FrToDt/FrDtTm', 'FrToDt/FrDt') || '').slice(0, 10) || null,
      to_date: (first(s, 'FrToDt/ToDtTm', 'FrToDt/ToDt') || '').slice(0, 10) || null,
      entries,
    };
  });
}

// ---------- Import ----------

/**
 * Import a CAMT file into a bank ledger account. If no account is given, the
 * account whose IBAN matches the statement is used. Lines already imported
 * (same account, date, amount, direction and bank reference) are skipped.
 */
function importStatement({ filename, content, bank_account }) {
  if (!content) throw httpError(400, 'The file is empty');
  const parsed = parseCamt(content);

  return transaction(() => {
    const results = [];
    for (const st of parsed) {
      let bank = bank_account ? acct.getAccount(bank_account) : null;
      if (!bank && st.iban) {
        bank = db.prepare("SELECT * FROM accounts WHERE category = 'cash' AND iban = ?").get(st.iban.replace(/\s+/g, '').toUpperCase());
      }
      if (!bank || !bank.bank_currency) {
        throw httpError(400, `Choose the bank ledger account for this statement${st.iban ? ` (IBAN ${st.iban})` : ''}`);
      }
      const ccy = st.currency || st.entries.find((e) => e.currency)?.currency || bank.bank_currency;
      if (ccy !== bank.bank_currency) {
        throw httpError(400, `Statement is in ${ccy} but ${bank.code} ${bank.name} is a ${bank.bank_currency} account`);
      }
      // Remember the IBAN so the next statement for this account links itself.
      if (st.iban && !bank.iban) db.prepare('UPDATE accounts SET iban = ? WHERE code = ?').run(st.iban.replace(/\s+/g, '').toUpperCase(), bank.code);

      const info = db
        .prepare('INSERT INTO bank_statements (filename, bank_account, statement_ref, iban, currency, from_date, to_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(filename || null, bank.code, st.statement_ref, st.iban, ccy, st.from_date, st.to_date);
      const statementId = Number(info.lastInsertRowid);

      const dupCheck = db.prepare(
        `SELECT 1 FROM bank_statement_lines l JOIN bank_statements s ON s.id = l.statement_id
         WHERE s.bank_account = ? AND l.booking_date = ? AND l.amount = ? AND l.direction = ? AND l.reference = ?`
      );
      const insert = db.prepare(
        `INSERT INTO bank_statement_lines (statement_id, booking_date, amount, direction, currency, counterparty, remittance, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let imported = 0;
      let skipped = 0;
      for (const e of st.entries) {
        if (!(e.amount > 0) || !['CRDT', 'DBIT'].includes(e.direction) || !e.booking_date) {
          skipped++;
          continue;
        }
        if (e.reference && dupCheck.get(bank.code, e.booking_date, round2(e.amount), e.direction, e.reference)) {
          skipped++;
          continue;
        }
        insert.run(statementId, e.booking_date, round2(e.amount), e.direction, e.currency || ccy, e.counterparty, e.remittance, e.reference);
        imported++;
      }
      if (imported === 0) {
        // Nothing new (e.g. the same file uploaded twice): don't keep an empty statement.
        db.prepare('DELETE FROM bank_statements WHERE id = ?').run(statementId);
        results.push({ statement_id: null, bank_account: bank.code, imported, skipped });
        continue;
      }
      results.push({ statement_id: statementId, bank_account: bank.code, imported, skipped });
    }
    return results;
  });
}

function listStatements() {
  return db
    .prepare(
      `SELECT s.*, a.name AS bank_account_name, COUNT(l.id) AS line_count,
              SUM(CASE WHEN l.journal_id IS NULL THEN 1 ELSE 0 END) AS open_lines
       FROM bank_statements s JOIN accounts a ON a.code = s.bank_account
       LEFT JOIN bank_statement_lines l ON l.statement_id = s.id
       GROUP BY s.id ORDER BY s.uploaded_at DESC, s.id DESC`
    )
    .all();
}

function getStatement(id) {
  const s = db
    .prepare('SELECT s.*, a.name AS bank_account_name FROM bank_statements s JOIN accounts a ON a.code = s.bank_account WHERE s.id = ?')
    .get(id);
  if (!s) return null;
  const lines = db
    .prepare(
      `SELECT l.*, j.description AS journal_description,
              (SELECT GROUP_CONCAT(le.account_code, ', ') FROM ledger_entries le
                 WHERE le.journal_id = l.journal_id AND le.account_code <> ?) AS contra_accounts
       FROM bank_statement_lines l LEFT JOIN journals j ON j.id = l.journal_id
       WHERE l.statement_id = ? ORDER BY l.booking_date, l.id`
    )
    .all(s.bank_account, id);
  return { ...s, lines };
}

// ---------- Posting a statement line ----------

/**
 * Book one statement line against the bank ledger account, either
 *  - mode "account": against any contra account (Dr bank / Cr contra for
 *    money in, the reverse for money out), or
 *  - mode "invoice": as a payment/receipt of an open invoice, which also
 *    settles the invoice and books any FX difference.
 */
async function postLine(lineId, { mode, account_code, invoice_id, invoice_amount, description }) {
  const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(lineId);
  if (!line) throw httpError(404, 'Statement line not found');
  if (line.journal_id) throw httpError(400, 'This line has already been posted');
  const statement = db.prepare('SELECT * FROM bank_statements WHERE id = ?').get(line.statement_id);
  const bank = acct.getAccount(statement.bank_account);

  const rate = await fx.getRate(bank.bank_currency, line.booking_date);
  if (!rate) throw httpError(503, `No ${bank.bank_currency} exchange rate available for ${line.booking_date}`);
  const moneyIn = line.direction === 'CRDT';
  const label = [line.counterparty, line.remittance].filter(Boolean).join(' - ') || 'Bank statement line';

  return transaction(() => {
    let journalId;
    let paymentId = null;
    if (mode === 'invoice') {
      const invoice = acct.getInvoice(Number(invoice_id));
      if (!invoice) throw httpError(400, 'Choose an invoice');
      if (moneyIn !== (invoice.type === 'sale')) {
        throw httpError(400, moneyIn ? 'Money received can only settle a sales invoice' : 'Money paid out can only settle a purchase invoice');
      }
      const settled = invoice.currency === bank.bank_currency ? line.amount : Number(invoice_amount);
      const res = acct.createPayment({
        invoice_id: invoice.id,
        payment_date: line.booking_date,
        amount: settled,
        bank_account: bank.code,
        bank_amount: line.amount,
        bank_rate: rate.rate,
        notes: `Bank statement: ${label}`,
      });
      journalId = res.journal_id;
      paymentId = res.payment.id;
    } else if (mode === 'account') {
      const contra = acct.getAccount(account_code);
      if (!contra) throw httpError(400, 'Choose the opposing ledger account');
      if (contra.code === bank.code) throw httpError(400, 'The opposing account must differ from the bank account');
      const base = round2(line.amount * rate.rate);
      const fxNote = bank.bank_currency === 'GBP' ? null : `${line.amount.toFixed(2)} ${bank.bank_currency} @ ${rate.rate} (ECB ${rate.rate_date})`;
      const desc = description && String(description).trim() ? String(description).trim() : label;
      journalId = acct.postJournal({
        journal_date: line.booking_date,
        reference: line.reference,
        description: desc,
        source_type: 'bank',
        source_id: line.id,
        lines: [
          { account_code: bank.code, [moneyIn ? 'debit' : 'credit']: base, currency: bank.bank_currency, fx_note: fxNote, description: desc },
          { account_code: contra.code, [moneyIn ? 'credit' : 'debit']: base, currency: bank.bank_currency, fx_note: fxNote, description: desc },
        ],
      });
    } else {
      throw httpError(400, 'Mode must be "account" or "invoice"');
    }
    db.prepare('UPDATE bank_statement_lines SET journal_id = ?, payment_id = ? WHERE id = ?').run(journalId, paymentId, line.id);
    return db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(line.id);
  });
}

module.exports = { parseCamt, importStatement, listStatements, getStatement, postLine };
