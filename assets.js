'use strict';

/**
 * Fixed asset register and monthly depreciation.
 *
 * Depreciation is straight-line: each month an asset depreciates
 * cost x rate / 12 (20% a year = written off over 5 years), starting in the
 * month it was acquired, until its book value reaches zero. It is posted as
 * one journal per period (Dr depreciation expense on the asset's cost centre,
 * Cr accumulated depreciation), dated the last day of the month, and runs
 * automatically once a month has ended.
 */

const { db, round2, transaction } = require('./db');
const acct = require('./accounting');

const { ROLES, httpError } = acct;

const ASSET_TYPES = {
  machinery: {
    name: 'Machinery',
    cost: ROLES.MACHINERY_COST,
    accumulated: ROLES.MACHINERY_ACCUM,
    expense: ROLES.MACHINERY_DEPR,
  },
  inventory: {
    name: 'Inventory (fixtures, fittings & equipment)',
    cost: ROLES.INVENTORY_COST,
    accumulated: ROLES.INVENTORY_ACCUM,
    expense: ROLES.INVENTORY_DEPR,
  },
};

const status = { last_run: null, last_result: null, last_error: null };

async function assetAccounts(type) {
  const t = ASSET_TYPES[type];
  return {
    cost: (await acct.accountByRole(t.cost)),
    accumulated: (await acct.accountByRole(t.accumulated)),
    expense: (await acct.accountByRole(t.expense)),
  };
}

const monthlyCharge = (a) => round2((a.acquisition_cost * a.depreciation_rate) / 100 / 12);

// Assets with entity, cost centre and booked depreciation in one query.
const ASSET_SELECT = `SELECT a.*, e.code AS entity_code, cc.name AS cost_center_name,
    COALESCE(d.booked, 0) AS booked, d.last_period
  FROM fixed_assets a
  JOIN entities e ON e.id = a.entity_id
  LEFT JOIN cost_centers cc ON cc.code = a.cost_center
  LEFT JOIN (SELECT asset_id, SUM(amount) AS booked, MAX(period) AS last_period FROM asset_depreciation GROUP BY asset_id) d ON d.asset_id = a.id`;

function decorate(row) {
  const { booked, last_period, ...a } = row;
  const accumulated = round2(a.opening_depreciation + booked);
  const book_value = round2(a.acquisition_cost - accumulated);
  const monthly = monthlyCharge(a);
  return {
    ...a,
    type_name: ASSET_TYPES[a.asset_type] ? ASSET_TYPES[a.asset_type].name : a.asset_type,
    useful_life_years: a.depreciation_rate > 0 ? round2(100 / a.depreciation_rate) : null,
    monthly_depreciation: book_value > 0 ? Math.min(monthly, book_value) : 0,
    accumulated_depreciation: accumulated,
    book_value,
    last_depreciated_period: last_period || null,
    status: book_value <= 0.005 ? 'Fully depreciated' : 'In use',
  };
}

async function listAssets(entityId) {
  const E = acct.entityOf(entityId);
  return (await db.all(`${ASSET_SELECT} WHERE (?::int IS NULL OR a.entity_id = ?) ORDER BY a.asset_number`, E, E)).map(decorate);
}

async function getAsset(id) {
  const a = await db.get(`${ASSET_SELECT} WHERE a.id = ?`, id);
  if (!a) return null;
  const asset = decorate(a);
  const history = (await db.all('SELECT d.period, d.amount, d.journal_id FROM asset_depreciation d WHERE d.asset_id = ? ORDER BY d.period', id));
  // Remaining schedule: month by month until the book value is written off.
  const schedule = [];
  let remaining = asset.book_value;
  let period = acct.nextPeriod(asset.last_depreciated_period || prevPeriod(asset.depreciation_start));
  const monthly = monthlyCharge(asset);
  while (remaining > 0.005 && monthly > 0 && schedule.length < 600) {
    const amount = round2(Math.min(monthly, remaining));
    remaining = round2(remaining - amount);
    schedule.push({ period, amount, book_value_after: remaining });
    period = acct.nextPeriod(period);
  }
  return { ...asset, accounts: (await assetAccounts(asset.asset_type)), history, schedule };
}

function prevPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

async function nextAssetNumber() {
  const last = (await db.get("SELECT asset_number FROM fixed_assets WHERE asset_number LIKE 'FA-%' ORDER BY asset_number DESC LIMIT 1"));
  const n = last ? Number(last.asset_number.slice(3)) + 1 : 1;
  return `FA-${String(n).padStart(4, '0')}`;
}

/**
 * Add an asset to the register.
 *   booking = 'journal':  post the purchase now, Dr investment ledger / Cr contra_account
 *                         (e.g. a bank account)
 *   booking = 'existing': register only - the cost is already on the investment
 *                         ledger (e.g. via a purchase invoice line or the opening balance)
 * opening_depreciation and depreciation_start are for assets taken over from
 * earlier books (depreciation already booked before this system).
 */
async function createAsset(data) {
  const entity = (await acct.requireEntity(data.entity_id));
  const name = String(data.name || '').trim();
  if (!name) throw httpError(400, 'Asset name is required');
  if (!ASSET_TYPES[data.asset_type]) throw httpError(400, 'Asset type must be machinery or inventory');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.acquisition_date || '')) throw httpError(400, 'Acquisition date is required');
  const cost = round2(Number(data.acquisition_cost));
  if (!(cost > 0)) throw httpError(400, 'Acquisition cost must be more than zero');
  const rate = Number(data.depreciation_rate);
  if (!(rate > 0 && rate <= 100)) throw httpError(400, 'Depreciation % per year must be between 0 and 100');
  if (data.cost_center && !(await db.get('SELECT 1 FROM cost_centers WHERE code = ?', data.cost_center))) {
    throw httpError(400, `Unknown cost centre ${data.cost_center}`);
  }
  const opening = round2(Number(data.opening_depreciation) || 0);
  if (opening < 0 || opening > cost) throw httpError(400, 'Opening depreciation must be between 0 and the cost');
  const start = data.depreciation_start || acct.periodOf(data.acquisition_date);
  const booking = data.booking || 'journal';

  return transaction(async () => {
    const assetNumber = data.asset_number || (await nextAssetNumber());
    if ((await db.get('SELECT 1 FROM fixed_assets WHERE asset_number = ?', assetNumber))) throw httpError(400, `Asset ${assetNumber} already exists`);
    (await acct.ensurePeriod(start));
    let journalId = null;
    if (booking === 'journal') {
      const contra = (await acct.getAccount(data.contra_account));
      if (!contra) throw httpError(400, 'Choose the account the purchase is paid from (e.g. a bank account)');
      const accounts = (await assetAccounts(data.asset_type));
      const desc = `Acquisition ${assetNumber} ${name}`;
      journalId = (await acct.postJournal({
        entity_id: entity.id,
        journal_date: data.acquisition_date,
        reference: assetNumber,
        description: desc,
        source_type: 'asset',
        lines: [
          { account_code: accounts.cost.code, debit: cost, description: desc },
          { account_code: contra.code, credit: cost, description: desc },
        ],
      }));
    } else if (booking !== 'existing') {
      throw httpError(400, 'Booking must be "journal" or "existing"');
    }
    const info = (await db.run(`INSERT INTO fixed_assets (asset_number, entity_id, name, description, asset_type, cost_center, acquisition_date, acquisition_cost, depreciation_rate, opening_depreciation, depreciation_start, acquisition_journal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, assetNumber, entity.id, name, data.description || null, data.asset_type, data.cost_center || null, data.acquisition_date, cost, rate, opening, start, journalId));
    return (await getAsset(Number(info.lastInsertRowid)));
  });
}

/** Depreciation already written off before a period (for assets taken over from earlier books). */
function depreciationBefore({ acquisition_date, acquisition_cost, depreciation_rate }, period) {
  const monthly = round2((acquisition_cost * depreciation_rate) / 100 / 12);
  let months = 0;
  for (let p = acct.periodOf(acquisition_date); p < period; p = acct.nextPeriod(p)) months++;
  return round2(Math.min(acquisition_cost, months * monthly));
}

/**
 * Post depreciation for one period for every asset that is due and not yet
 * depreciated for it. Safe to run more than once: already-booked assets are skipped.
 */
async function runDepreciation(period) {
  const p = (await acct.ensurePeriod(period));
  if (p.status === 'closed') throw httpError(400, `Period ${period} is closed`);
  const due = (await db.all(`${ASSET_SELECT}
       WHERE a.depreciation_start <= ?
         AND NOT EXISTS (SELECT 1 FROM asset_depreciation d WHERE d.asset_id = a.id AND d.period = ?)
       ORDER BY a.asset_number`, period, period))
    .map(decorate)
    .filter((a) => a.book_value > 0.005);
  if (due.length === 0) return { period, assets: 0, amount: 0, journal_ids: [] };

  return transaction(async () => {
    const insert = db.statement('INSERT INTO asset_depreciation (asset_id, period, amount, journal_id) VALUES (?, ?, ?, ?)');
    const journals = [];
    let count = 0;
    let total = 0;
    // One journal per entity, since each entity keeps its own books.
    for (const entityId of [...new Set(due.map((a) => a.entity_id))]) {
      const lines = [];
      const charges = [];
      for (const a of due.filter((x) => x.entity_id === entityId)) {
        const amount = round2(Math.min(monthlyCharge(a), a.book_value));
        if (amount <= 0) continue;
        const accounts = (await assetAccounts(a.asset_type));
        const desc = `Depreciation ${period} ${a.asset_number} ${a.name}`;
        lines.push({ account_code: accounts.expense.code, debit: amount, cost_center: a.cost_center, description: desc });
        lines.push({ account_code: accounts.accumulated.code, credit: amount, description: desc });
        charges.push({ asset_id: a.id, amount });
      }
      if (!charges.length) continue;
      const journalId = (await acct.postJournal({
        entity_id: entityId,
        journal_date: p.end_date,
        reference: `DEPR-${period}`,
        description: `Depreciation ${period}`,
        source_type: 'depreciation',
        lines,
      }));
      for (const c of charges) (await insert.run(c.asset_id, period, c.amount, journalId));
      journals.push(journalId);
      count += charges.length;
      total += charges.reduce((t, c) => t + c.amount, 0);
    }
    return { period, assets: count, amount: round2(total), journal_ids: journals };
  });
}

/**
 * Catch up depreciation for every month that has ended (up to and including
 * last month), skipping closed periods. This is what runs automatically.
 */
async function runDueDepreciation(today = new Date().toISOString().slice(0, 10)) {
  const lastComplete = prevPeriod(acct.periodOf(today));
  const first = (await db.get('SELECT MIN(depreciation_start) AS p FROM fixed_assets')).p;
  const results = [];
  if (!first) return results;
  for (let p = first; p <= lastComplete; p = acct.nextPeriod(p)) {
    const period = (await acct.ensurePeriod(p));
    if (period.status === 'closed') continue;
    const r = (await runDepreciation(p));
    if (r.assets > 0) results.push(r);
  }
  return results;
}

function getStatus() {
  return { ...status, runs_every_hours: 6 };
}

/** Check on start-up and every 6 hours, so a month is depreciated as soon as it has ended. */
function startScheduler() {
  const run = async () => {
    status.last_run = new Date().toISOString();
    try {
      const results = (await runDueDepreciation());
      status.last_result = results;
      status.last_error = null;
      if (results.length) console.log(`Depreciation posted for ${results.map((r) => r.period).join(', ')}`);
    } catch (err) {
      status.last_error = err.message;
      console.error('Depreciation run failed:', err.message);
    }
  };
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

/** Close a period: book its depreciation first (if the month has ended or is current), then lock it. */
async function closePeriod(period) {
  const current = acct.periodOf(new Date().toISOString().slice(0, 10));
  if (period <= current) (await runDepreciation(period));
  return (await acct.setPeriodStatus(period, 'closed'));
}

module.exports = {
  ASSET_TYPES,
  listAssets,
  getAsset,
  createAsset,
  depreciationBefore,
  runDepreciation,
  runDueDepreciation,
  getStatus,
  startScheduler,
  closePeriod,
};
