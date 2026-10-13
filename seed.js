'use strict';

const { db, transaction } = require('./db');
const acct = require('./accounting');
const assets = require('./assets');

const { ROLES } = acct;

// ----- The group (see "Companies structure" deck): nine companies in four groups -----
// `code` is the key used inside this file, `x` the code shown in the app (X1-X9 as on the deck).
// "labels" rename reporting categories in that company's statements, "hide" leaves empty
// categories out of them. Ownership is set after all companies exist.
const HOLDING_LABELS = { revenue: 'Management fee income', overheads: 'Holding company costs', financial_income: 'Interest & dividends received', fixed_assets: 'Investments in subsidiaries', financial_assets: 'Loans to group companies' };
const GAMBLING_LABELS = { revenue: 'Gaming revenue', cost_of_sales: 'Cost of gaming operations', overheads: 'Marketing & administrative expenses' };
const ENTITIES = [
  {
    code: 'SPARK', vat_number: 'CY10203040A', x: 'X1', name: 'Sparkworks Holding Limited', entity_type: 'holding', country: 'Cyprus', framework: 'IFRS', main_currency: 'EUR', year_end_month: 12,
    labels: HOLDING_LABELS, hide: ['cost_of_sales', 'depreciation'],
  },
  {
    code: 'NBU', x: 'X2', name: 'JMS Investment Group N.V', entity_type: 'gambling', country: 'Curacao', framework: 'IFRS', main_currency: 'EUR', year_end_month: 12,
    parent: 'SPARK', pct: 80, labels: GAMBLING_LABELS, hide: ['depreciation'],
  },
  {
    code: 'NBP', vat_number: 'GB333444555', x: 'X3', name: 'SC Technology Limited', entity_type: 'tech_services', country: 'United Kingdom', framework: 'UK GAAP (FRS 102)', main_currency: 'GBP', year_end_month: 5,
    labels: { revenue: 'Technology service fees', cost_of_sales: 'Direct delivery costs', overheads: 'Operating expenses' }, hide: ['depreciation'],
  },
  {
    code: 'NACS', vat_number: 'GB555777999', x: 'X4', name: 'NACS Technology Limited', entity_type: 'admin_services', country: 'United Kingdom', framework: 'UK GAAP (FRS 102)', main_currency: 'GBP', year_end_month: 5,
    labels: { revenue: 'Administration service fees', cost_of_sales: 'Cost of services', overheads: 'Staff & office costs' }, hide: ['depreciation'],
  },
  {
    code: 'VOX', vat_number: 'CY10506070B', x: 'X5', name: 'Voxivibe Holding Limited', entity_type: 'holding', country: 'Cyprus', framework: 'IFRS', main_currency: 'EUR', year_end_month: 12,
    labels: HOLDING_LABELS, hide: ['cost_of_sales', 'depreciation'],
  },
  {
    code: 'NBM', x: 'X6', name: 'Luminect Limited B.V.', entity_type: 'gambling', country: 'Curacao', framework: 'IFRS', main_currency: 'EUR', year_end_month: 12,
    parent: 'VOX', pct: 100, labels: GAMBLING_LABELS, hide: ['depreciation'],
  },
  {
    code: 'NBH', vat_number: 'MT87654321', x: 'X7', name: 'STech Technology Holding (CY) Limited', entity_type: 'holding', country: 'Malta', framework: 'IFRS', main_currency: 'EUR', year_end_month: 12,
    labels: HOLDING_LABELS, hide: ['cost_of_sales', 'depreciation'],
  },
  {
    code: 'NBT', vat_number: 'GB444555666', x: 'X8', name: 'STech Technology UK Ltd', entity_type: 'gambling', country: 'United Kingdom', framework: 'UK GAAP (FRS 102)', main_currency: 'GBP', year_end_month: 8,
    parent: 'NBH', pct: 100, labels: GAMBLING_LABELS, hide: [],
  },
  {
    code: 'NBS', vat_number: 'MT12345678', x: 'X9', name: 'STech European Entertainment Limited', entity_type: 'services', country: 'Malta', framework: 'IFRS', main_currency: 'EUR', year_end_month: 12,
    parent: 'NBH', pct: 100, labels: { revenue: 'Service fees from group companies', cost_of_sales: 'Direct service costs', overheads: 'Operating expenses' }, hide: ['depreciation', 'inventory'],
  },
];
const ENTITY_NAME = Object.fromEntries(ENTITIES.map((e) => [e.code, e.name]));

