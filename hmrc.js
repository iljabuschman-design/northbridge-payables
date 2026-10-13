'use strict';

/**
 * Direct connection to HMRC's Making Tax Digital VAT API.
 *
 *   1. Connect: the user signs in to the business's Government Gateway account on HMRC's
 *      own page (OAuth 2.0 authorization code flow) and grants this app read/write VAT access.
 *      Each entity has its own connection and VAT registration number.
 *   2. Obligations: the open VAT periods and their period keys come straight from HMRC.
 *   3. Submit: a return filed in the app is sent to HMRC with the fraud prevention headers
 *      HMRC requires; HMRC's receipt is stored with the return.
 *
 * Configuration (environment variables):
 *   HMRC_CLIENT_ID, HMRC_CLIENT_SECRET   from the application registered in the HMRC Developer Hub
 *   HMRC_ENV            "sandbox" (default, HMRC's test service) or "production"
 *   HMRC_REDIRECT_URI   optional; defaults to https://<this host>/api/hmrc/callback and must be
 *                       registered on the HMRC application
 *   HMRC_TOKEN_KEY      optional secret used to encrypt stored tokens (defaults to the client secret)
 *   HMRC_BASE_URL       optional override of the API host (testing)
 */

const crypto = require('crypto');
const { db, nowText } = require('./db');
const acct = require('./accounting');
const vat = require('./vat');
const pkg = require('./package.json');

const { httpError } = acct;

const SCOPE = 'read:vat write:vat';
const ACCEPT = 'application/vnd.hmrc.1.0+json';

const env = () => (process.env.HMRC_ENV === 'production' ? 'production' : 'sandbox');
const baseUrl = () => process.env.HMRC_BASE_URL || (env() === 'production' ? 'https://api.service.hmrc.gov.uk' : 'https://test-api.service.hmrc.gov.uk');
const configured = () => Boolean(process.env.HMRC_CLIENT_ID && process.env.HMRC_CLIENT_SECRET);

/** Tables for the connections and for sign-in attempts in progress; added to existing databases too. */
async function setUp() {
  await db.exec(`CREATE TABLE IF NOT EXISTS hmrc_connections (
    entity_id INTEGER PRIMARY KEY REFERENCES entities(id),
    vrn TEXT NOT NULL,
    environment TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    scope TEXT,
    connected_by TEXT,
    connected_at TEXT NOT NULL
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS hmrc_oauth_states (
    state TEXT PRIMARY KEY,
    entity_id INTEGER NOT NULL,
    vrn TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL
  )`);
  await db.addColumn('vat_returns', 'hmrc_submitted_at', 'TEXT');
  await db.addColumn('vat_returns', 'hmrc_environment', 'TEXT');
  await db.addColumn('vat_returns', 'hmrc_receipt', 'TEXT');
}

// ----- Token storage (encrypted at rest) -----

const key = () => crypto.createHash('sha256').update(process.env.HMRC_TOKEN_KEY || process.env.HMRC_CLIENT_SECRET || 'unconfigured').digest();

function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function unseal(blob) {
  try {
    const [iv, tag, data] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    throw httpError(400, 'The stored HMRC sign-in can no longer be read (the secret changed): connect to HMRC again');
  }
}

// ----- Talking to HMRC -----

/** HMRC answered with an error: show its code and message (always as a 400 so the text reaches the user). */
function hmrcError(res, body) {
  const detail = body && (body.message || body.error_description || body.error || (body.errors && body.errors.map((e) => e.message).join('; ')));
  const code = body && body.code ? `${body.code}: ` : '';
  const err = httpError(400, `HMRC refused the request (${res.status}): ${code}${detail || 'no details given'}`);
  err.hmrc = body;
  return err;
}

