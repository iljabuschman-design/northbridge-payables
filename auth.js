'use strict';

/**
 * Users, passwords and login sessions.
 *   admin:  everything, including managing users
 *   viewer: can see everything, change nothing (the server refuses every
 *           non-GET request from a viewer except logging out and changing
 *           their own password)
 * Passwords are stored as scrypt hashes; sessions as a SHA-256 hash of a random
 * token kept in an HttpOnly cookie. After 5 wrong passwords an account is
 * locked for 15 minutes.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { db, nowText } = require('./db');

const scrypt = promisify(crypto.scrypt);
const ROLES = ['admin', 'viewer'];
const SESSION_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const COOKIE = 'nb_session';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const textAfter = (minutes) => new Date(Date.now() + minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw httpError(400, 'A password needs at least 10 characters');
}

const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name, role: u.role, last_login_at: u.last_login_at, created_at: u.created_at };

/**
 * Create the admin and viewer users on an empty users table. Their first
 * passwords come from ADMIN_PASSWORD / VIEWER_PASSWORD; only when running
 * locally (not on Vercel) there are simple defaults for convenience.
 */
async function ensureDefaultUsers() {
  if ((await db.get('SELECT COUNT(*) AS n FROM users')).n > 0) return;
  const local = !process.env.VERCEL;
  const defaults = [
    { username: 'admin', name: 'Administrator', role: 'admin', password: process.env.ADMIN_PASSWORD || (local ? 'admin-local-1' : null) },
    { username: 'viewer', name: 'Viewer', role: 'viewer', password: process.env.VIEWER_PASSWORD || (local ? 'viewer-local-1' : null) },
  ];
  for (const u of defaults) {
    if (!u.password) {
      console.error(`No password set for user "${u.username}" (set ${u.role.toUpperCase()}_PASSWORD); user not created`);
      continue;
    }
    await db.run('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?) ON CONFLICT (username) DO NOTHING', u.username, u.name, u.role, await hashPassword(u.password));
  }
  if (local) console.log('Local users: admin / admin-local-1 and viewer / viewer-local-1');
}

async function login(username, password) {
  const user = await db.get('SELECT * FROM users WHERE username = ?', String(username || '').trim().toLowerCase());
  const now = nowText();
  if (user && user.locked_until && user.locked_until > now) {
    throw httpError(429, `Too many wrong passwords - try again after ${user.locked_until.slice(11, 16)} UTC`);
  }
  // Check the password even for unknown users, so the answer takes as long either way.
  const ok = await verifyPassword(String(password || ''), user ? user.password_hash : 'scrypt$00$00');
  if (!user || !ok) {
    if (user) {
      const failed = user.failed_attempts + 1;
      await db.run(
        'UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?',
        failed >= MAX_FAILED ? 0 : failed,
        failed >= MAX_FAILED ? textAfter(LOCK_MINUTES) : null,
        user.id
      );
    }
    throw httpError(401, 'Wrong username or password');
  }
  await db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now, user.id);
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), user.id, textAfter(SESSION_DAYS * 24 * 60));
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  return { token, user: publicUser(user) };
}

function tokenFrom(req) {
  const cookies = Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
  );
  return cookies[COOKIE] || null;
}

async function userFromRequest(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const row = await db.get(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    sha256(token),
    nowText()
  );
  return publicUser(row);
}

async function logout(req) {
  const token = tokenFrom(req);
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

function sessionCookie(req, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL ? '; Secure' : '';
  return token
    ? `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
    : `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

// ---------- User management (admin) ----------

async function listUsers() {
  return (await db.all('SELECT * FROM users ORDER BY id')).map(publicUser);
}

async function createUser({ username, name, role, password }) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw httpError(400, 'Username: 3-30 letters, digits, dots, dashes or underscores');
  if (!String(name || '').trim()) throw httpError(400, 'Name is required');
  if (!ROLES.includes(role)) throw httpError(400, 'Role must be admin or viewer');
  checkPassword(password);
  if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) throw httpError(400, `User ${username} already exists`);
  const { row } = await db.run('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)', username, String(name).trim(), role, await hashPassword(password));
  return publicUser(row);
}

async function adminCount() {
  return (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")).n;
}

async function updateUser(id, { name, role }, actingUser) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!user) throw httpError(404, 'User not found');
  if (role !== undefined && !ROLES.includes(role)) throw httpError(400, 'Role must be admin or viewer');
  if (role === 'viewer' && user.role === 'admin' && (await adminCount()) <= 1) throw httpError(400, 'There must always be at least one admin');
  if (role === 'viewer' && user.id === actingUser.id) throw httpError(400, "You can't take away your own admin rights");
  await db.run('UPDATE users SET name = ?, role = ? WHERE id = ?', name !== undefined ? String(name).trim() || user.name : user.name, role || user.role, user.id);
  // A changed role takes effect immediately: end the user's sessions.
  if (role && role !== user.role) await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  return publicUser(await db.get('SELECT * FROM users WHERE id = ?', user.id));
}

async function resetPassword(id, password) {
  checkPassword(password);
  const user = await db.get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!user) throw httpError(404, 'User not found');
  await db.run('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', await hashPassword(password), user.id);
  await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  return publicUser(user);
}

async function deleteUser(id, actingUser) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!user) throw httpError(404, 'User not found');
  if (user.id === actingUser.id) throw httpError(400, "You can't remove yourself");
  if (user.role === 'admin' && (await adminCount()) <= 1) throw httpError(400, 'There must always be at least one admin');
  await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  await db.run('DELETE FROM users WHERE id = ?', user.id);
  return { deleted: user.username };
}

async function changeOwnPassword(actingUser, { current_password, new_password }) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', actingUser.id);
  if (!(await verifyPassword(String(current_password || ''), user.password_hash))) throw httpError(400, 'Current password is wrong');
  checkPassword(new_password);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(new_password), user.id);
  return { ok: true };
}

module.exports = {
  ROLES,
  ensureDefaultUsers,
  login,
  logout,
  userFromRequest,
  sessionCookie,
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  deleteUser,
  changeOwnPassword,
};
