'use strict';

const { db } = require('./db');
const acct = require('./accounting');

function seedIfEmpty() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM company').get().c;
  if (existing > 0) return; // already seeded

  db.prepare('INSERT INTO company (id, name, base_currency) VALUES (1, ?, ?)').run(
    'Northbridge Trading Ltd',
    'GBP'
  );

  const suppliers = [
    { name: 'Fenwick & Doyle Ltd', country: 'United Kingdom', currency: 'GBP', vat_number: 'GB123456789' },
    { name: 'Rheinmetall Bauteile GmbH', country: 'Germany', currency: 'EUR', vat_number: 'DE987654321' },
    { name: 'Atlas Fasteners Inc.', country: 'United States', currency: 'USD', vat_number: null },
    { name: 'Lumiere Packaging SARL', country: 'France', currency: 'EUR', vat_number: 'FR445566778' },
  ];
  const supplierIds = {};
  for (const s of suppliers) {
    const created = acct.createSupplier(s);
    supplierIds[s.name] = created.id;
  }

  // A spread of invoices across currencies, dates and rates, some fully paid,
  // some partially paid (to show FX gain/loss on settlement) and some fully open.
  const invoices = [
    {
      key: 'inv1',
      supplier: 'Fenwick & Doyle Ltd',
      invoice_number: 'FD-1001',
      invoice_date: '2026-06-02',
      currency: 'GBP',
      net_amount: 4200.0,
      vat_amount: 840.0,
      exchange_rate: 1,
      notes: 'Office fit-out materials.',
    },
    {
      key: 'inv2',
      supplier: 'Rheinmetall Bauteile GmbH',
      invoice_number: 'RB-2201',
      invoice_date: '2026-06-10',
      currency: 'EUR',
      net_amount: 12000.0,
      vat_amount: 0.0, // reverse-charge / zero-rated cross-border B2B purchase (see assumptions)
      exchange_rate: 0.855, // 1 EUR = 0.855 GBP on 10 Jun
      notes: 'Precision components, batch 7.',
    },
    {
      key: 'inv3',
      supplier: 'Atlas Fasteners Inc.',
      invoice_number: 'AF-7781',
      invoice_date: '2026-06-15',
      currency: 'USD',
      net_amount: 9000.0,
      vat_amount: 0.0,
      exchange_rate: 0.79, // 1 USD = 0.79 GBP on 15 Jun
      notes: 'Fasteners and brackets order.',
    },
    {
      key: 'inv4',
      supplier: 'Lumiere Packaging SARL',
      invoice_number: 'LP-3390',
      invoice_date: '2026-07-01',
      currency: 'EUR',
      net_amount: 3500.0,
      vat_amount: 0.0,
      exchange_rate: 0.86, // rate moved from 0.855 -> 0.86 by the time of this invoice
      notes: 'Retail packaging, Q3 run.',
    },
    {
      key: 'inv5',
      supplier: 'Atlas Fasteners Inc.',
      invoice_number: 'AF-7799',
      invoice_date: '2026-07-20',
      currency: 'USD',
      net_amount: 5400.0,
      vat_amount: 0.0,
      exchange_rate: 0.775, // dollar weaker vs GBP than inv3
      notes: 'Follow-on fasteners order.',
    },
    {
      key: 'inv6',
      supplier: 'Fenwick & Doyle Ltd',
      invoice_number: 'FD-1050',
      invoice_date: '2026-08-04',
      currency: 'GBP',
      net_amount: 1800.0,
      vat_amount: 360.0,
      exchange_rate: 1,
      notes: 'Signage and internal partitions.',
    },
  ];

  const created = {};
  for (const inv of invoices) {
    created[inv.key] = acct.createInvoice({
      supplier_id: supplierIds[inv.supplier],
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      currency: inv.currency,
      net_amount: inv.net_amount,
      vat_amount: inv.vat_amount,
      exchange_rate: inv.exchange_rate,
      notes: inv.notes,
    });
  }

  // Payments: mix of full/partial settlement, some at a moved rate to
  // demonstrate realised FX gain/loss.
  acct.createPayment({
    invoice_id: created.inv1.id,
    payment_date: '2026-06-20',
    amount: 5040.0, // full settlement, GBP invoice - no FX effect
    exchange_rate: 1,
    notes: 'Paid in full by bank transfer.',
  });

  acct.createPayment({
    invoice_id: created.inv2.id,
    payment_date: '2026-07-05',
    amount: 12000.0, // full settlement
    exchange_rate: 0.848, // EUR weakened vs GBP since invoice (0.855 -> 0.848) => FX gain
    notes: 'Paid in full via EUR account.',
  });

  acct.createPayment({
    invoice_id: created.inv3.id,
    payment_date: '2026-07-10',
    amount: 5000.0, // partial payment
    exchange_rate: 0.805, // USD strengthened vs GBP (0.79 -> 0.805) => FX loss on this tranche
    notes: 'First instalment.',
  });

  acct.createPayment({
    invoice_id: created.inv5.id,
    payment_date: '2026-08-01',
    amount: 2000.0, // partial payment, slight rate move
    exchange_rate: 0.78,
    notes: 'Deposit paid.',
  });

  // inv4 and inv6 left fully open on purpose.
}

module.exports = { seedIfEmpty };