async function hmrcFetch(path, { method = 'GET', token, json, form, headers = {} } = {}) {
  const h = { Accept: ACCEPT, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let body;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(baseUrl() + path, { method, headers: h, body, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw httpError(400, `Could not reach HMRC (${err.message})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 300) };
  }
  if (!res.ok) throw hmrcError(res, data);
  return data || {};
}

function requireConfigured() {
  if (!configured()) {
    throw httpError(400, 'HMRC is not configured: set HMRC_CLIENT_ID and HMRC_CLIENT_SECRET (from your application in the HMRC Developer Hub) on the server');
  }
}

function redirectUri(req) {
  if (process.env.HMRC_REDIRECT_URI) return process.env.HMRC_REDIRECT_URI;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}/api/hmrc/callback`;
}

async function tokenRequest(form) {
  return hmrcFetch('/oauth/token', {
    method: 'POST',
    form: { client_id: process.env.HMRC_CLIENT_ID, client_secret: process.env.HMRC_CLIENT_SECRET, ...form },
  });
}

/** Application-level token (no user): for the sandbox test-user and header-check services. */
async function serverToken() {
  requireConfigured();
  return (await tokenRequest({ grant_type: 'client_credentials' })).access_token;
}

// ----- Connections -----

async function getConnection(entityId) {
  return db.get('SELECT * FROM hmrc_connections WHERE entity_id = ?', Number(entityId));
}

const cleanVrn = (v) => String(v || '').replace(/\s+/g, '').replace(/^GB/i, '');

async function status(entityId, req) {
  const e = acct.entityOf(entityId);
  const c = e ? await getConnection(e) : null;
  return {
    configured: configured(),
    environment: env(),
    redirect_uri: req ? redirectUri(req) : null,
    entity_id: e,
    connection: c
      ? { vrn: c.vrn, environment: c.environment, connected_by: c.connected_by, connected_at: c.connected_at, access_expires_at: c.expires_at, wrong_environment: c.environment !== env() }
      : null,
  };
}

/** Start signing in: returns the HMRC page the browser must go to. */
async function connect({ entity_id, vrn }, req, user) {
  requireConfigured();
  const entity = await acct.requireEntity(entity_id);
  vrn = cleanVrn(vrn);
  if (!/^\d{9}$/.test(vrn)) throw httpError(400, 'A VAT registration number has 9 digits');
  const state = crypto.randomBytes(24).toString('hex');
  const uri = redirectUri(req);
  await db.run('DELETE FROM hmrc_oauth_states WHERE created_at < ?', new Date(Date.now() - 3600000).toISOString().replace('T', ' ').slice(0, 19));
  await db.run('INSERT INTO hmrc_oauth_states (state, entity_id, vrn, redirect_uri, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', state, entity.id, vrn, uri, user ? user.name : null, nowText());
  const params = new URLSearchParams({ response_type: 'code', client_id: process.env.HMRC_CLIENT_ID, scope: SCOPE, state, redirect_uri: uri });
  return { url: `${baseUrl()}/oauth/authorize?${params}` };
}

/** HMRC sends the browser back here with a code; exchange it for tokens. Returns where to send the browser. */
async function callback(query) {
  const state = query.get('state');
  const row = state ? await db.get('SELECT * FROM hmrc_oauth_states WHERE state = ?', state) : null;
  if (!row) return '/?hmrc_error=' + encodeURIComponent('That HMRC sign-in has expired or was not started here: try connecting again') + '#vat';
  await db.run('DELETE FROM hmrc_oauth_states WHERE state = ?', state);
  if (query.get('error')) {
    const why = query.get('error_description') || query.get('error');
    return '/?hmrc_error=' + encodeURIComponent(`HMRC did not give access: ${why}`) + '#vat';
  }
  try {
    const t = await tokenRequest({ grant_type: 'authorization_code', code: query.get('code'), redirect_uri: row.redirect_uri });
    await saveTokens(row.entity_id, row.vrn, t, row.created_by);
  } catch (err) {
    return '/?hmrc_error=' + encodeURIComponent(err.message) + '#vat';
  }
  return '/?hmrc=connected#vat';
}

async function saveTokens(entityId, vrn, t, by) {
  const expires = new Date(Date.now() + (Number(t.expires_in) || 14400) * 1000).toISOString();
  await db.run('DELETE FROM hmrc_connections WHERE entity_id = ?', Number(entityId));
  await db.run(
    `INSERT INTO hmrc_connections (entity_id, vrn, environment, access_token, refresh_token, expires_at, scope, connected_by, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Number(entityId), vrn, env(), seal(t.access_token), seal(t.refresh_token), expires, Array.isArray(t.scope) ? t.scope.join(' ') : t.scope || SCOPE, by || null, nowText()
  );
}

async function disconnect({ entity_id }) {
  await db.run('DELETE FROM hmrc_connections WHERE entity_id = ?', Number(entity_id));
  return status(entity_id);
}

/** A valid access token for the entity, refreshed when it is about to expire. */
async function accessToken(entityId) {
  requireConfigured();
  const c = await getConnection(entityId);
  if (!c) throw httpError(400, 'This company is not connected to HMRC yet: connect it first');
  if (c.environment !== env()) throw httpError(400, `This connection was made with HMRC's ${c.environment} service but the app now uses ${env()}: connect again`);
  if (Date.parse(c.expires_at) - Date.now() > 60000) return { token: unseal(c.access_token), connection: c };
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(c.refresh_token) });
    await saveTokens(entityId, c.vrn, t, c.connected_by);
    return { token: t.access_token, connection: { ...c, vrn: c.vrn } };
  } catch (err) {
    throw httpError(400, `The HMRC sign-in has expired (${err.message}): connect again`);
  }
}

// ----- Fraud prevention headers (connection method WEB_APP_VIA_SERVER) -----

let vendorIpCache = null;
async function vendorIp() {
  if (process.env.HMRC_VENDOR_IP) return process.env.HMRC_VENDOR_IP;
  if (vendorIpCache && Date.now() - vendorIpCache.at < 3600000) return vendorIpCache.ip;
  try {
    const ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(3000) })).text()).trim();
    if (/^[0-9a-f.:]+$/i.test(ip)) {
      vendorIpCache = { ip, at: Date.now() };
      return ip;
    }
  } catch {
    /* the header is left out when the server's own address can't be found */
  }
  return null;
}

