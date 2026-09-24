'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const acct = require('./accounting');
const fx = require('./fx');
const bank = require('./bank');
const assets = require('./assets');
const { seedIfEmpty } = require('./seed');

seedIfEmpty();
fx.startScheduler();
assets.startScheduler();

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10_000_000) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const json = (fn) => async (req, match, query) => fn(await readBody(req), match, query);

const routes = [
  { method: 'GET', pattern: /^\/api\/company$/, handler: async () => acct.getCompany() },
  {
    method: 'GET',
    pattern: /^\/api\/meta$/,
    handler: async () => ({
      company: acct.getCompany(),
      currencies: acct.CURRENCIES,
      categories: acct.CATEGORIES,
      asset_types: Object.entries(assets.ASSET_TYPES).map(([key, t]) => ({ key, name: t.name })),
      entities: acct.listEntities(),
    }),
  },
  { method: 'GET', pattern: /^\/api\/entities$/, handler: async () => acct.listEntities() },

  // Cost centres
  { method: 'GET', pattern: /^\/api\/cost-centers$/, handler: async () => acct.listCostCenters() },
  { method: 'POST', pattern: /^\/api\/cost-centers$/, handler: json((body) => acct.createCostCenter(body)) },
  { method: 'PUT', pattern: /^\/api\/cost-centers\/([^/]+)$/, handler: json((body, m) => acct.updateCostCenter(m[1], body)) },

  // Periods
  { method: 'GET', pattern: /^\/api\/periods$/, handler: async () => acct.listPeriods() },
  { method: 'POST', pattern: /^\/api\/periods\/(\d{4}-\d{2})\/close$/, handler: async (req, m) => assets.closePeriod(m[1]) },
  { method: 'POST', pattern: /^\/api\/periods\/(\d{4}-\d{2})\/reopen$/, handler: async (req, m) => acct.setPeriodStatus(m[1], 'open') },

  // Fixed assets
  { method: 'GET', pattern: /^\/api\/assets$/, handler: async (req, m, q) => ({ assets: assets.listAssets(q.get('entity')), depreciation: assets.getStatus() }) },
  { method: 'POST', pattern: /^\/api\/assets$/, handler: json((body) => assets.createAsset(body)) },
  {
    method: 'GET',
    pattern: /^\/api\/assets\/(\d+)$/,
    handler: async (req, m) => {
      const a = assets.getAsset(Number(m[1]));
      if (!a) throw acct.httpError(404, 'Asset not found');
      return a;
    },
  },
  { method: 'POST', pattern: /^\/api\/assets\/depreciation$/, handler: json((body) => assets.runDepreciation(body.period)) },

  // Chart of accounts
  { method: 'GET', pattern: /^\/api\/accounts$/, handler: async (req, m, q) => acct.listAccounts(q.get('entity')) },
  {
    method: 'GET',
    pattern: /^\/api\/accounts\/([^/]+)\/detail$/,
    handler: async (req, m, q) =>
      acct.accountDetail(decodeURIComponent(m[1]), { from: q.get('from'), to: q.get('to'), entity_id: q.get('entity'), cost_center: q.get('cost_center') || null }),
  },
  { method: 'POST', pattern: /^\/api\/accounts$/, handler: json((body) => acct.createAccount({ ...body, role: null })) },
  { method: 'PUT', pattern: /^\/api\/accounts\/([^/]+)$/, handler: json((body, m) => acct.updateAccount(m[1], body)) },

  // Customers & suppliers
  { method: 'GET', pattern: /^\/api\/suppliers$/, handler: async () => acct.listParties('supplier') },
  { method: 'POST', pattern: /^\/api\/suppliers$/, handler: json((body) => acct.createParty('supplier', body)) },
  { method: 'PUT', pattern: /^\/api\/suppliers\/(\d+)$/, handler: json((body, m) => acct.updateParty('supplier', Number(m[1]), body)) },
  { method: 'GET', pattern: /^\/api\/customers$/, handler: async () => acct.listParties('customer') },
  { method: 'POST', pattern: /^\/api\/customers$/, handler: json((body) => acct.createParty('customer', body)) },
  { method: 'PUT', pattern: /^\/api\/customers\/(\d+)$/, handler: json((body, m) => acct.updateParty('customer', Number(m[1]), body)) },

  // Purchase & sales invoices
  { method: 'GET', pattern: /^\/api\/invoices$/, handler: async (req, m, q) => acct.listInvoices(q.get('type') || null, q.get('entity')) },
  { method: 'POST', pattern: /^\/api\/invoices$/, handler: json((body) => acct.createInvoice(body)) },
  {
    method: 'GET',
    pattern: /^\/api\/invoices\/(\d+)$/,
    handler: async (req, m) => {
      const detail = acct.invoiceDetail(Number(m[1]));
      if (!detail) throw acct.httpError(404, 'Invoice not found');
      return detail;
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/invoices\/(\d+)\/payments$/,
    handler: json((body, m) => acct.createPayment({ ...body, invoice_id: Number(m[1]) })),
  },
  {
    method: 'POST',
    pattern: /^\/api\/invoices\/(\d+)\/simulated-payment$/,
    handler: json((body, m) => bank.simulatedPayment({ ...body, invoice_id: Number(m[1]) })),
  },

  // Journals & ledger
  { method: 'GET', pattern: /^\/api\/journals$/, handler: async (req, m, q) => acct.listJournals(q.get('entity')) },
  { method: 'PUT', pattern: /^\/api\/journals\/(\d+)$/, handler: json((body, m) => acct.editJournal(Number(m[1]), body)) },
  { method: 'POST', pattern: /^\/api\/journals$/, handler: json((body) => acct.createManualJournal(body)) },
  {
    method: 'GET',
    pattern: /^\/api\/journals\/(\d+)$/,
    handler: async (req, m) => {
      const j = acct.getJournal(Number(m[1]));
      if (!j) throw acct.httpError(404, 'Journal not found');
      return j;
    },
  },
  { method: 'GET', pattern: /^\/api\/ledger$/, handler: async (req, m, q) => acct.listLedgerEntries(q.get('entity')) },
  { method: 'GET', pattern: /^\/api\/trial-balance$/, handler: async (req, m, q) => acct.trialBalance(q.get('entity')) },
  { method: 'GET', pattern: /^\/api\/dashboard$/, handler: async (req, m, q) => acct.dashboardSummary(q.get('entity')) },
  {
    method: 'GET',
    pattern: /^\/api\/reports$/,
    handler: async (req, m, q) => acct.financialStatements({ from: q.get('from'), to: q.get('to'), cost_center: q.get('cost_center') || null, entity_id: q.get('entity') }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/cost-centers$/,
    handler: async (req, m, q) => acct.costCenterReport({ from: q.get('from'), to: q.get('to'), entity_id: q.get('entity') }),
  },
  { method: 'GET', pattern: /^\/api\/kpis$/, handler: async (req, m, q) => acct.kpis({ from: q.get('from'), to: q.get('to'), entity_id: q.get('entity') }) },

  // Exchange rates (ECB)
  {
    method: 'GET',
    pattern: /^\/api\/fx\/rate$/,
    handler: async (req, m, q) => {
      const currency = q.get('currency');
      const date = q.get('date');
      if (!acct.CURRENCIES.includes(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
        throw acct.httpError(400, 'currency and date (YYYY-MM-DD) are required');
      }
      const rate = await fx.getRate(currency, date);
      if (!rate) throw acct.httpError(404, `No ECB rate available for ${currency} on ${date}`);
      return rate;
    },
  },
  { method: 'GET', pattern: /^\/api\/fx\/status$/, handler: async () => ({ latest: fx.latestRates(), ...fx.getStatus() }) },
  {
    method: 'POST',
    pattern: /^\/api\/fx\/refresh$/,
    handler: async () => {
      await fx.updateLatest();
      return { latest: fx.latestRates(), ...fx.getStatus() };
    },
  },

  // Bank statements (CAMT)
  { method: 'GET', pattern: /^\/api\/bank\/statements$/, handler: async (req, m, q) => bank.listStatements(q.get('entity')) },
  { method: 'POST', pattern: /^\/api\/bank\/statements$/, handler: json((body) => bank.importAndSettle(body)) },
  {
    method: 'POST',
    pattern: /^\/api\/bank\/statements\/(\d+)\/auto-settle$/,
    handler: async (req, m) => bank.autoSettleStatement(Number(m[1])),
  },
  {
    method: 'GET',
    pattern: /^\/api\/bank\/statements\/(\d+)$/,
    handler: async (req, m) => {
      const s = bank.getStatement(Number(m[1]));
      if (!s) throw acct.httpError(404, 'Statement not found');
      return s;
    },
  },
  { method: 'POST', pattern: /^\/api\/bank\/lines\/(\d+)\/post$/, handler: json((body, m) => bank.postLine(Number(m[1]), body)) },
];

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      try {
        const result = await route.handler(req, match, parsed.searchParams);
        return sendJson(res, 200, result);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(err);
        return sendJson(res, status, { error: err.message || 'Internal server error' });
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Northbridge Payables app listening on port ${PORT}`);
});

