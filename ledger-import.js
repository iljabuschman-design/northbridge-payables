'use strict';

/**
 * Bulk import of ledger lines (from a CSV the browser has parsed). Rows sharing the same
 * journal key (and entity) form one journal, which must balance. The browser sends the file
 * in batches of whole journals; with dry_run nothing is kept, so a whole file can be checked
 * before anything is booked.
 */

const { transaction } = require('./db');
const acct = require('./accounting');

const MAX_ROWS = 5000;

class DryRunDone extends Error {}

function amount(v, line, label) {
  if (v === undefined || v === null || String(v).trim() === '') return 0;
  const n = Number(String(v).replace(/[\s,£€$]/g, ''));
  if (!Number.isFinite(n)) throw acct.httpError(400, `Line ${line}: ${label} "${v}" is not a number`);
  return n;
}

/** Group rows into journals, in file order. Row problems are collected, not thrown. */
function groupRows(rows, entitiesByCode, defaultEntityId, errors) {
  const journals = new Map();
  for (const r of rows) {
    const line = r.line;
    try {
      const key = String(r.journal ?? '').trim();
      if (!key) throw acct.httpError(400, `Line ${line}: journal key is empty (rows of one journal share the same value)`);
      let entityId = defaultEntityId;
      const code = String(r.entity ?? '').trim();
      if (code) {
        const e = entitiesByCode.get(code.toLowerCase());
        if (!e) throw acct.httpError(400, `Line ${line}: unknown entity "${code}"`);
        entityId = e.id;
      }
      if (!entityId) throw acct.httpError(400, `Line ${line}: no entity (add an entity column or choose one)`);
      const gk = `${entityId}|${key}`;
      let j = journals.get(gk);
      if (!j) {
        j = { key, entity_id: entityId, line, date: null, reference: null, description: null, currency: null, rate: null, lines: [] };
        journals.set(gk, j);
      }
      const date = String(r.date ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw acct.httpError(400, `Line ${line}: date "${date}" must be YYYY-MM-DD or DD/MM/YYYY`);
      if (j.date && j.date !== date) throw acct.httpError(400, `Line ${line}: journal ${key} has more than one date`);
      j.date = date;
      if (r.reference) j.reference = String(r.reference).trim();
      const description = String(r.description ?? '').trim();
      if (description && !j.description) j.description = description;
      if (r.currency) j.currency = String(r.currency).trim().toUpperCase();
      if (r.rate !== undefined && String(r.rate).trim() !== '') j.rate = Number(r.rate);
      const account = String(r.account ?? '').trim();
      if (!account) throw acct.httpError(400, `Line ${line}: account is empty`);
      j.lines.push({
        line,
        account_code: account,
        description: description || null,
        cost_center: String(r.cost_center ?? '').trim() || null,
        debit: amount(r.debit, line, 'debit'),
        credit: amount(r.credit, line, 'credit'),
      });
    } catch (err) {
      errors.push({ line, message: err.message });
    }
  }
  return [...journals.values()];
}

async function importLedger({ rows, dry_run, entity_id }) {
  if (!Array.isArray(rows) || rows.length === 0) throw acct.httpError(400, 'No rows to import');
  if (rows.length > MAX_ROWS) throw acct.httpError(400, `At most ${MAX_ROWS} rows per request`);
  const entities = await acct.listEntities();
  const byCode = new Map(entities.map((e) => [e.code.toLowerCase(), e]));
  const errors = [];
  const journals = groupRows(rows, byCode, Number(entity_id) || null, errors);

  const run = async () => {
    let booked = 0;
    for (const j of journals) {
      try {
        await acct.createManualJournal({
          entity_id: j.entity_id,
          journal_date: j.date,
          reference: j.reference || j.key,
          description: j.description || `Imported journal ${j.key}`,
          currency: j.currency || undefined,
          exchange_rate: j.rate || undefined,
          lines: j.lines.map(({ line, ...l }) => l),
        });
        booked++;
      } catch (err) {
        if (err.status && err.status < 500) errors.push({ line: j.line, message: `Journal ${j.key}: ${err.message}` });
        else throw err;
      }
    }
    return booked;
  };

  // Nothing is kept when anything is wrong, so a batch is all-or-nothing; a dry run never keeps anything.
  let booked = 0;
  try {
    await transaction(async () => {
      booked = await run();
      if (dry_run || errors.length) throw new DryRunDone();
    });
  } catch (err) {
    if (!(err instanceof DryRunDone)) throw err;
  }
  const ok = errors.length === 0;
  return {
    ok,
    dry_run: Boolean(dry_run),
    journals: journals.length,
    lines: rows.length,
    imported: ok && !dry_run ? booked : 0,
    errors: errors.sort((a, b) => a.line - b.line).slice(0, 200),
  };
}

module.exports = { importLedger };