function clientIp(req) {
  const h = req.headers;
  const raw = h['x-vercel-forwarded-for'] || String(h['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '';
  return String(raw).trim().replace(/^::ffff:/, '');
}

const pairs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/** The headers HMRC asks for, from what the browser reported (client) and what the server sees. */
async function fraudHeaders(client = {}, req, user) {
  const ip = clientIp(req);
  const vIp = await vendorIp();
  const offset = Number(client.timezone_offset_minutes);
  const tz = Number.isFinite(offset)
    ? `UTC${offset <= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`
    : null;
  const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const h = {
    'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER',
    'Gov-Client-Browser-JS-User-Agent': client.user_agent || req.headers['user-agent'] || '',
    'Gov-Client-Device-ID': client.device_id || '',
    'Gov-Client-Public-IP': ip,
    'Gov-Client-Public-IP-Timestamp': new Date().toISOString(),
    'Gov-Client-Screens': pairs({ width: n(client.screen_width), height: n(client.screen_height), 'scaling-factor': n(client.pixel_ratio, 1), 'colour-depth': n(client.colour_depth, 24) }),
    'Gov-Client-Window-Size': pairs({ width: n(client.window_width), height: n(client.window_height) }),
    'Gov-Client-User-IDs': pairs({ northbridge: user ? user.username : 'unknown' }),
    'Gov-Vendor-Product-Name': encodeURIComponent('Northbridge Books'),
    'Gov-Vendor-Version': pairs({ 'northbridge-books': pkg.version || '1.0.0' }),
  };
  if (tz) h['Gov-Client-Timezone'] = tz;
  if (client.do_not_track !== undefined && client.do_not_track !== null) h['Gov-Client-Browser-Do-Not-Track'] = client.do_not_track ? 'true' : 'false';
  if (vIp) {
    h['Gov-Vendor-Public-IP'] = vIp;
    h['Gov-Vendor-Forwarded'] = pairs({ by: vIp, for: ip });
  }
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== '' && v !== undefined));
}

