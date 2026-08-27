/**
 * push.js — Web Push (VAPID) delivery for new chat messages.
 *
 * Why this exists: the client's chat poll only runs while the page is awake, so it can
 * never notify a phone whose screen is locked (iOS freezes the app's JS immediately).
 * A real push is the only thing that reaches a closed app — the browser's push service
 * wakes our service worker, which then draws the notification.
 *
 * Subscriptions live in data/push_subs.csv, one row per device. Nothing here ever throws:
 * sending a chat message must not fail because a push failed.
 */
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const { readCsv, writeCsv } = require('./csv');
const { DATA, file } = require('./paths');

const SUBS = file('push_subs');
const KEYFILE = path.join(DATA, 'vapid.json');
const COLS = ['email', 'name', 'endpoint', 'p256dh', 'auth', 'created'];

/**
 * VAPID keys identify this server to the push services. Env vars win (VAPID_PUBLIC /
 * VAPID_PRIVATE); otherwise we generate a pair once and keep it in the data folder.
 *
 * These keys MUST stay stable. Every subscription a phone creates is bound to the public
 * key that was live at the time — rotate the keys and every existing subscription becomes
 * permanently undeliverable, which looks exactly like "notifications just stopped working".
 * That is why the data folder has to be a persistent disk in production (see paths.js).
 */
function loadKeys() {
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
    return { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(KEYFILE, 'utf8'));
    if (saved.publicKey && saved.privateKey) return saved;
  } catch { /* first run, or the file was wiped — generate below */ }

  const keys = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(KEYFILE, JSON.stringify(keys, null, 2), 'utf8');
    console.log(`🔑 Generated new VAPID keys → ${KEYFILE}`);
  } catch (err) {
    console.error('Could not persist VAPID keys — notifications will drop on restart.', err);
  }
  return keys;
}

/**
 * The `sub` claim just has to be a real mailto:/https: URL the push service can complain
 * to. Google ignores it entirely; Apple VALIDATES it and answers 403 (BadJwtToken) if the
 * domain isn't routable — which shows up as "push works on Android, fails on iPhone".
 *
 * So never hand it a domain that cannot receive mail. That rules out the old
 * `@daffodils.local` placeholder AND the `@example.com` addresses the seed login.csv
 * ships with: a fresh disk starts from the seed, so accepting those would silently
 * reintroduce the exact 403 this function exists to prevent.
 *
 * Order: explicit env var → admin's email → any real member address → the app's own
 * https URL, which is always a valid contact address.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

// RFC 2606 / 6761 reserved names plus mDNS .local — all guaranteed undeliverable.
const FAKE_DOMAIN = /(^|\.)(example|invalid|test|localhost|local)$|(^|\.)example\.(com|net|org)$/i;

/** A contactable address: syntactically valid AND on a domain that really exists. */
function usableEmail(addr) {
  if (!EMAIL_RE.test(addr || '')) return false;
  return !FAKE_DOMAIN.test(String(addr).split('@')[1].trim());
}

function vapidSubject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  try {
    const rows = readCsv(file('login'));
    const admin = rows.find((u) => String(u.is_admin) === '1');
    if (admin && usableEmail(admin.email)) return `mailto:${admin.email}`;
    // Admin logs in with a bare username, so usually fall through to a member's address.
    const member = rows.find((u) => usableEmail(u.email));
    if (member) return `mailto:${member.email}`;
  } catch { /* no login.csv yet — fall through */ }
  // Render exposes the deployed URL; https subjects are as acceptable as mailto ones.
  const url = process.env.VAPID_SUBJECT_URL || process.env.RENDER_EXTERNAL_URL
    || (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`);
  if (url && /^https:\/\//i.test(url)) return url;
  return 'https://daffodils-buddies-savings-fund.onrender.com';
}

const KEYS = loadKeys();
webpush.setVapidDetails(vapidSubject(), KEYS.publicKey, KEYS.privateKey);

const publicKey = () => KEYS.publicKey;

const readSubs = () => readCsv(SUBS);
const writeSubs = (rows) => writeCsv(SUBS, rows, COLS);

/** Look a device up by its endpoint — used to carry identity across a re-subscribe. */
const findByEndpoint = (endpoint) => readSubs().find((r) => r.endpoint === endpoint) || null;

/** The endpoint is the device's unique address, so it doubles as the row's primary key. */
function save(user, sub) {
  if (!sub || !sub.endpoint || !sub.keys) return false;
  const rows = readSubs().filter((r) => r.endpoint !== sub.endpoint);
  rows.push({
    email: user.email,
    name: user.name,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh || '',
    auth: sub.keys.auth || '',
    created: new Date().toISOString(),
  });
  writeSubs(rows);
  return true;
}

function remove(endpoint) {
  const rows = readSubs();
  const kept = rows.filter((r) => r.endpoint !== endpoint);
  if (kept.length !== rows.length) writeSubs(kept);
  return rows.length - kept.length;
}

const toSubscription = (r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } });

/** Registered devices, for the admin panel. Never exposes the endpoint/keys themselves. */
function devices() {
  return readSubs().map((r) => ({
    name: r.name,
    email: r.email,
    created: r.created,
    // Enough to tell two of someone's phones apart without leaking the address.
    id: String(r.endpoint || '').slice(-8),
    service: (() => {
      try { return new URL(r.endpoint).hostname; } catch { return 'unknown'; }
    })(),
  }));
}

/**
 * Push `payload` to the given rows. Fire-and-forget: callers should NOT await this.
 * Endpoints the push service reports as gone (404/410 — app deleted, permission revoked)
 * are pruned so the file stays honest. Resolves to a small per-device report, which the
 * admin "send test" route uses to say what actually happened.
 */
function sendTo(targets, payload) {
  if (!targets.length) return Promise.resolve([]);
  const body = JSON.stringify(payload);

  return Promise.all(targets.map((r) =>
    webpush.sendNotification(toSubscription(r), body)
      .then(() => ({ name: r.name, ok: true, endpoint: r.endpoint }))
      .catch((err) => {
        const status = (err && err.statusCode) || 0;
        // The push service explains itself in the body ("BadJwtToken", "VapidPkHashMismatch"),
        // and that one word is the whole diagnosis — carry it through to the admin panel
        // instead of leaving it in a server log nobody can reach from a phone.
        const detail = String((err && err.body) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const reason = status === 404 || status === 410
          ? 'device unsubscribed (removed)'
          : `${status || 'error'}: ${detail || (err && err.message) || 'unknown'}`;
        // 404/410 = the browser threw the subscription away. Anything else is transient —
        // keep the row and try again next time.
        console.error(`Push to ${r.name} failed:`, reason, (err && err.body) || '');
        return { name: r.name, ok: false, reason, endpoint: r.endpoint, dead: status === 404 || status === 410 };
      })
  )).then((results) => {
    const gone = results.filter((x) => x.dead).map((x) => x.endpoint);
    if (gone.length) writeSubs(readSubs().filter((r) => !gone.includes(r.endpoint)));
    return results.map(({ name, ok, reason }) => ({ name, ok, reason }));
  }).catch(() => []); // never let push break a request
}

/** Push to every registered device except the sender's own. */
function notifyOthers(senderEmail, payload) {
  const from = String(senderEmail || '').toLowerCase();
  return sendTo(readSubs().filter((r) => String(r.email).toLowerCase() !== from), payload);
}

/** Push to every registered device, sender included — used by the admin's test button. */
const notifyAll = (payload) => sendTo(readSubs(), payload);

module.exports = { publicKey, save, remove, findByEndpoint, notifyOthers, notifyAll, devices, SUBS };
