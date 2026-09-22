'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const acct = require('./accounting');
const { seedIfEmpty } = require('./seed');

seedIfEmpty();

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
      if (size > 1_000_000) {
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

const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/company$/,
    handler: async () => acct.getCompany(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/suppliers$/,
    handler: async () => acct.listSuppliers(),
  },
  {
    method: 'POST',
    pattern: /^\/api\/suppliers$/,
    handler: async (req) => {
      const body = await readBody(req);
      if (!body.name || !body.currency) throw acct.httpError(400, 'name and currency are required');
      return acct.createSupplier(body);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/invoices$/,
    handler: async () => acct.listInvoices(),
  },
  {
    method: 'POST',
    pattern: /^\/api\/invoices$/,
    handler: async (req) => {
      const body = await readBody(req);
      return acct.createInvoice(body);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/invoices\/(\d+)$/,
    handler: async (req, match) => {
      const id = Number(match[1]);
      const invoice = acct.getInvoice(id);
      if (!invoice) throw acct.httpError(404, 'Invoice not found');
      const payments = acct.listPaymentsForInvoice(id);
      const ledger = acct.listLedgerEntries({ source_type: 'invoice', source_id: id });
      const paymentLedger = payments.flatMap((p) => acct.listLedgerEntries({ source_type: 'payment', source_id: p.id }));
      return { invoice, payments, ledger: [...ledger, ...paymentLedger] };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/invoices\/(\d+)\/payments$/,
    handler: async (req, match) => {
      const body = await readBody(req);
      body.invoice_id = Number(match[1]);
      return acct.createPayment(body);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ledger$/,
    handler: async () => acct.listLedgerEntries(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/trial-balance$/,
    handler: async () => acct.trialBalance(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/dashboard$/,
    handler: async () => acct.dashboardSummary(),
  },
];

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      try {
        const result = await route.handler(req, match);
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