// A code in `entity` restricts the account to that company: it is that company's own
// chart of accounts on top of the shared one.
const ACCOUNTS = [
  { code: '0200', name: 'Machinery - investment', category: 'fixed_assets', role: ROLES.MACHINERY_COST },
  { code: '0210', name: 'Machinery - accumulated depreciation', category: 'accumulated_depreciation', role: ROLES.MACHINERY_ACCUM },
  { code: '0300', name: 'Inventory - investment', category: 'fixed_assets', role: ROLES.INVENTORY_COST },
  { code: '0310', name: 'Inventory - accumulated depreciation', category: 'accumulated_depreciation', role: ROLES.INVENTORY_ACCUM },
  { code: '0500', name: 'Investment in subsidiaries', category: 'fixed_assets' },
  { code: '0600', name: 'Investment property', category: 'fixed_assets', entity: 'NBP' },
  { code: '1000', name: 'Bank - GBP (X8 STech UK)', category: 'cash', bank_currency: 'GBP', iban: 'GB29NWBK60161331926819', entity: 'NBT' },
  { code: '1010', name: 'Bank - EUR (X8 STech UK)', category: 'cash', bank_currency: 'EUR', iban: 'DE89370400440532013000', entity: 'NBT' },
  { code: '1020', name: 'Bank - USD (X8 STech UK)', category: 'cash', bank_currency: 'USD', iban: 'GB33BUKB20201555555555', entity: 'NBT' },
  { code: '1050', name: 'Bank - GBP (X7 Holding)', category: 'cash', bank_currency: 'GBP', iban: 'GB82WEST12345698765432', entity: 'NBH' },
  { code: '1060', name: 'Bank - EUR (X6 Luminect)', category: 'cash', bank_currency: 'EUR', iban: 'DE44500105175407324931', entity: 'NBM' },
  { code: '1061', name: 'Bank - GBP (X6 Luminect)', category: 'cash', bank_currency: 'GBP', iban: 'DE02120300000000202051', entity: 'NBM' },
  { code: '1070', name: 'Bank - GBP (X9 STech European)', category: 'cash', bank_currency: 'GBP', iban: 'GB15MIDL40051512345674', entity: 'NBS' },
  { code: '1080', name: 'Bank - GBP (X3 SC Technology)', category: 'cash', bank_currency: 'GBP', iban: 'GB94BARC10201530093459', entity: 'NBP' },
  { code: '1090', name: 'Bank - USD (X2 JMS)', category: 'cash', bank_currency: 'USD', iban: 'GB88NWBK60161331926801', entity: 'NBU' },
  { code: '1100', name: 'Accounts receivable', category: 'receivables', role: ROLES.AR },
  { code: '1200', name: 'VAT recoverable (input VAT)', category: 'other_current_assets', role: ROLES.VAT_IN },
  { code: '1300', name: 'Prepayments', category: 'other_current_assets' },
  { code: '1400', name: 'Intercompany loans receivable', category: 'financial_assets', entity: 'NBH' },
  { code: '1410', name: 'Intercompany interest receivable', category: 'other_current_assets', entity: 'NBH' },
  { code: '1500', name: 'Raw materials', category: 'inventory', entity: 'NBM' },
  { code: '1510', name: 'Work in progress', category: 'inventory', entity: 'NBM' },
  { code: '1520', name: 'Finished goods & merchandise', category: 'inventory' },
  { code: '2100', name: 'Accounts payable', category: 'payables', role: ROLES.AP },
  { code: '2200', name: 'VAT payable (output VAT)', category: 'other_current_liabilities', role: ROLES.VAT_OUT },
  { code: '2300', name: 'Accruals', category: 'other_current_liabilities' },
  { code: '2450', name: 'Intercompany loans payable', category: 'long_term_liabilities' },
  { code: '2460', name: 'Intercompany interest payable', category: 'other_current_liabilities' },
  { code: '2500', name: 'Mortgage loan', category: 'long_term_liabilities', entity: 'NBP' },
  { code: '3000', name: 'Share capital', category: 'equity' },
  { code: '3100', name: 'Retained earnings', category: 'equity' },
  { code: '4000', name: 'Sales - products', category: 'revenue' },
  { code: '4100', name: 'Sales - services', category: 'revenue' },
  { code: '4200', name: 'Management fees charged', category: 'revenue' },
  { code: '4500', name: 'Rental income', category: 'revenue', entity: 'NBP' },
  { code: '5000', name: 'Purchases - materials & components', category: 'cost_of_sales' },
  { code: '5100', name: 'Freight & packaging', category: 'cost_of_sales' },
  { code: '5200', name: 'Production labour', category: 'cost_of_sales', entity: 'NBM' },
  { code: '5300', name: 'Factory overheads & energy', category: 'cost_of_sales', entity: 'NBM' },
  { code: '5500', name: 'Property maintenance & repairs', category: 'cost_of_sales', entity: 'NBP' },
  { code: '5600', name: 'Property insurance & rates', category: 'cost_of_sales', entity: 'NBP' },
  { code: '6000', name: 'Rent & premises', category: 'overheads' },
  { code: '6100', name: 'Salaries & wages', category: 'overheads' },
  { code: '6150', name: 'Software & licences', category: 'overheads', entity: 'NBS' },
  { code: '6200', name: 'Office & facilities', category: 'overheads' },
  { code: '6300', name: 'Professional fees', category: 'overheads' },
  { code: '6400', name: 'Management fees (group)', category: 'overheads' },
  { code: '6410', name: 'Shared services charges (group)', category: 'overheads' },
  { code: '6500', name: 'Depreciation - machinery', category: 'depreciation', role: ROLES.MACHINERY_DEPR },
  { code: '6510', name: 'Depreciation - inventory', category: 'depreciation', role: ROLES.INVENTORY_DEPR },
  { code: '6700', name: 'Sales commissions', category: 'overheads', entity: 'NBU' },
  { code: '6710', name: 'Payroll taxes & benefits', category: 'overheads', entity: 'NBU' },
  { code: '7000', name: 'Realised FX gain', category: 'financial_income', role: ROLES.FX_GAIN },
  { code: '7100', name: 'Realised FX loss', category: 'financial_expenses', role: ROLES.FX_LOSS },
  { code: '7200', name: 'Bank charges', category: 'financial_expenses' },
  { code: '7300', name: 'Interest income', category: 'financial_income' },
  { code: '7400', name: 'Interest expense', category: 'financial_expenses' },
  { code: '7600', name: 'Mortgage interest', category: 'financial_expenses', entity: 'NBP' },
];

const COST_CENTERS = [
  { code: '100', name: 'Sales & Marketing' },
  { code: '200', name: 'Operations & Warehouse' },
  { code: '300', name: 'Finance & Administration' },
  { code: '400', name: 'IT' },
];

// First day of these books; assets bought earlier are brought in with the
// depreciation already written off up to then.
const BOOKS_START = '2026-06-01';

// Assets owned before the books started (in the opening balance).
const OPENING_ASSETS = [
  { name: 'CNC milling machine', description: '3-axis vertical machining centre, workshop bay 1', asset_type: 'machinery', cost_center: '200', acquisition_date: '2023-03-15', acquisition_cost: 68000, depreciation_rate: 10 },
  { name: 'Forklift truck 2.5t', description: 'LPG counterbalance forklift', asset_type: 'machinery', cost_center: '200', acquisition_date: '2024-01-10', acquisition_cost: 24500, depreciation_rate: 20 },
  { name: 'Pallet racking system - warehouse A', description: 'Selective racking, 480 pallet positions', asset_type: 'machinery', cost_center: '200', acquisition_date: '2016-02-01', acquisition_cost: 36000, depreciation_rate: 10 },
  { name: 'Shrink-wrap packaging line', description: 'Semi-automatic L-sealer and shrink tunnel', asset_type: 'machinery', cost_center: '200', acquisition_date: '2025-04-01', acquisition_cost: 18750, depreciation_rate: 20 },
  { name: 'Industrial air compressor', description: 'Rotary screw compressor, 15 kW', asset_type: 'machinery', cost_center: '200', acquisition_date: '2024-06-20', acquisition_cost: 7800, depreciation_rate: 20 },
  { name: 'Office furniture HQ', description: 'Desks, chairs and storage for 20 workplaces', asset_type: 'inventory', cost_center: '300', acquisition_date: '2023-05-01', acquisition_cost: 12400, depreciation_rate: 20 },
  { name: 'Laptops (12)', description: 'Staff laptops, 2025 refresh', asset_type: 'inventory', cost_center: '400', acquisition_date: '2025-01-15', acquisition_cost: 14400, depreciation_rate: 25 },
  { name: 'Server & network equipment', description: 'On-site server, switches and Wi-Fi access points', asset_type: 'inventory', cost_center: '400', acquisition_date: '2024-03-01', acquisition_cost: 9600, depreciation_rate: 20 },
  { name: 'Showroom fixtures & displays', description: 'Display stands and lighting, trade counter', asset_type: 'inventory', cost_center: '100', acquisition_date: '2024-09-01', acquisition_cost: 8200, depreciation_rate: 20 },
  { name: 'Meeting room AV equipment', description: 'Screen, camera and speaker system', asset_type: 'inventory', cost_center: '300', acquisition_date: '2025-10-01', acquisition_cost: 5300, depreciation_rate: 20 },
];

// Assets of the German manufacturing company.
const MANUFACTURING_ASSETS = [
  { name: 'CNC machining centre 5-axis', description: 'Main production machine, hall 1', asset_type: 'machinery', cost_center: '200', acquisition_date: '2024-02-01', acquisition_cost: 180000, depreciation_rate: 10 },
  { name: 'Injection moulding line', description: 'Two-cavity line with robot take-out', asset_type: 'machinery', cost_center: '200', acquisition_date: '2025-03-01', acquisition_cost: 120000, depreciation_rate: 12.5 },
  { name: 'Factory racking & forklifts', description: 'Raw material and finished goods storage', asset_type: 'machinery', cost_center: '200', acquisition_date: '2023-09-01', acquisition_cost: 35000, depreciation_rate: 10 },
  { name: 'Office & IT equipment', description: 'Planning office workstations and ERP server', asset_type: 'inventory', cost_center: '300', acquisition_date: '2025-02-01', acquisition_cost: 12000, depreciation_rate: 25 },
];