// ----- VAT API calls -----

/** Open (or fulfilled) VAT obligations of the connected company. */
async function obligations({ entity_id, status: st, from, to, client }, req, user) {
  const { token, connection } = await accessToken(entity_id);
  const q = new URLSearchParams();
  if (st === 'O' || st === 'F') q.set('status', st);
  if (st !== 'O') {
    const year = new Date().getUTCFullYear();
    q.set('from', from || `${year - 1}-01-01`);
    q.set('to', to || `${year}-12-31`);
  }
  const res = await hmrcFetch(`/organisations/vat/${connection.vrn}/obligations?${q}`, { token, headers: await fraudHeaders(client, req, user) });
  return {
    vrn: connection.vrn,
    environment: env(),
    obligations: (res.obligations || []).map((o) => ({
      period_key: o.periodKey, start: o.start, end: o.end, due: o.due, status: o.status, received: o.received || null,
    })),
  };
}

/** Send a filed return to HMRC and keep HMRC's receipt. */
async function submitReturn({ return_id, client, confirm_production }, req, user) {
  const r = await vat.getReturn(return_id);
  if (r.hmrc_submitted_at) throw httpError(400, `This return was already sent to HMRC on ${String(r.hmrc_submitted_at).slice(0, 16)}`);
  if (env() === 'production' && !confirm_production) throw httpError(400, 'This sends the return to HMRC for real: confirm to continue');
  const { token, connection } = await accessToken(r.entity_id);
  if (connection.vrn !== r.vrn) throw httpError(400, `This company is connected to HMRC with VAT number ${connection.vrn}, but the return is for ${r.vrn}`);
  const body = vat.mtdBody(r);
  const receipt = await hmrcFetch(`/organisations/vat/${r.vrn}/returns`, { method: 'POST', token, json: body, headers: await fraudHeaders(client, req, user) });
  await db.run('UPDATE vat_returns SET hmrc_submitted_at = ?, hmrc_environment = ?, hmrc_receipt = ? WHERE id = ?', nowText(), env(), JSON.stringify(receipt), r.id);
  return { return_id: r.id, environment: env(), receipt, submitted: body };
}

// ----- Sandbox helpers -----

function requireSandbox() {
  if (env() !== 'sandbox') throw httpError(400, 'This is only available on HMRC’s sandbox (test) service');
}

/** Create a test organisation with MTD VAT on HMRC's sandbox (a fake VAT number and Government Gateway user). */
async function createTestOrganisation() {
  requireSandbox();
  const token = await serverToken();
  const r = await hmrcFetch('/create-test-user/organisations', { method: 'POST', token, json: { serviceNames: ['mtd-vat'] } });
  return {
    user_id: r.userId,
    password: r.password,
    name: r.userFullName || (r.organisationDetails && r.organisationDetails.name) || null,
    vrn: r.vrn || null,
    raw_keys: Object.keys(r),
  };
}

/** Ask HMRC's test service whether the fraud prevention headers we send are acceptable. */
async function validateHeaders({ client }, req, user) {
  requireSandbox();
  const token = await serverToken();
  const headers = await fraudHeaders(client, req, user);
  try {
    return { sent: headers, valid: true, result: await hmrcFetch('/test/fraud-prevention-headers/validate', { token, headers }) };
  } catch (err) {
    if (err.hmrc) return { sent: headers, valid: false, result: err.hmrc };
    throw err;
  }
}

module.exports = {
  setUp, configured, status, connect, callback, disconnect, obligations, submitReturn, createTestOrganisation, validateHeaders, fraudHeaders,
};
