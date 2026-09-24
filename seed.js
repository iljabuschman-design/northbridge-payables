'use strict';

const { db, transaction } = require('./db');
const acct = require('./accounting');
const assets = require('./assets');

const { ROLES } = acct;

const ACCOUNTS = [
  { code: '0200', name: 'Machinery - investment', category: 'fixed_assets', role: ROLES.MACHINERY_COST },
  { code: '0210', name: 'Machinery - accumulated depreciation', category: 'accumulated_depreciation', role: ROLES.MACHINERY_ACCUM },
  { code: '0300', name: 'Inventory - investment', category: 'fixed_assets', role: ROLES.INVENTORY_COST },
  { code: '0310', name: 'Inventory - accumulated depreciation', category: 'accumulated_depreciation', role: ROLES.INVENTORY_ACCUM },
  { code: '1000', name: 'Bank - GBP', category: 'cash', bank_currency: 'GBP', iban: 'GB29NWBK60161331926819' },
  { code: '1010', name: 'Bank - EUR', category: 'cash', bank_currency: 'EUR', iban: 'DE89370400440532013000' },
  { code: '1020', name: 'Bank - USD', category: 'cash', bank_currency: 'USD', iban: 'GB33BUKB20201555555555' },
  { code: '1100', name: 'Accounts receivable', category: 'receivables', role: ROLES.AR },
  { code: '1200', name: 'VAT recoverable (input VAT)', category: 'other_current_assets', role: ROLES.VAT_IN },
  { code: '1300', name: 'Prepayments', category: 'other_current_assets' },
  { code: '2100', name: 'Accounts payable', category: 'payables', role: ROLES.AP },
  { code: '2200', name: 'VAT payable (output VAT)', category: 'other_current_liabilities', role: ROLES.VAT_OUT },
  { code: '2300', name: 'Accruals', category: 'other_current_liabilities' },
  { code: '3000', name: 'Share capital', category: 'equity' },
  { code: '3100', name: 'Retained earnings', category: 'equity' },
  { code: '4000', name: 'Sales - products', category: 'revenue' },
  { code: '4100', name: 'Sales - services', category: 'revenue' },
  { code: '5000', name: 'Purchases - materials & components', category: 'cost_of_sales' },
  { code: '5100', name: 'Freight & packaging', category: 'cost_of_sales' },
  { code: '6000', name: 'Rent & premises', category: 'overheads' },
  { code: '6100', name: 'Salaries & wages', category: 'overheads' },
  { code: '6200', name: 'Office & facilities', category: 'overheads' },
  { code: '6300', name: 'Professional fees', category: 'overheads' },
  { code: '6500', name: 'Depreciation - machinery', category: 'depreciation', role: ROLES.MACHINERY_DEPR },
  { code: '6510', name: 'Depreciation - inventory', category: 'depreciation', role: ROLES.INVENTORY_DEPR },
  { code: '7000', name: 'Realised FX gain', category: 'financial_income', role: ROLES.FX_GAIN },
  { code: '7100', name: 'Realised FX loss', category: 'financial_expenses', role: ROLES.FX_LOSS },
  { code: '7200', name: 'Bank charges', category: 'financial_expenses' },
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

function seedIfEmpty() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM company').get().c;
  if (existing > 0) return; // already seeded
  transaction(seed);
}

