'use strict';

/**
 * Email inbox for supplier invoices: reads the Gmail mailbox over IMAP and
 * stores every PDF attachment as a document "waiting in the inbox". Processing
 * it in the app runs the same recognition as an upload.
 *
 * Needs GMAIL_USER (the address) and GMAIL_APP_PASSWORD (a Google app
 * password, which requires 2-Step Verification on the account). The mailbox
 * itself is only read: messages are not moved, deleted or marked as read. The
 * app remembers the highest message UID it has seen (per UIDVALIDITY), so each
 * email is imported once, even if someone reads it in Gmail first.
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('./db');
const acct = require('./accounting');

const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGES_PER_CHECK = 25;
const FIRST_CHECK_DAYS = 30;

const configured = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const address = () => process.env.GMAIL_USER || null;

async function state() {
  return (await db.get('SELECT * FROM mailbox_state WHERE id = 1')) || null;
}

async function saveState(fields) {
  const cur = await state();
  if (cur) {
    await db.run(
      'UPDATE mailbox_state SET uidvalidity = ?, last_uid = ?, last_check_at = ?, last_result = ? WHERE id = 1',
      fields.uidvalidity ?? cur.uidvalidity, fields.last_uid ?? cur.last_uid, fields.last_check_at ?? cur.last_check_at, fields.last_result ?? cur.last_result
    );
  } else {
    await db.run(
      'INSERT INTO mailbox_state (id, uidvalidity, last_uid, last_check_at, last_result) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
      fields.uidvalidity ?? null, fields.last_uid ?? 0, fields.last_check_at ?? null, fields.last_result ?? null
    );
  }
}

const isPdf = (a) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename || '');

/**
 * Store the PDF attachments of one raw email as inbox documents. Returns how
 * many were added; the same attachment of the same message is never stored twice.
 */
async function importMessage(source) {
  const mail = await simpleParser(source);
  const entity = (await acct.listEntities())[0];
  const messageId = mail.messageId || `${mail.date ? mail.date.toISOString() : ''}-${mail.subject || ''}`;
  const from = mail.from ? mail.from.text : null;
  let added = 0;
  const skipped = [];
  for (const a of mail.attachments || []) {
    if (!isPdf(a)) continue;
    const data = Buffer.from(a.content);
    if (data.length > MAX_PDF_BYTES) {
      skipped.push(`${a.filename} is larger than 3 MB`);
      continue;
    }
    if (data.subarray(0, 5).toString('latin1') !== '%PDF-') {
      skipped.push(`${a.filename} is not a real PDF`);
      continue;
    }
    const filename = String(a.filename || 'invoice.pdf').slice(0, 200);
    const { row } = await db.run(
      `INSERT INTO documents (entity_id, filename, content_type, size, data, source, status, email_from, email_subject, email_date, message_id)
       VALUES (?, ?, 'application/pdf', ?, ?, 'email', 'inbox', ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      entity.id, filename, data.length, data, from ? from.slice(0, 200) : null, (mail.subject || '').slice(0, 300), mail.date ? mail.date.toISOString().slice(0, 19).replace('T', ' ') : null, messageId.slice(0, 300)
    );
    if (row) added++;
  }
  return { added, skipped };
}

/** Check the mailbox for new emails and import their PDF attachments. */
async function checkMailbox() {
  if (!configured()) return { configured: false, added: 0 };
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
    socketTimeout: 20000,
  });
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let added = 0;
  let messages = 0;
  const skipped = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const box = client.mailbox;
      const st = await state();
      // A changed UIDVALIDITY means the mailbox was rebuilt: start again from recent mail.
      const fresh = !st || !st.uidvalidity || String(st.uidvalidity) !== String(box.uidValidity);
      let uids;
      if (fresh) {
        uids = await client.search({ since: new Date(Date.now() - FIRST_CHECK_DAYS * 86400000) }, { uid: true });
      } else {
        uids = await client.search({ uid: `${Number(st.last_uid) + 1}:*` }, { uid: true });
        uids = uids.filter((u) => u > Number(st.last_uid));
      }
      uids = (uids || []).sort((a, b) => a - b).slice(0, MAX_MESSAGES_PER_CHECK);
      let lastUid = fresh ? 0 : Number(st.last_uid);
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg && msg.source) {
          const r = await importMessage(msg.source);
          added += r.added;
          skipped.push(...r.skipped);
          messages++;
        }
        lastUid = Math.max(lastUid, uid);
      }
      await saveState({ uidvalidity: String(box.uidValidity), last_uid: lastUid, last_check_at: now, last_result: `${messages} new email(s), ${added} PDF(s) imported` });
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    const message = /auth|credential|password|login/i.test(err.message || '') || err.authenticationFailed
      ? 'Gmail refused the login: check the app password (and that 2-Step Verification is on)'
      : `Could not read the mailbox: ${err.message}`;
    await saveState({ last_check_at: now, last_result: message }).catch(() => {});
    try {
      await client.logout();
    } catch {
      /* already closed */
    }
    return { configured: true, added: 0, error: message };
  }
  return { configured: true, added, messages, skipped };
}

/** Check at most every `minutes`, e.g. when someone opens the purchase invoices page. */
async function checkIfDue(minutes = 2) {
  if (!configured()) return { configured: false, added: 0 };
  const st = await state();
  if (st && st.last_check_at && Date.now() - Date.parse(`${st.last_check_at.replace(' ', 'T')}Z`) < minutes * 60000) {
    return { configured: true, added: 0, skipped_check: true };
  }
  return checkMailbox();
}

async function listInbox() {
  const docs = await db.all(
    `SELECT d.id, d.filename, d.size, d.email_from, d.email_subject, d.email_date, d.created_at, e.code AS entity_code
     FROM documents d JOIN entities e ON e.id = d.entity_id
     WHERE d.status = 'inbox' ORDER BY d.id DESC`
  );
  const st = await state();
  return {
    configured: configured(),
    address: address(),
    last_check_at: st ? st.last_check_at : null,
    last_result: st ? st.last_result : null,
    documents: docs,
  };
}

async function dismiss(id) {
  await db.run("UPDATE documents SET status = 'dismissed' WHERE id = ? AND status = 'inbox'", Number(id));
  return { ok: true };
}

module.exports = { checkMailbox, checkIfDue, importMessage, listInbox, dismiss, configured };
