'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const acct = require('./accounting');
const fx = require('./fx');
const bank = require('./bank');
const assets = require('./assets');
const auth = require('./auth');
const recognition = require('./recognition');
const vat = require('./vat');
const { seedIfEmpty } = require('./seed');
const { init, db } = require('./db');

// Create the tables and demo data (first start only), then start the background jobs.
// Requests wait for this; on Vercel it runs once per function instance.
const ready = init()
  .then(seedIfEmpty)
  .then(acct.setUpVatCodes)
  .then(auth.ensureDefaultUsers)
  .then(() => {
    fx.startScheduler();
    assets.startScheduler();
  });
ready.catch((err) => console.error('Start-up failed:', err));

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
    // Answers depend on who is logged in: never let a browser or proxy reuse one.
    'Cache-Control': 'no-store',
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

const json = (fn) => async (req, match, query) => fn(await readBody(req), match, query, req);

const adminOnly = (req) => {
  if (req.user.role !== 'admin') throw acct.httpError(403, 'Only an admin can do this');
};

// Requests anyone may make without logging in, and the only changes a viewer may make.
const PUBLIC = new Set(['POST /api/login', 'POST /api/logout']);
const VIEWER_MAY_POST = new Set(['POST /api/logout', 'POST /api/me/password']);

const routes = [
  // Login & users
  {
    method: 'POST',
    pattern: /^\/api\/login$/,
    handler: json(async (body, m, q, req) => {
      const { token, user } = await auth.login(body.username, body.password);
      return { __cookie: auth.sessionCookie(req, token), body: { user } };
    }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/logout$/,
    handler: async (req) => {
      await auth.logout(req);
      return { __cookie: auth.sessionCookie(req, null), body: { ok: true } };
    },
  },
  { method: 'GET', pattern: /^\/api\/me$/, handler: async (req) => req.user },
  { method: 'POST', pattern: /^\/api\/me\/password$/, handler: json((body, m, q, req) => auth.changeOwnPassword(req.user, body)) },
  {
    method: 'GET',
    pattern: /^\/api\/users$/,
    handler: async (req) => {
      adminOnly(req);
      return auth.listUsers();
    },
  },
  { method: 'POST', pattern: /^\/api\/users$/, handler: json((body) => auth.createUser(body)) },
  { method: 'PUT', pattern: /^\/api\/users\/(\d+)$/, handler: json((body, m, q, req) => auth.updateUser(m[1], body, req.user)) },
  { method: 'POST', pattern: /^\/api\/users\/(\d+)\/password$/, handler: json((body, m) => auth.resetPassword(m[1], body.password)) },
  { method: 'DELETE', pattern: /^\/api\/users\/(\d+)$/, handler: async (req, m) => auth.deleteUser(m[1], req.user) },

  { method: 'GET', pattern: /^\/api\/company$/, handler: async () => acct.getCompany() },
  {
    method: 'GET',
    pattern: /^\/api\/meta$/,
    handler: async () => ({
      company: await acct.getCompany(),
      currencies: acct.CURRENCIES,
      categories: acct.CATEGORIES,
      asset_types: Object.entries(assets.ASSET_TYPES).map(([key, t]) => ({ key, name: t.name })),
      entities: await acct.listEntities(),
      database: db.kind,
      // Only the temporary SQLite database on Vercel resets; Postgres keeps everything.
      demo_mode: Boolean(process.env.VERCEL) && db.kind === 'sqlite',
    }),
  },
  { method: 'GET', pattern: /^\/api\/entities$/, handler: async () => acct.listEntities() },

  // VAT codes
  { method: 'GET', pattern: /^\/api\/vat-codes$/, handler: async () => acct.listVatCodes() },
  { method: 'POST', pattern: /^\/api\/vat-codes$/, handler: json((body) => acct.createVatCode(body)) },
  { method: 'PUT', pattern: /^\/api\/vat-codes\/([^/]+)$/, handler: json((body, m) => acct.updateVatCode(decodeURIComponent(m[1]), body)) },

  // Cost centres
  { method: 'GET', pattern: /^\/api\/cost-centers$/, handler: async () => acct.listCostCenters() },
  { method: 'POST', pattern: /^\/api\/cost-centers$/, handler: json((body) => acct.createCostCenter(body)) },
  { method: 'PUT', pattern: /^\/api\/cost-centers\/([^/]+)$/, handler: json((body, m) => acct.updateCostCenter(m[1], body)) },

  // Periods
  { method: 'GET', pattern: /^\/api\/periods$/, handler: async () => acct.listPeriods() },
  { method: 'POST', pattern: /^\/api\/periods\/(\d{4}-\d{2})\/close$/, handler: async (req, m) => assets.closePeriod(m[1]) },
  { method: 'POST', pattern: /^\/api\/periods\/(\d{4}-\d{2})\/reopen$/, handler: async (req, m) => acct.setPeriodStatus(m[1], 'open') },

  // Fixed assets
  { method: 'GET', pattern: /^\/api\/assets$/, handler: async (req, m, q) => ({ assets: await assets.listAssets(q.get('entity')), depreciation: assets.getStatus() }) },
  { method: 'POST', pattern: /^\/api\/assets$/, handler: json((body) => assets.createAsset(body)) },
  {
    method: 'GET',
    pattern: /^\/api\/assets\/(\d+)$/,
    handler: async (req, m) => {
      const a = await assets.getAsset(Number(m[1]));
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
  {
    method: 'POST',
    pattern: /^\/api\/invoices$/,
    handler: json(async (body) => {
      const invoice = await acct.createInvoice(body);
      // Made from an uploaded PDF: attach it and let recognition learn from the final values.
      const learning = body.document_id ? await recognition.learnFromInvoice(body.document_id, invoice, body) : null;
      return { ...invoice, learning };
    }),
  },

  // Invoice recognition (uploaded PDFs)
  { method: 'POST', pattern: /^\/api\/recognition\/extract$/, handler: json((body, m, q, req) => recognition.recognise(body, req.user)) },
  { method: 'GET', pattern: /^\/api\/recognition\/profiles$/, handler: async () => recognition.listProfiles() },
  { method: 'DELETE', pattern: /^\/api\/recognition\/profiles\/(\d+)$/, handler: async (req, m) => recognition.forgetProfile(m[1]) },
  {
    method: 'GET',
    pattern: /^\/api\/documents\/(\d+)\/file$/,
    handler: async (req, m) => {
      const doc = await recognition.getDocument(m[1]);
      if (!doc) throw acct.httpError(404, 'Document not found');
      return { __file: { data: Buffer.from(doc.data), type: doc.content_type, name: doc.filename } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/invoices\/(\d+)$/,
    handler: async (req, m) => {
      const detail = await acct.invoiceDetail(Number(m[1]));
      if (!detail) throw acct.httpError(404, 'Invoice not found');
      return { ...detail, document: await recognition.documentForInvoice(Number(m[1])) };
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
  { method: 'PUT', pattern: /^\/api\/journals\/(\d+)$/, handler: json((body, m, q, req) => acct.editJournal(Number(m[1]), body, req.user.name)) },
  { method: 'POST', pattern: /^\/api\/journals$/, handler: json((body) => acct.createManualJournal(body)) },
  {
    method: 'GET',
    pattern: /^\/api\/journals\/(\d+)$/,
    handler: async (req, m) => {
      const j = await acct.getJournal(Number(m[1]));
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

  // VAT returns (HMRC, Making Tax Digital format)
  { method: 'GET', pattern: /^\/api\/vat\/calculate$/, handler: async (req, m, q) => vat.calculate({ entity_id: q.get('entity'), from: q.get('from'), to: q.get('to') }) },
  { method: 'GET', pattern: /^\/api\/vat\/returns$/, handler: async (req, m, q) => vat.listReturns(q.get('entity')) },
  { method: 'POST', pattern: /^\/api\/vat\/returns$/, handler: json((body, m, q, req) => vat.fileReturn(body, req.user.name)) },
  { method: 'GET', pattern: /^\/api\/vat\/returns\/(\d+)\/mtd$/, handler: async (req, m) => vat.mtdExport(m[1]) },

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
  { method: 'GET', pattern: /^\/api\/fx\/status$/, handler: async () => ({ latest: await fx.latestRates(), ...(await fx.getStatus()) }) },
  {
    method: 'POST',
    pattern: /^\/api\/fx\/refresh$/,
    handler: async () => {
      await fx.updateLatest();
      return { latest: await fx.latestRates(), ...(await fx.getStatus()) };
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
      const s = await bank.getStatement(Number(m[1]));
      if (!s) throw acct.httpError(404, 'Statement not found');
      return s;
    },
  },
  { method: 'POST', pattern: /^\/api\/bank\/lines\/(\d+)\/post$/, handler: json((body, m) => bank.postLine(Number(m[1]), body)) },
];

/** Request handler: a plain Node server locally/Render, a serverless function on Vercel (api/index.js). */
/** Database connectivity check; answers even while start-up (seeding) is still running. */
async function health() {
  const t = Date.now();
  await db.get('SELECT 1 AS ok');
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  const dbRegion = (url.match(/\.([a-z]+-[a-z]+-\d)\.aws\.neon\.tech/) || [])[1] || null;
  return { database: db.kind, query_ms: Date.now() - t, function_region: process.env.VERCEL_REGION || null, database_region: dbRegion };
}

async function handler(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  if (parsed.pathname === '/api/health') {
    try {
      return sendJson(res, 200, await health());
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }
  await ready;
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    // Everything except logging in needs a session; viewers may only read.
    const key = `${req.method} ${pathname}`;
    if (!PUBLIC.has(key)) {
      try {
        req.user = await auth.userFromRequest(req);
      } catch (err) {
        console.error(err);
        return sendJson(res, 500, { error: 'Internal server error' });
      }
      if (!req.user) return sendJson(res, 401, { error: 'Please log in' });
      if (req.method !== 'GET' && req.user.role !== 'admin' && !VIEWER_MAY_POST.has(key)) {
        return sendJson(res, 403, { error: 'You have view-only access: ask an admin to make changes' });
      }
    }
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      try {
        const result = await route.handler(req, match, parsed.searchParams);
        if (result && result.__file) {
          const f = result.__file;
          res.writeHead(200, {
            'Content-Type': f.type,
            'Content-Length': f.data.length,
            'Content-Disposition': `inline; filename="${String(f.name).replace(/[^\w.\- ]/g, '_')}"`,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          return res.end(f.data);
        }
        if (result && result.__cookie) {
          res.setHeader('Set-Cookie', result.__cookie);
          return sendJson(res, 200, result.body);
        }
        return sendJson(res, 200, result);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(err);
        // Server-side failures are almost always the database connection (e.g. while it wakes up).
        const message =
          status < 500 || err.code === 'COMMIT_UNKNOWN'
            ? err.message || 'Something went wrong'
            : 'The server could not reach the database just now. Please try again in a moment.';
        return sendJson(res, status, { error: message });
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(405);
  res.end('Method not allowed');
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  http.createServer(handler).listen(PORT, () => {
    console.log(`Northbridge Payables app listening on port ${PORT}`);
  });
}

module.exports = handler;