function seed() {
  db.prepare('INSERT INTO company (id, name, base_currency) VALUES (1, ?, ?)').run('Northbridge Trading Ltd', 'GBP');
  acct.ensurePeriods('2026-01', '2026-12');
  for (const a of ACCOUNTS) acct.createAccount(a);
  for (const c of COST_CENTERS) acct.createCostCenter(c);

  const supplier = {};
  for (const s of [
    { name: 'Fenwick & Doyle Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB123456789', sort_code: '20-00-00', account_number: '55779911' },
    { name: 'Rheinmetall Bauteile GmbH', country: 'Germany', currency: 'EUR', vat_number: 'DE987654321', iban: 'DE75512108001245126199', bic: 'SOGEDEFFXXX' },
    { name: 'Atlas Fasteners Inc.', country: 'United States', currency: 'USD', vat_number: null, iban: 'GB94BARC10201530093459', bic: 'BARCGB22' },
    { name: 'Lumiere Packaging SARL', country: 'France', currency: 'EUR', vat_number: 'FR445566778', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' },
    { name: 'Canary Property Management Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB555666777', sort_code: '40-11-60', account_number: '31926819' },
    { name: 'Brightcut Laser Systems Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB777888999', sort_code: '30-94-57', account_number: '10442786' },
  ]) {
    supplier[s.name] = acct.createParty('supplier', s).id;
  }

  const customer = {};
  for (const c of [
    { name: 'Harlow Retail Group Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB998877665' },
    { name: 'Van Dijk Distributie B.V.', country: 'Netherlands', currency: 'EUR', vat_number: 'NL123456789B01' },
    { name: 'Bayside Imports LLC', country: 'United States', currency: 'USD', vat_number: null },
  ]) {
    customer[c.name] = acct.createParty('customer', c).id;
  }

  // ----- Opening balance: bank accounts, share capital and the assets taken over -----
  const opening = OPENING_ASSETS.map((a) => ({ ...a, opening_depreciation: assets.depreciationBefore(a, '2026-06') }));
  const sum = (type, key) => opening.filter((a) => a.asset_type === type).reduce((t, a) => t + a[key], 0);
  const nbv = opening.reduce((t, a) => t + a.acquisition_cost - a.opening_depreciation, 0);
  acct.postJournal({
    journal_date: BOOKS_START,
    reference: 'OPEN',
    description: 'Opening balances',
    source_type: 'opening',
    lines: [
      { account_code: '1000', debit: 109250, currency: 'GBP' },
      { account_code: '1010', debit: 21250, currency: 'EUR', fx_note: '25000.00 EUR @ 0.85' },
      { account_code: '1020', debit: 19500, currency: 'USD', fx_note: '25000.00 USD @ 0.78' },
      { account_code: '0200', debit: sum('machinery', 'acquisition_cost') },
      { account_code: '0210', credit: sum('machinery', 'opening_depreciation') },
      { account_code: '0300', debit: sum('inventory', 'acquisition_cost') },
      { account_code: '0310', credit: sum('inventory', 'opening_depreciation') },
      { account_code: '3000', credit: 150000 },
      { account_code: '3100', credit: nbv, description: 'Retained earnings from prior years' },
    ],
  });
  for (const a of opening) assets.createAsset({ ...a, booking: 'existing', depreciation_start: '2026-06' });

  // Bought during the year and paid straight from the bank: posted by the asset register itself.
  assets.createAsset({
    name: 'Warehouse shelving & scanners',
    description: 'Long-span shelving and 6 handheld barcode scanners',
    asset_type: 'inventory',
    cost_center: '200',
    acquisition_date: '2026-06-05',
    acquisition_cost: 8000,
    depreciation_rate: 20,
    booking: 'journal',
    contra_account: '1000',
  });

  const journal = (journal_date, reference, description, lines) =>
    acct.createManualJournal({ journal_date, reference, description, currency: 'GBP', exchange_rate: 1, lines });
  for (const [date, month] of [['2026-06-28', 'June'], ['2026-07-28', 'July'], ['2026-08-28', 'August']]) {
    journal(date, `PAY-${month.slice(0, 3).toUpperCase()}`, `Salaries ${month} 2026`, [
      { account_code: '6100', debit: 2000, cost_center: '100' },
      { account_code: '6100', debit: 2500, cost_center: '200' },
      { account_code: '6100', debit: 1500, cost_center: '300' },
      { account_code: '6100', debit: 500, cost_center: '400' },
      { account_code: '1000', credit: 6500 },
    ]);
  }
  journal('2026-08-31', 'ACC-AUG', 'Accrued audit fee', [
    { account_code: '6300', debit: 1200, cost_center: '300' },
    { account_code: '2300', credit: 1200 },
  ]);

  const inv = (type, party, invoice_number, invoice_date, currency, exchange_rate, lines, notes) =>
    acct.createInvoice({ type, party_id: party, invoice_number, invoice_date, currency, exchange_rate, lines, notes });
  const pay = (invoice, payment_date, amount, bank_account, bank_amount, bank_rate, notes) =>
    acct.createPayment({ invoice_id: invoice.id, payment_date, amount, bank_account, bank_amount, bank_rate, notes });

  // ----- Purchase invoices -----
  const p1 = inv('purchase', supplier['Fenwick & Doyle Ltd'], 'FD-1001', '2026-06-02', 'GBP', 1, [
    { description: 'Office fit-out materials', account_code: '6200', cost_center: '300', net_amount: 3200, vat_rate: 20 },
    { description: 'Installation labour', account_code: '6200', cost_center: '300', net_amount: 1000, vat_rate: 20 },
  ], 'Office fit-out.');
  pay(p1, '2026-06-20', 5040, '1000', 5040, 1, 'Paid in full by bank transfer.');

  // EUR invoice paid from the EUR account after EUR weakened (0.855 -> 0.848): FX gain.
  const p2 = inv('purchase', supplier['Rheinmetall Bauteile GmbH'], 'RB-2201', '2026-06-10', 'EUR', 0.855, [
    { description: 'Precision components, batch 7', account_code: '5000', cost_center: '200', net_amount: 11200, vat_rate: 0 },
    { description: 'Freight', account_code: '5100', cost_center: '200', net_amount: 800, vat_rate: 0 },
  ], 'Reverse-charge cross-border purchase.');
  pay(p2, '2026-07-05', 12000, '1010', 12000, 0.848, 'Paid in full via EUR account.');

  // USD invoice partly paid from the USD account after USD strengthened (0.79 -> 0.805): FX loss.
  const p3 = inv('purchase', supplier['Atlas Fasteners Inc.'], 'AF-7781', '2026-06-15', 'USD', 0.79, [
    { description: 'Fasteners and brackets', account_code: '5000', cost_center: '200', net_amount: 9000, vat_rate: 0 },
  ], 'Balance of 4,000 USD still open.');
  pay(p3, '2026-07-10', 5000, '1020', 5000, 0.805, 'First instalment.');

  inv('purchase', supplier['Lumiere Packaging SARL'], 'LP-3390', '2026-07-01', 'EUR', 0.86, [
    { description: 'Retail packaging, Q3 run', account_code: '5100', cost_center: '200', net_amount: 3500, vat_rate: 0 },
  ]);

  const p5 = inv('purchase', supplier['Canary Property Management Ltd'], 'CPM-Q3-26', '2026-07-01', 'GBP', 1, [
    { description: 'Warehouse rent Q3 2026', account_code: '6000', cost_center: '200', net_amount: 6000, vat_rate: 20 },
    { description: 'Office rent Q3 2026', account_code: '6000', cost_center: '300', net_amount: 1500, vat_rate: 20 },
    { description: 'Service charge Q3 2026', account_code: '6000', cost_center: '300', net_amount: 600, vat_rate: 20 },
  ]);
  pay(p5, '2026-07-03', 9720, '1000', 9720, 1, 'Quarterly rent.');

  // Machine bought on a purchase invoice (line on the investment ledger), then added to the register.
  const p6 = inv('purchase', supplier['Brightcut Laser Systems Ltd'], 'BLS-2026-118', '2026-07-14', 'GBP', 1, [
    { description: 'Fibre laser cutting machine 3 kW', account_code: '0200', net_amount: 42000, vat_rate: 20 },
  ]);
  pay(p6, '2026-07-31', 50400, '1000', 50400, 1, 'Paid on delivery.');
  assets.createAsset({
    name: 'Fibre laser cutter 3 kW',
    description: 'Sheet metal laser cutter, bought on invoice BLS-2026-118',
    asset_type: 'machinery',
    cost_center: '200',
    acquisition_date: '2026-07-14',
    acquisition_cost: 42000,
    depreciation_rate: 12.5,
    booking: 'existing',
  });

  // 1,000 USD invoice booked at 800 GBP, paid from the GBP account costing 750 GBP: 50 GBP FX gain.
  const p7 = inv('purchase', supplier['Atlas Fasteners Inc.'], 'AF-7799', '2026-07-20', 'USD', 0.8, [
    { description: 'Follow-on fasteners order', account_code: '5000', cost_center: '200', net_amount: 1000, vat_rate: 0 },
  ]);
  pay(p7, '2026-08-01', 1000, '1000', 750, 1, 'Paid from GBP account - bank converted 1,000 USD for 750 GBP.');

  inv('purchase', supplier['Fenwick & Doyle Ltd'], 'FD-1050', '2026-08-04', 'GBP', 1, [
    { description: 'Signage', account_code: '6200', cost_center: '100', net_amount: 1100, vat_rate: 20 },
    { description: 'Internal partitions', account_code: '6200', cost_center: '300', net_amount: 700, vat_rate: 20 },
  ]);

  // ----- Sales invoices -----
  const s1 = inv('sale', customer['Harlow Retail Group Ltd'], 'NB-S-001', '2026-06-12', 'GBP', 1, [
    { description: 'Storage systems', account_code: '4000', cost_center: '100', net_amount: 12000, vat_rate: 20 },
    { description: 'Installation', account_code: '4100', cost_center: '200', net_amount: 1500, vat_rate: 20 },
  ]);
  pay(s1, '2026-07-10', 16200, '1000', 16200, 1, 'Received in full.');

  // EUR receipt after EUR strengthened (0.855 -> 0.862): FX gain on a receivable.
  const s2 = inv('sale', customer['Van Dijk Distributie B.V.'], 'NB-S-002', '2026-06-25', 'EUR', 0.855, [
    { description: 'Storage systems - export', account_code: '4000', cost_center: '100', net_amount: 18000, vat_rate: 0 },
  ]);
  pay(s2, '2026-07-24', 18000, '1010', 18000, 0.862, 'Received in EUR account.');

  // USD receivable partly received into the GBP account at a worse rate: FX loss.
  const s3 = inv('sale', customer['Bayside Imports LLC'], 'NB-S-003', '2026-07-15', 'USD', 0.78, [
    { description: 'Storage systems - export', account_code: '4000', cost_center: '100', net_amount: 14000, vat_rate: 0 },
  ]);
  pay(s3, '2026-08-14', 8000, '1000', 6160, 1, 'Part payment, converted by the bank into GBP.');

  inv('sale', customer['Harlow Retail Group Ltd'], 'NB-S-004', '2026-08-20', 'GBP', 1, [
    { description: 'Mezzanine shelving', account_code: '4000', cost_center: '100', net_amount: 9500, vat_rate: 20 },
  ]);

  inv('sale', customer['Van Dijk Distributie B.V.'], 'NB-S-005', '2026-09-02', 'EUR', 0.858, [
    { description: 'Storage systems - export', account_code: '4000', cost_center: '100', net_amount: 7200, vat_rate: 0 },
    { description: 'Commissioning', account_code: '4100', cost_center: '200', net_amount: 800, vat_rate: 0 },
  ]);

  // Depreciation for every month that has ended, then close June as a worked example.
  assets.runDueDepreciation();
  assets.closePeriod('2026-06');
}

module.exports = { seedIfEmpty };