async function seedIfEmpty() {
  const existing = (await db.get('SELECT COUNT(*) AS c FROM company')).c;
  if (existing > 0) return; // already seeded
  await transaction(async () => {
    // Several function instances can start at once: one seeds, the others wait and then see the data.
    await db.lock(424242);
    if ((await db.get('SELECT COUNT(*) AS c FROM company')).c > 0) return;
    await seed();
  });
}

async function seed() {
  (await db.run('INSERT INTO company (id, name, base_currency) VALUES (1, ?, ?)', 'SC Technology', 'GBP'));

  // ----- The six companies and who owns whom -----
  const E = {};
  for (const e of ENTITIES) {
    E[e.code] = (await acct.createEntity({
      vat_number: e.vat_number || null,
      code: e.x, name: e.name, entity_type: e.entity_type, country: e.country, framework: e.framework, main_currency: e.main_currency, year_end_month: e.year_end_month, labels: e.labels, hide: e.hide,
    })).id;
  }
  for (const e of ENTITIES) {
    if (e.parent) (await acct.updateEntity(E[e.code], { parent_id: E[e.parent], ownership_pct: e.pct }));
  }
  // A consolidated entity for each holding company's group: it adds up the group's companies and
  // is where the intercompany eliminations are booked (journals, to be defined).
  for (const code of ['NBH', 'VOX', 'SPARK']) {
    const h = ENTITIES.find((e) => e.code === code);
    (await acct.createEntity({
      code: `${h.x}-CONS`, name: `${h.name} - Consolidated`, entity_type: 'consolidation', consolidation_of: E[code],
      country: h.country, framework: h.framework, main_currency: h.main_currency, year_end_month: h.year_end_month,
      labels: h.labels, hide: h.hide,
    }));
  }
  const T = E.NBT;
  const H = E.NBH;

  (await acct.ensurePeriods('2026-01', '2026-12'));
  for (const a of ACCOUNTS) (await acct.createAccount({ ...a, entity_id: a.entity ? E[a.entity] : null }));
  for (const c of COST_CENTERS) (await acct.createCostCenter(c));

  // ----- Suppliers and customers: outside parties, and every group company (intercompany) -----
  const supplier = {};
  for (const s of [
    { name: 'Fenwick & Doyle Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB123456789', sort_code: '20-00-00', account_number: '55779911' },
    { name: 'Rheinmetall Bauteile GmbH', country: 'Germany', currency: 'EUR', vat_number: 'DE987654321', iban: 'DE75512108001245126199', bic: 'SOGEDEFFXXX' },
    { name: 'Atlas Fasteners Inc.', country: 'United States', currency: 'USD', vat_number: null, iban: 'GB94BARC10201530093459', bic: 'BARCGB22' },
    { name: 'Lumiere Packaging SARL', country: 'France', currency: 'EUR', vat_number: 'FR445566778', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' },
    { name: 'Canary Property Management Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB555666777', sort_code: '40-11-60', account_number: '31926819' },
    { name: 'Brightcut Laser Systems Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB777888999', sort_code: '30-94-57', account_number: '10442786' },
    { name: 'Cloudwave Software Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB246813579', sort_code: '23-14-72', account_number: '70123456' },
  ]) {
    supplier[s.name] = (await acct.createParty('supplier', s)).id;
  }

  const customer = {};
  for (const c of [
    { name: 'Harlow Retail Group Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB998877665' },
    { name: 'Van Dijk Distributie B.V.', country: 'Netherlands', currency: 'EUR', vat_number: 'NL123456789B01' },
    { name: 'Bayside Imports LLC', country: 'United States', currency: 'USD', vat_number: null },
  ]) {
    customer[c.name] = (await acct.createParty('customer', c)).id;
  }

  // Every group company is both a supplier and a customer of the others. Invoices to or from
  // these are intercompany: their postings carry the other company as counterparty.
  const GROUP_PARTY = {
    NBT: { country: 'United Kingdom', currency: 'GBP', vat_number: 'GB444555666', sort_code: '20-45-45', account_number: '40123456' },
    NBH: { country: 'Malta', currency: 'EUR', vat_number: 'MT87654321', iban: 'MT31MALT011000000000MTLCAST001S', bic: 'MALTMTMT' },
    NBM: { country: 'Curacao', currency: 'EUR', vat_number: null, iban: 'DE44500105175407324931', bic: 'INGDDEFFXXX' },
    NBS: { country: 'Malta', currency: 'EUR', vat_number: 'MT12345678', iban: 'MT84MALT011000012345MTLCAST001S', bic: 'MALTMTMT' },
    NBP: { country: 'United Kingdom', currency: 'GBP', vat_number: 'GB333444555', sort_code: '40-05-30', account_number: '55667788' },
    NBU: { country: 'Curacao', currency: 'EUR', vat_number: null, iban: 'GB88NWBK60161331926801', bic: 'NWBKGB2L' },
    SPARK: { country: 'Cyprus', currency: 'EUR', vat_number: 'CY10203040A', iban: 'CY17002001280000001200527600', bic: 'BCYPCY2N' },
    VOX: { country: 'Cyprus', currency: 'EUR', vat_number: 'CY10506070B', iban: 'CY21002001950000357001234567', bic: 'BCYPCY2N' },
    NACS: { country: 'United Kingdom', currency: 'GBP', vat_number: 'GB555777999', sort_code: '20-10-30', account_number: '77889900' },
  };
  const groupSupplier = {};
  const groupCustomer = {};
  for (const e of ENTITIES) {
    const p = { name: e.name, group_entity_id: E[e.code], ...GROUP_PARTY[e.code] };
    groupSupplier[e.code] = (await acct.createParty('supplier', p)).id;
    groupCustomer[e.code] = (await acct.createParty('customer', p)).id;
  }

  // ----- Opening balances -----
  // STech Technology UK (X8): bank accounts, share capital (held by X7) and the assets taken over.
  const sumAssets = (list, type, key) => list.filter((a) => a.asset_type === type).reduce((t, a) => t + a[key], 0);
  const withOpening = (list) => list.map((a) => ({ ...a, opening_depreciation: assets.depreciationBefore(a, '2026-06') }));
  const opening = withOpening(OPENING_ASSETS);
  const nbv = opening.reduce((t, a) => t + a.acquisition_cost - a.opening_depreciation, 0);
  (await acct.postJournal({
    entity_id: T,
    journal_date: BOOKS_START,
    reference: 'OPEN',
    description: 'Opening balances',
    source_type: 'opening',
    lines: [
      { account_code: '1000', debit: 109250, currency: 'GBP' },
      { account_code: '1010', debit: 21250, currency: 'EUR', fx_note: '25000.00 EUR @ 0.85' },
      { account_code: '1020', debit: 19500, currency: 'USD', fx_note: '25000.00 USD @ 0.78' },
      { account_code: '0200', debit: sumAssets(opening, 'machinery', 'acquisition_cost') },
      { account_code: '0210', credit: sumAssets(opening, 'machinery', 'opening_depreciation') },
      { account_code: '0300', debit: sumAssets(opening, 'inventory', 'acquisition_cost') },
      { account_code: '0310', credit: sumAssets(opening, 'inventory', 'opening_depreciation') },
      { account_code: '3000', credit: 150000, counterparty_entity_id: H, description: 'Share capital held by STech Technology Holding (CY) Limited' },
      { account_code: '3100', credit: nbv, description: 'Retained earnings from prior years' },
    ],
  }));
  for (const a of opening) (await assets.createAsset({ ...a, entity_id: T, booking: 'existing', depreciation_start: '2026-06' }));

  // The holding companies own the shares of their subsidiaries (X7 -> X8, X9; X5 -> X6; X1 -> X2)
  // and are financed by their own shareholders. X3 and X4 are independent companies.
  const holdingOpening = async (holder, bank, investments, capital) =>
    acct.postJournal({
      entity_id: E[holder],
      journal_date: BOOKS_START,
      reference: 'OPEN',
      description: 'Opening balances',
      source_type: 'opening',
      lines: [
        ...Object.entries(investments).map(([code, amount]) => ({
          account_code: '0500', debit: amount, counterparty_entity_id: E[code], description: `Shares in ${ENTITY_NAME[code]}`,
        })),
        ...(bank ? [{ account_code: bank.code, debit: bank.amount }] : []),
        { account_code: '3000', credit: capital, description: 'Share capital held by the shareholders' },
      ],
    });
  (await holdingOpening('NBH', { code: '1050', amount: 620000 }, { NBT: 150000, NBS: 50000 }, 820000));
  (await holdingOpening('VOX', null, { NBM: 200000 }, 200000));
  (await holdingOpening('SPARK', null, { NBU: 80000 }, 80000));

  // Manufacturing (Germany): EUR and GBP bank accounts, stock, machinery.
  const nbmAssets = withOpening(MANUFACTURING_ASSETS);
  const nbmDebits = {
    '1060': 51000,
    '1061': 20000,
    '1500': 40000,
    '1520': 35000,
    '0200': sumAssets(nbmAssets, 'machinery', 'acquisition_cost'),
    '0300': sumAssets(nbmAssets, 'inventory', 'acquisition_cost'),
  };
  const nbmAccum = { '0210': sumAssets(nbmAssets, 'machinery', 'opening_depreciation'), '0310': sumAssets(nbmAssets, 'inventory', 'opening_depreciation') };
  const nbmCapital = 200000;
  const nbmRetained = Object.values(nbmDebits).reduce((t, v) => t + v, 0) - Object.values(nbmAccum).reduce((t, v) => t + v, 0) - nbmCapital;
  (await acct.postJournal({
    entity_id: E.NBM,
    journal_date: BOOKS_START,
    reference: 'OPEN',
    description: 'Opening balances',
    source_type: 'opening',
    lines: [
      { account_code: '1060', debit: nbmDebits['1060'], currency: 'EUR', fx_note: '60000.00 EUR @ 0.85' },
      { account_code: '1061', debit: nbmDebits['1061'], currency: 'GBP' },
      { account_code: '1500', debit: nbmDebits['1500'] },
      { account_code: '1520', debit: nbmDebits['1520'] },
      { account_code: '0200', debit: nbmDebits['0200'] },
      { account_code: '0210', credit: nbmAccum['0210'] },
      { account_code: '0300', debit: nbmDebits['0300'] },
      { account_code: '0310', credit: nbmAccum['0310'] },
      { account_code: '3000', credit: nbmCapital, counterparty_entity_id: E.VOX, description: 'Share capital held by Voxivibe Holding Limited' },
      { account_code: '3100', credit: nbmRetained, description: 'Retained earnings from prior years' },
    ],
  }));
  for (const a of nbmAssets) (await assets.createAsset({ ...a, entity_id: E.NBM, booking: 'existing', depreciation_start: '2026-06' }));

  // Shared services: little capital, a small accumulated loss.
  (await acct.postJournal({
    entity_id: E.NBS,
    journal_date: BOOKS_START,
    reference: 'OPEN',
    description: 'Opening balances',
    source_type: 'opening',
    lines: [
      { account_code: '1070', debit: 45000 },
      { account_code: '3100', debit: 5000, description: 'Accumulated loss brought forward' },
      { account_code: '3000', credit: 50000, counterparty_entity_id: H, description: 'Share capital held by STech Technology Holding (CY) Limited' },
    ],
  }));

  // Properties: investment property financed by a mortgage and equity.
  (await acct.postJournal({
    entity_id: E.NBP,
    journal_date: BOOKS_START,
    reference: 'OPEN',
    description: 'Opening balances',
    source_type: 'opening',
    lines: [
      { account_code: '1080', debit: 90000 },
      { account_code: '0600', debit: 1200000 },
      { account_code: '2500', credit: 500000, description: 'Mortgage loan (external bank)' },
      { account_code: '3000', credit: 300000, description: 'Share capital held by its own shareholders' },
      { account_code: '3100', credit: 490000, description: 'Retained earnings from prior years' },
    ],
  }));

  // US distribution company: 80% held by Holding, 20% by outside shareholders.
  (await acct.postJournal({
    entity_id: E.NBU,
    journal_date: BOOKS_START,
    reference: 'OPEN',
    description: 'Opening balances',
    source_type: 'opening',
    lines: [
      { account_code: '1090', debit: 46800, currency: 'USD', fx_note: '60000.00 USD @ 0.78' },
      { account_code: '1520', debit: 30000 },
      { account_code: '3100', debit: 23200, description: 'Accumulated loss brought forward' },
      { account_code: '3000', credit: 80000, counterparty_entity_id: E.SPARK, description: 'Share capital held by Sparkworks Holding Limited (80%)' },
      { account_code: '3000', credit: 20000, description: 'Share capital held by minority shareholders (20%)' },
    ],
  }));

  // Bought during the year and paid straight from the bank: posted by the asset register itself.
  (await assets.createAsset({
    entity_id: T,
    name: 'Warehouse shelving & scanners',
    description: 'Long-span shelving and 6 handheld barcode scanners',
    asset_type: 'inventory',
    cost_center: '200',
    acquisition_date: '2026-06-05',
    acquisition_cost: 8000,
    depreciation_rate: 20,
    booking: 'journal',
    contra_account: '1000',
  }));

  // ----- Helpers -----
  const journal = async (journal_date, reference, description, lines, entity_id = T) =>
    (await acct.createManualJournal({ entity_id, journal_date, reference, description, currency: 'GBP', exchange_rate: 1, lines }));
  const journalIn = async (entity_id, currency, exchange_rate, journal_date, reference, description, lines) =>
    (await acct.createManualJournal({ entity_id, journal_date, reference, description, currency, exchange_rate, lines }));
  const inv = async (type, party, invoice_number, invoice_date, currency, exchange_rate, lines, notes, entity_id = T) =>
    (await acct.createInvoice({ entity_id, type, party_id: party, invoice_number, invoice_date, currency, exchange_rate, lines, notes }));
  const pay = async (invoice, payment_date, amount, bank_account, bank_amount, bank_rate, notes) =>
    (await acct.createPayment({ invoice_id: invoice.id, payment_date, amount, bank_account, bank_amount, bank_rate, notes }));

  /**
   * An intercompany invoice: a sales invoice in the selling company and the mirror purchase
   * invoice in the buying company. Options make the two sides differ on purpose (a missing
   * side, another rate or amount, another booking date) so the reconciliation has exceptions.
   *   lines:     [{ description, sell: revenue account, buy: cost/asset account, net, buy_cc }]
   *   buyerNets: amounts the buyer booked when they differ from the seller's
   *   settle:    { date, seller: [bank, bank_amount, rate], buyer: [bank, bank_amount, rate] }
   */
  const crossCharge = async ({ seller, buyer, number, date, currency = 'GBP', rate = 1, vat = 0, lines, buyerNets, buyerDate, buyerRate, only, notes = 'Intercompany', settle }) => {
    let sale = null;
    let purchase = null;
    if (only !== 'buyer') {
      sale = await inv('sale', groupCustomer[buyer], number, date, currency, rate, lines.map((l) => ({
        description: l.description, account_code: l.sell, cost_center: l.sell_cc || null, net_amount: l.net, vat_rate: vat,
      })), notes, E[seller]);
    }
    if (only !== 'seller') {
      purchase = await inv('purchase', groupSupplier[seller], number, buyerDate || date, currency, buyerRate || rate, lines.map((l, i) => ({
        description: l.description, account_code: l.buy, cost_center: l.buy_cc || null, net_amount: buyerNets ? buyerNets[i] : l.net, vat_rate: vat,
      })), notes, E[buyer]);
    }
    if (settle) {
      if (sale) (await pay(sale, settle.date, sale.total_amount, settle.seller[0], settle.seller[1] ?? sale.total_amount, settle.seller[2] ?? 1, 'Intercompany settlement'));
      if (purchase) (await pay(purchase, settle.date, purchase.total_amount, settle.buyer[0], settle.buyer[1] ?? purchase.total_amount, settle.buyer[2] ?? 1, 'Intercompany settlement'));
    }
    return { sale, purchase };
  };

  // ----- Northbridge Trading: its own accounting -----
  for (const [date, month] of [['2026-06-28', 'June'], ['2026-07-28', 'July'], ['2026-08-28', 'August']]) {
    (await journal(date, `PAY-${month.slice(0, 3).toUpperCase()}`, `Salaries ${month} 2026`, [
      { account_code: '6100', debit: 2000, cost_center: '100' },
      { account_code: '6100', debit: 2500, cost_center: '200' },
      { account_code: '6100', debit: 1500, cost_center: '300' },
      { account_code: '6100', debit: 500, cost_center: '400' },
      { account_code: '1000', credit: 6500 },
    ]));
  }
  (await journal('2026-08-31', 'ACC-AUG', 'Accrued audit fee', [
    { account_code: '6300', debit: 1200, cost_center: '300' },
    { account_code: '2300', credit: 1200 },
  ]));

  // ----- Purchase invoices (outside suppliers) -----
  const p1 = (await inv('purchase', supplier['Fenwick & Doyle Ltd'], 'FD-1001', '2026-06-02', 'GBP', 1, [
    { description: 'Office fit-out materials', account_code: '6200', cost_center: '300', net_amount: 3200, vat_rate: 20 },
    { description: 'Installation labour', account_code: '6200', cost_center: '300', net_amount: 1000, vat_rate: 20 },
  ], 'Office fit-out.'));
  (await pay(p1, '2026-06-20', 5040, '1000', 5040, 1, 'Paid in full by bank transfer.'));

  // EUR invoice paid from the EUR account after EUR weakened (0.855 -> 0.848): FX gain.
  const p2 = (await inv('purchase', supplier['Rheinmetall Bauteile GmbH'], 'RB-2201', '2026-06-10', 'EUR', 0.855, [
    { description: 'Precision components, batch 7', account_code: '5000', cost_center: '200', net_amount: 11200, vat_rate: 0 },
    { description: 'Freight', account_code: '5100', cost_center: '200', net_amount: 800, vat_rate: 0 },
  ], 'Reverse-charge cross-border purchase.'));
  (await pay(p2, '2026-07-05', 12000, '1010', 12000, 0.848, 'Paid in full via EUR account.'));

  // USD invoice partly paid from the USD account after USD strengthened (0.79 -> 0.805): FX loss.
  const p3 = (await inv('purchase', supplier['Atlas Fasteners Inc.'], 'AF-7781', '2026-06-15', 'USD', 0.79, [
    { description: 'Fasteners and brackets', account_code: '5000', cost_center: '200', net_amount: 9000, vat_rate: 0 },
  ], 'Balance of 4,000 USD still open.'));
  (await pay(p3, '2026-07-10', 5000, '1020', 5000, 0.805, 'First instalment.'));

  (await inv('purchase', supplier['Lumiere Packaging SARL'], 'LP-3390', '2026-07-01', 'EUR', 0.86, [
    { description: 'Retail packaging, Q3 run', account_code: '5100', cost_center: '200', net_amount: 3500, vat_rate: 0 },
  ]));

  const p5 = (await inv('purchase', supplier['Canary Property Management Ltd'], 'CPM-Q3-26', '2026-07-01', 'GBP', 1, [
    { description: 'Warehouse rent Q3 2026', account_code: '6000', cost_center: '200', net_amount: 6000, vat_rate: 20 },
    { description: 'Office rent Q3 2026', account_code: '6000', cost_center: '300', net_amount: 1500, vat_rate: 20 },
    { description: 'Service charge Q3 2026', account_code: '6000', cost_center: '300', net_amount: 600, vat_rate: 20 },
  ]));
  (await pay(p5, '2026-07-03', 9720, '1000', 9720, 1, 'Quarterly rent.'));

  // Machine bought on a purchase invoice (line on the investment ledger), then added to the register.
  const p6 = (await inv('purchase', supplier['Brightcut Laser Systems Ltd'], 'BLS-2026-118', '2026-07-14', 'GBP', 1, [
    { description: 'Fibre laser cutting machine 3 kW', account_code: '0200', net_amount: 42000, vat_rate: 20 },
  ]));
  (await pay(p6, '2026-07-31', 50400, '1000', 50400, 1, 'Paid on delivery.'));
  (await assets.createAsset({
    entity_id: T,
    name: 'Fibre laser cutter 3 kW',
    description: 'Sheet metal laser cutter, bought on invoice BLS-2026-118',
    asset_type: 'machinery',
    cost_center: '200',
    acquisition_date: '2026-07-14',
    acquisition_cost: 42000,
    depreciation_rate: 12.5,
    booking: 'existing',
  }));

  // 1,000 USD invoice booked at 800 GBP, paid from the GBP account costing 750 GBP: 50 GBP FX gain.
  const p7 = (await inv('purchase', supplier['Atlas Fasteners Inc.'], 'AF-7799', '2026-07-20', 'USD', 0.8, [
    { description: 'Follow-on fasteners order', account_code: '5000', cost_center: '200', net_amount: 1000, vat_rate: 0 },
  ]));
  (await pay(p7, '2026-08-01', 1000, '1000', 750, 1, 'Paid from GBP account - bank converted 1,000 USD for 750 GBP.'));

  (await inv('purchase', supplier['Fenwick & Doyle Ltd'], 'FD-1050', '2026-08-04', 'GBP', 1, [
    { description: 'Signage', account_code: '6200', cost_center: '100', net_amount: 1100, vat_rate: 20 },
    { description: 'Internal partitions', account_code: '6200', cost_center: '300', net_amount: 700, vat_rate: 20 },
  ]));

  // ----- Sales invoices (outside customers) -----
  const s1 = (await inv('sale', customer['Harlow Retail Group Ltd'], 'NB-S-001', '2026-06-12', 'GBP', 1, [
    { description: 'Storage systems', account_code: '4000', cost_center: '100', net_amount: 12000, vat_rate: 20 },
    { description: 'Installation', account_code: '4100', cost_center: '200', net_amount: 1500, vat_rate: 20 },
  ]));
  (await pay(s1, '2026-07-10', 16200, '1000', 16200, 1, 'Received in full.'));

  // EUR receipt after EUR strengthened (0.855 -> 0.862): FX gain on a receivable.
  const s2 = (await inv('sale', customer['Van Dijk Distributie B.V.'], 'NB-S-002', '2026-06-25', 'EUR', 0.855, [
    { description: 'Storage systems - export', account_code: '4000', cost_center: '100', net_amount: 18000, vat_rate: 0 },
  ]));
  (await pay(s2, '2026-07-24', 18000, '1010', 18000, 0.862, 'Received in EUR account.'));

  // USD receivable partly received into the GBP account at a worse rate: FX loss.
  const s3 = (await inv('sale', customer['Bayside Imports LLC'], 'NB-S-003', '2026-07-15', 'USD', 0.78, [
    { description: 'Storage systems - export', account_code: '4000', cost_center: '100', net_amount: 14000, vat_rate: 0 },
  ]));
  (await pay(s3, '2026-08-14', 8000, '1000', 6160, 1, 'Part payment, converted by the bank into GBP.'));

  (await inv('sale', customer['Harlow Retail Group Ltd'], 'NB-S-004', '2026-08-20', 'GBP', 1, [
    { description: 'Mezzanine shelving', account_code: '4000', cost_center: '100', net_amount: 9500, vat_rate: 20 },
  ]));

  (await inv('sale', customer['Van Dijk Distributie B.V.'], 'NB-S-005', '2026-09-02', 'EUR', 0.858, [
    { description: 'Storage systems - export', account_code: '4000', cost_center: '100', net_amount: 7200, vat_rate: 0 },
    { description: 'Commissioning', account_code: '4100', cost_center: '200', net_amount: 800, vat_rate: 0 },
  ]));

  (await inv('sale', customer['Harlow Retail Group Ltd'], 'NB-S-006', '2026-09-15', 'GBP', 1, [
    { description: 'Distribution centre racking, phase 1', account_code: '4000', cost_center: '100', net_amount: 90000, vat_rate: 20 },
    { description: 'Installation and commissioning', account_code: '4100', cost_center: '200', net_amount: 8000, vat_rate: 20 },
  ]));

  // ----- Northbridge Holding: directors' fees and audit accrual -----
  for (const [date, month] of [['2026-06-28', 'June'], ['2026-07-28', 'July'], ['2026-08-28', 'August']]) {
    (await journal(date, `DIR-${month.slice(0, 3).toUpperCase()}`, `Directors' fees ${month} 2026`, [
      { account_code: '6100', debit: 2500, cost_center: '300' },
      { account_code: '1050', credit: 2500 },
    ], H));
  }
  (await journal('2026-08-31', 'ACC-AUG', 'Accrued audit fee', [
    { account_code: '6300', debit: 800, cost_center: '300' },
    { account_code: '2300', credit: 800 },
  ], H));

  // ===== Intercompany: management fees charged by Holding =====
  // Revenue 4200 in Holding, cost 6400 in the other company. Settled the month after.
  const feeMonths = [['06', '2026-06-30', '2026-07-15'], ['07', '2026-07-31', '2026-08-14'], ['08', '2026-08-31', null], ['09', '2026-09-30', null]];
  const fee = (buy_cc) => (net) => [{ description: 'Management services', sell: '4200', buy: '6400', net, buy_cc }];
  for (const [m, date, paidOn] of feeMonths) {
    // Trading (GBP, VAT)
    (await crossCharge({
      seller: 'NBH', buyer: 'NBT', number: `NBH-MF-2026-${m}`, date, vat: 20, lines: fee('300')(4000).map((l) => ({ ...l, description: `Management services 2026-${m}` })),
      settle: paidOn ? { date: paidOn, seller: ['1050', 4800, 1], buyer: ['1000', 4800, 1] } : null,
    }));
    // Shared services (GBP, VAT)
    (await crossCharge({
      seller: 'NBH', buyer: 'NBS', number: `NBH-MF-NBS-2026-${m}`, date, vat: 20, lines: fee('300')(1500).map((l) => ({ ...l, description: `Management services 2026-${m}` })),
      settle: paidOn && m !== '08' ? { date: paidOn, seller: ['1050', 1800, 1], buyer: ['1070', 1800, 1] } : null,
    }));
    // Manufacturing (EUR, outside UK VAT): settled at the rate of the payment day
    const eurRate = { '06': 0.855, '07': 0.86, '08': 0.858, '09': 0.862 }[m];
    const payRate = { '06': 0.857, '07': 0.862 }[m];
    (await crossCharge({
      seller: 'NBH', buyer: 'NBM', number: `NBH-MF-NBM-2026-${m}`, date, currency: 'EUR', rate: eurRate, lines: fee('300')(3500).map((l) => ({ ...l, description: `Management services 2026-${m}` })),
      settle: paidOn ? { date: paidOn, seller: ['1050', Math.round(3500 * payRate * 100) / 100, 1], buyer: ['1060', 3500, payRate] } : null,
    }));
    if (m !== '06') {
      // Properties (from July)
      (await crossCharge({
        seller: 'NBH', buyer: 'NBP', number: `NBH-MF-NBP-2026-${m}`, date, vat: 20, lines: fee('300')(1000).map((l) => ({ ...l, description: `Management services 2026-${m}` })),
        settle: m === '07' ? { date: paidOn, seller: ['1050', 1200, 1], buyer: ['1080', 1200, 1] } : null,
      }));
      // US company (USD, from July)
      const usdRate = { '07': 0.79, '08': 0.785, '09': 0.78 }[m];
      (await crossCharge({
        seller: 'NBH', buyer: 'NBU', number: `NBH-MF-NBU-2026-${m}`, date, currency: 'USD', rate: usdRate, lines: [{ description: `Management services 2026-${m}`, sell: '4200', buy: '6400', net: 2000 }],
      }));
    }
  }

  // ===== Intercompany: shared services (IT, finance, HR) charged by NBS =====
  const ssTargets = [
    { buyer: 'NBT', net: 6500, vat: 20, bank: ['1000', null, 1] },
    { buyer: 'NBM', net: 4200, vat: 0, bank: ['1061', null, 1] },
    { buyer: 'NBP', net: 1200, vat: 20, bank: ['1080', null, 1] },
    { buyer: 'NBU', net: 2800, vat: 0, bank: ['1090', 3589.74, 0.78] }, // paid from the USD account
  ];
  for (const [m, date, paidOn] of feeMonths) {
    for (const t of ssTargets) {
      const gross = t.net * (1 + t.vat / 100);
      const bankAmount = t.bank[1] ? t.bank[1] : gross;
      // E3: the manufacturing company booked August at 4,020 instead of 4,200 (typo).
      const buyerNets = t.buyer === 'NBM' && m === '08' ? [4020] : undefined;
      (await crossCharge({
        seller: 'NBS', buyer: t.buyer, number: `NBS-SS-${t.buyer}-2026-${m}`, date, vat: t.vat,
        lines: [{ description: `IT, finance & HR services ${date.slice(0, 7)}`, sell: '4100', buy: '6410', net: t.net, buy_cc: t.buyer === 'NBU' ? null : '400' }],
        buyerNets,
        settle: paidOn ? { date: paidOn, seller: ['1070', gross, 1], buyer: [t.bank[0], bankAmount, t.bank[2]] } : null,
      }));
    }
  }

  // ===== Intercompany: rent charged by Properties =====
  (await crossCharge({
    seller: 'NBP', buyer: 'NBT', number: 'NBP-RENT-Q3-NBT', date: '2026-07-01', vat: 20,
    lines: [{ description: 'Warehouse B rent Q3 2026', sell: '4500', buy: '6000', net: 15000, buy_cc: '200' }],
    settle: { date: '2026-07-20', seller: ['1080', 18000, 1], buyer: ['1000', 18000, 1] },
  }));
  // E4: Properties invoiced on 1 July, Shared Services only booked it on 3 August (cut-off).
  (await crossCharge({
    seller: 'NBP', buyer: 'NBS', number: 'NBP-RENT-Q3-NBS', date: '2026-07-01', buyerDate: '2026-08-03', vat: 20,
    lines: [{ description: 'Office rent Q3 2026', sell: '4500', buy: '6000', net: 3600, buy_cc: '300' }],
    settle: { date: '2026-08-20', seller: ['1080', 4320, 1], buyer: ['1070', 4320, 1] },
  }));

  // ===== Intercompany: components from Manufacturing to Trading (EUR) =====
  const components = (net) => [{ description: 'Precision components', sell: '4000', buy: '5000', net, sell_cc: '100', buy_cc: '200' }];
  (await crossCharge({
    seller: 'NBM', buyer: 'NBT', number: 'NBM-IC-2026-014', date: '2026-06-18', currency: 'EUR', rate: 0.855, lines: components(24000),
    settle: { date: '2026-07-18', seller: ['1060', 24000, 0.857], buyer: ['1010', 24000, 0.857] },
  }));
  (await crossCharge({
    seller: 'NBM', buyer: 'NBT', number: 'NBM-IC-2026-021', date: '2026-07-22', currency: 'EUR', rate: 0.86, lines: components(31500),
    settle: { date: '2026-08-24', seller: ['1060', 31500, 0.861], buyer: ['1010', 31500, 0.861] },
  }));
  // E1: the same EUR 28,000, booked by Manufacturing at 0.858 but by Trading at 0.862.
  (await crossCharge({ seller: 'NBM', buyer: 'NBT', number: 'NBM-IC-2026-033', date: '2026-08-26', currency: 'EUR', rate: 0.858, buyerRate: 0.862, lines: components(28000) }));
  // E2: invoiced by Manufacturing, not yet booked by Trading.
  (await crossCharge({ seller: 'NBM', buyer: 'NBT', number: 'NBM-IC-2026-041', date: '2026-09-24', currency: 'EUR', rate: 0.86, lines: components(19500), only: 'seller' }));

  // ===== Intercompany: goods from Trading to the US company (USD) =====
  const goods = (net) => [{ description: 'Storage systems for resale', sell: '4000', buy: '5000', net, sell_cc: '100', buy_cc: '200' }];
  (await crossCharge({
    seller: 'NBT', buyer: 'NBU', number: 'NBT-IC-0031', date: '2026-07-08', currency: 'USD', rate: 0.79, lines: goods(40000),
    settle: { date: '2026-08-12', seller: ['1020', 40000, 0.788], buyer: ['1090', 40000, 0.788] },
  }));
  (await crossCharge({ seller: 'NBT', buyer: 'NBU', number: 'NBT-IC-0038', date: '2026-08-19', currency: 'USD', rate: 0.785, lines: goods(25000) }));
  // E5: booked by the US company, but Trading never raised the invoice.
  (await crossCharge({ seller: 'NBT', buyer: 'NBU', number: 'NBT-IC-0044', date: '2026-09-29', currency: 'USD', rate: 0.78, lines: goods(12000), only: 'buyer' }));

  // ===== Intercompany: loans and interest from Holding =====
  const loan = async (borrower, date, amount, bank) => {
    (await acct.postJournal({
      entity_id: H, journal_date: date, reference: `LOAN-${borrower}`, description: `Loan to ${ENTITY_NAME[borrower]}`, source_type: 'manual',
      lines: [
        { account_code: '1400', debit: amount, counterparty_entity_id: E[borrower] },
        { account_code: '1050', credit: amount },
      ],
    }));
    (await acct.postJournal({
      entity_id: E[borrower], journal_date: date, reference: `LOAN-NBH`, description: `Loan from ${ENTITY_NAME.NBH}`, source_type: 'manual',
      lines: [
        { account_code: bank, debit: amount },
        { account_code: '2450', credit: amount, counterparty_entity_id: H },
      ],
    }));
  };
  const interest = async (borrower, date, lenderAmount, borrowerAmount) => {
    (await acct.postJournal({
      entity_id: H, journal_date: date, reference: `INT-${borrower}`, description: `Interest ${date.slice(0, 7)} on loan to ${ENTITY_NAME[borrower]}`, source_type: 'manual',
      lines: [
        { account_code: '1410', debit: lenderAmount, counterparty_entity_id: E[borrower] },
        { account_code: '7300', credit: lenderAmount, counterparty_entity_id: E[borrower] },
      ],
    }));
    (await acct.postJournal({
      entity_id: E[borrower], journal_date: date, reference: 'INT-NBH', description: `Interest ${date.slice(0, 7)} on loan from ${ENTITY_NAME.NBH}`, source_type: 'manual',
      lines: [
        { account_code: '7400', debit: borrowerAmount, counterparty_entity_id: H },
        { account_code: '2460', credit: borrowerAmount, counterparty_entity_id: H },
      ],
    }));
  };
  (await loan('NBM', '2026-06-15', 100000, '1061'));
  (await loan('NBP', '2026-06-20', 250000, '1080'));
  (await loan('NBU', '2026-07-05', 60000, '1090'));
  for (const date of ['2026-07-31', '2026-08-31', '2026-09-30']) {
    // E6: in September Manufacturing booked 416.00 where Holding booked 416.67 (rounding, within tolerance).
    (await interest('NBM', date, 416.67, date === '2026-09-30' ? 416.0 : 416.67));
    (await interest('NBP', date, 833.33, 833.33));
  }
  for (const date of ['2026-08-31', '2026-09-30']) (await interest('NBU', date, 300, 300));
  // E7: the US company repaid GBP 10,000 on 30 September; Holding has not booked the receipt yet.
  (await acct.postJournal({
    entity_id: E.NBU, journal_date: '2026-09-30', reference: 'LOAN-REPAY', description: `Repayment of loan from ${ENTITY_NAME.NBH}`, source_type: 'manual',
    lines: [
      { account_code: '2450', debit: 10000, counterparty_entity_id: H },
      { account_code: '1090', credit: 10000, currency: 'USD', fx_note: '12820.51 USD @ 0.78' },
    ],
  }));

  // ===== Northbridge Manufacturing: production, outside sales and purchases (EUR) =====
  const rheinmetall = supplier['Rheinmetall Bauteile GmbH'];
  const nbmP1 = (await inv('purchase', rheinmetall, 'RB-NBM-114', '2026-06-20', 'EUR', 0.855, [
    { description: 'Steel bar stock and castings', account_code: '1500', net_amount: 18000, vat_rate: 0 },
  ], null, E.NBM));
  (await pay(nbmP1, '2026-07-20', 18000, '1060', 18000, 0.858, 'Paid from EUR account.'));
  (await inv('purchase', rheinmetall, 'RB-NBM-129', '2026-08-12', 'EUR', 0.858, [
    { description: 'Steel bar stock and castings', account_code: '1500', net_amount: 22000, vat_rate: 0 },
  ], null, E.NBM));
  const nbmS1 = (await inv('sale', customer['Van Dijk Distributie B.V.'], 'NBM-S-001', '2026-07-10', 'EUR', 0.86, [
    { description: 'Machined housings, series 12', account_code: '4000', cost_center: '100', net_amount: 40000, vat_rate: 0 },
  ], null, E.NBM));
  (await pay(nbmS1, '2026-08-10', 40000, '1060', 40000, 0.863, 'Received in EUR account.'));
  (await inv('sale', customer['Van Dijk Distributie B.V.'], 'NBM-S-002', '2026-09-08', 'EUR', 0.858, [
    { description: 'Machined housings, series 13', account_code: '4000', cost_center: '100', net_amount: 35000, vat_rate: 0 },
  ], null, E.NBM));
  for (const [date, month, rate] of [['2026-06-28', 'JUN', 0.855], ['2026-07-28', 'JUL', 0.86], ['2026-08-28', 'AUG', 0.858], ['2026-09-28', 'SEP', 0.857]]) {
    (await journalIn(E.NBM, 'EUR', rate, date, `PROD-${month}`, `Production costs ${month} 2026`, [
      { account_code: '5200', debit: 14000, cost_center: '200', description: 'Production labour' },
      { account_code: '5300', debit: 2200, cost_center: '200', description: 'Energy and factory overheads' },
      { account_code: '6100', debit: 6000, cost_center: '300', description: 'Selling & administration salaries' },
      { account_code: '1060', credit: 22200 },
    ]));
    (await journalIn(E.NBM, 'EUR', rate, date, `MAT-${month}`, `Materials consumed ${month} 2026`, [
      { account_code: '5000', debit: 12000, cost_center: '200' },
      { account_code: '1500', credit: 12000 },
    ]));
  }

  // ===== Northbridge Shared Services: software and staff =====
  const cloudwave = supplier['Cloudwave Software Ltd'];
  for (const [m, date, paid] of [['06', '2026-06-01', '2026-06-25'], ['07', '2026-07-01', '2026-07-25'], ['08', '2026-08-01', null], ['09', '2026-09-01', null]]) {
    const i = (await inv('purchase', cloudwave, `CW-2026-${m}01`, date, 'GBP', 1, [
      { description: 'ERP & collaboration licences', account_code: '6150', cost_center: '400', net_amount: 3000, vat_rate: 20 },
    ], null, E.NBS));
    if (paid) (await pay(i, paid, 3600, '1070', 3600, 1, 'Paid by direct debit.'));
  }
  for (const [date, month] of [['2026-06-28', 'JUN'], ['2026-07-28', 'JUL'], ['2026-08-28', 'AUG'], ['2026-09-28', 'SEP']]) {
    (await journal(date, `PAY-${month}`, `Salaries ${month} 2026`, [
      { account_code: '6100', debit: 6000, cost_center: '400' },
      { account_code: '6100', debit: 3000, cost_center: '300' },
      { account_code: '1070', credit: 9000 },
    ], E.NBS));
  }

  // ===== Northbridge Properties: tenants, maintenance, insurance, mortgage =====
  for (const [m, date, paid] of [['06', '2026-06-01', '2026-06-15'], ['07', '2026-07-01', '2026-07-15'], ['08', '2026-08-01', '2026-08-14'], ['09', '2026-09-01', null]]) {
    const i = (await inv('sale', customer['Harlow Retail Group Ltd'], `NBP-RENT-HRG-${m}`, date, 'GBP', 1, [
      { description: `Retail unit rent ${date.slice(0, 7)}`, account_code: '4500', net_amount: 9000, vat_rate: 20 },
    ], null, E.NBP));
    if (paid) (await pay(i, paid, 10800, '1080', 10800, 1, 'Received by standing order.'));
  }
  const nbpM = (await inv('purchase', supplier['Fenwick & Doyle Ltd'], 'FD-NBP-208', '2026-08-04', 'GBP', 1, [
    { description: 'Roof repairs, retail unit', account_code: '5500', cost_center: '200', net_amount: 2400, vat_rate: 20 },
  ], null, E.NBP));
  (await pay(nbpM, '2026-08-25', 2880, '1080', 2880, 1, 'Paid by bank transfer.'));
  (await journal('2026-07-01', 'INS-Q3', 'Building insurance and business rates Q3', [
    { account_code: '5600', debit: 3000, cost_center: '200' },
    { account_code: '1080', credit: 3000 },
  ], E.NBP));
  for (const [date, month] of [['2026-06-28', 'JUN'], ['2026-07-28', 'JUL'], ['2026-08-28', 'AUG'], ['2026-09-28', 'SEP']]) {
    (await journal(date, `MORT-${month}`, `Mortgage interest ${month} 2026`, [
      { account_code: '7600', debit: 2000 },
      { account_code: '1080', credit: 2000 },
    ], E.NBP));
  }

  // ===== Northbridge Inc. (US): sales to outside customers, commissions, payroll taxes =====
  const nbuS1 = (await inv('sale', customer['Bayside Imports LLC'], 'NBU-S-001', '2026-08-14', 'USD', 0.785, [
    { description: 'Storage systems, east coast order', account_code: '4000', cost_center: '100', net_amount: 30000, vat_rate: 0 },
  ], null, E.NBU));
  (await pay(nbuS1, '2026-09-15', 30000, '1090', 30000, 0.782, 'Received in USD account.'));
  (await inv('sale', customer['Bayside Imports LLC'], 'NBU-S-002', '2026-09-10', 'USD', 0.78, [
    { description: 'Storage systems, west coast order', account_code: '4000', cost_center: '100', net_amount: 22000, vat_rate: 0 },
  ], null, E.NBU));
  // Purchases are booked as cost; month-end stock adjustments move what is still on the shelf to inventory.
  (await journalIn(E.NBU, 'USD', 0.79, '2026-07-31', 'STOCK-JUL', 'Stock adjustment July 2026', [
    { account_code: '1520', debit: 40000 },
    { account_code: '5000', credit: 40000, cost_center: '200' },
  ]));
  (await journalIn(E.NBU, 'USD', 0.785, '2026-08-31', 'STOCK-AUG', 'Stock adjustment August 2026', [
    { account_code: '1520', debit: 7000 },
    { account_code: '5000', credit: 7000, cost_center: '200' },
  ]));
  (await journalIn(E.NBU, 'USD', 0.78, '2026-09-30', 'STOCK-SEP', 'Stock adjustment September 2026', [
    { account_code: '5000', debit: 1200, cost_center: '200' },
    { account_code: '1520', credit: 1200 },
  ]));
  for (const [date, month, rate] of [['2026-07-28', 'JUL', 0.79], ['2026-08-28', 'AUG', 0.785], ['2026-09-28', 'SEP', 0.78]]) {
    (await journalIn(E.NBU, 'USD', rate, date, `COMM-${month}`, `Commissions and payroll taxes ${month} 2026`, [
      { account_code: '6700', debit: 1500, cost_center: '100' },
      { account_code: '6710', debit: 3000, cost_center: '300' },
      { account_code: '1090', credit: 4500 },
    ]));
  }

  // Depreciation for every month that has ended, then close June as a worked example.
  (await assets.runDueDepreciation());
  (await assets.closePeriod('2026-06'));
}

module.exports = { seedIfEmpty };
