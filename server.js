/**
 * server.js — Daffodils Buddies Savings Fund
 *
 * Serves the static frontend and a small JSON API backed by CSV files in data/.
 * Auth is intentionally light (UI delight > security, per the brief): a login returns a
 * token that is just the user's email; the client stores it and sends it back via the
 * `x-user` header. The server looks the user up in login.csv to know who they are / if
 * they're the admin. Good enough for four friends; do not treat as real security.
 */
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const express = require('express');
const multer = require('multer');

const { readCsv, writeCsv, appendCsv, initGoogleStorage } = require('./lib/csv');
const googleStorage = require('./lib/google-storage');
const blobStorage = require('./lib/blob-storage');
const { DATA, UPLOADS, PERSISTENT, file, bootstrap } = require('./lib/paths');

// Must run before anything reads or writes data: on a fresh persistent disk this copies
// the seed files (logins, rule votes) across. lib/push reads login.csv when it loads,
// so it is required *after* this line on purpose.
const boot = googleStorage.configured() ? { seeded: [] } : bootstrap();

const { computeRules, OVERRIDES } = require('./lib/rules');
const { computeSummary } = require('./lib/fund');
const push = require('./lib/push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Inline viewing/streaming. express.static honours Range requests, which is what lets
// <video>/<audio> seek (and what iOS Safari requires before it will play at all).
if (!blobStorage.configured()) {
  app.use('/uploads', express.static(UPLOADS, { acceptRanges: true, maxAge: '7d' }));
} else {
  app.get('/uploads/:file', (req, res) => {
    res.status(404).send('Legacy local upload not found.');
  });
}

/**
 * Force-download any upload, restoring its original filename.
 * The <a download> attribute alone is unreliable across mobile browsers, so we set
 * Content-Disposition server-side. `?name=` is the pretty name to save as.
 */
app.get('/download/:file', (req, res) => {
  if (blobStorage.configured()) return res.status(404).send('Legacy upload not found.');
  const stored = path.basename(req.params.file);            // never escape UPLOADS
  const full = path.join(UPLOADS, stored);
  if (!fs.existsSync(full)) return res.status(404).send('File not found.');
  const pretty = path.basename(String(req.query.name || stored)).replace(/["\\]/g, '');
  res.download(full, pretty);
});

// ---- CSV column definitions (write order) -------------------------------
const COLS = {
  // `reset_request` holds the ISO time a member asked for a reset. Passwords are never
  // shown to anyone but their owner — the admin's only power is to blank one.
  login: ['email', 'name', 'password', 'is_admin', 'reset_request'],
  investments: ['id', 'member', 'amount', 'date'],
  loans: ['id', 'member', 'amount', 'date', 'purpose', 'status', 'due_date'],
  donations: ['id', 'organization', 'amount', 'date', 'link', 'type'],
  posts: ['id', 'member', 'text', 'image', 'timestamp'],
  chat: ['id', 'member', 'text', 'media', 'media_type', 'media_name', 'media_size', 'reply_to', 'timestamp'],
  photos: ['id', 'member', 'filename', 'caption', 'timestamp'],
  overrides: ['rule_key', 'final_value'],
  push_subs: ['email', 'name', 'endpoint', 'p256dh', 'auth', 'created'],
};

/**
 * Drop the legacy `temp_password` column the first time we run against an older
 * login.csv. It used to hold a member's proposed new password in plain text, which the
 * admin then read and approved — exactly what we no longer want to exist anywhere.
 */
function migrateLogin() {
  const raw = readCsv(file('login'));
  if (!raw.length || !('temp_password' in raw[0])) return;
  writeCsv(file('login'), raw.map((u) => ({
    ...u,
    // A pending request survives the migration as a request; the proposal itself is dropped.
    reset_request: u.reset_request || (u.temp_password ? new Date().toISOString() : ''),
  })), COLS.login);
  console.log('🔒 login.csv migrated — plain-text password requests removed.');
}
if (!googleStorage.configured()) migrateLogin();

const storageReady = googleStorage.configured()
  ? initGoogleStorage(COLS).catch((error) => {
    console.error('Google storage initialization failed:', error.message);
    throw error;
  })
  : Promise.resolve();

app.use('/api', async (_req, res, next) => {
  try {
    await storageReady;
    next();
  } catch {
    res.status(503).json({ error: 'Data storage is temporarily unavailable.' });
  }
});

function nextId(rows) {
  return rows.reduce((max, r) => Math.max(max, parseInt(r.id, 10) || 0), 0) + 1;
}

// Chat keeps only the last 7 days. Older rows (and their uploaded media) are pruned.
const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function pruneChat() {
  const rows = readCsv(file('chat'));
  const now = Date.now();
  const keep = [], drop = [];
  for (const r of rows) {
    const t = Date.parse(r.timestamp);
    if (!isNaN(t) && now - t > CHAT_TTL_MS) drop.push(r);
    else keep.push(r);
  }
  if (drop.length) {
    writeCsv(file('chat'), keep, COLS.chat);
    for (const r of drop) {
      if (!r.media) continue;
      if (blobStorage.configured()) blobStorage.remove(r.media).catch(() => {});
      else try { fs.unlinkSync(path.join(UPLOADS, path.basename(r.media))); } catch { /* already gone */ }
    }
  }
  return keep;
}

// ---- auth helpers -------------------------------------------------------
function findUser(identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  return readCsv(file('login')).find((u) => u.email.toLowerCase() === id);
}

/** Resolve the requesting user from the x-user header. Returns the login row or null. */
function currentUser(req) {
  const header = req.get('x-user');
  return header ? findUser(header) : null;
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user || String(user.is_admin) !== '1') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

function publicUser(u) {
  return { email: u.email, name: u.name, isAdmin: String(u.is_admin) === '1' };
}

const linkPreviewCache = new Map();
const LINK_PREVIEW_TTL = 10 * 60 * 1000;

function isPrivateAddress(address) {
  return address === '::1' || address === 'localhost'
    || /^127\./.test(address) || /^10\./.test(address)
    || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
    || /^169\.254\./.test(address) || /^fc00:/i.test(address)
    || /^fe80:/i.test(address);
}

async function isPublicUrl(value) {
  let target;
  try { target = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol)) return null;
  if (isPrivateAddress(target.hostname.toLowerCase())) return null;
  try {
    const addresses = await dns.lookup(target.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) return null;
  } catch { return null; }
  return target;
}

function metaContent(html, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escapedKey}["'][^>]+content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapedKey}["']`, 'i'));
  return match ? match[1].trim() : '';
}

function decodeHtml(value) {
  return String(value || '').replace(/&(?:amp|#38);/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

app.get('/api/link-preview', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  const target = await isPublicUrl(req.query.url);
  if (!target) return res.status(400).json({ error: 'Only public http(s) URLs are supported.' });
  const key = target.href;
  const cached = linkPreviewCache.get(key);
  if (cached && Date.now() - cached.time < LINK_PREVIEW_TTL) return res.json(cached.data);

  try {
    const response = await fetch(key, {
      headers: { 'user-agent': 'DaffodilsLinkPreview/1.0' },
      redirect: 'follow', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) throw new Error('Not HTML');
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 1024 * 1024) throw new Error('Response too large');
    const html = (await response.text()).slice(0, 1024 * 1024);
    const data = {
      url: key,
      title: decodeHtml(metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || target.hostname),
      description: decodeHtml(metaContent(html, 'og:description') || metaContent(html, 'twitter:description')),
      image: metaContent(html, 'og:image') || metaContent(html, 'twitter:image'),
      site: decodeHtml(metaContent(html, 'og:site_name') || target.hostname),
    };
    if (data.image) data.image = new URL(data.image, response.url || key).href;
    linkPreviewCache.set(key, { time: Date.now(), data });
    res.json(data);
  } catch {
    const data = { url: key, title: target.hostname, description: '', image: '', site: target.hostname };
    linkPreviewCache.set(key, { time: Date.now(), data });
    res.json(data);
  }
});

// ---- auth routes --------------------------------------------------------

/**
 * Login flow (per the brief):
 *  - Look the user up by email (or admin username).
 *  - If they have no password yet, the password they send becomes their password.
 *  - Otherwise it must match.
 */
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = findUser(email);
  if (!user) return res.status(404).json({ error: 'Email not found. Ask the admin to add you.' });

  const users = readCsv(file('login'));
  const row = users.find((u) => u.email.toLowerCase() === user.email.toLowerCase());

  if (!row.password) {
    // First-time login (or straight after an admin reset): the password they send sticks.
    if (!password) return res.status(400).json({ error: 'Set a password to continue.', firstTime: true });
    row.password = password;
    row.reset_request = '';   // whatever they asked for, they've now got.
    writeCsv(file('login'), users, COLS.login);
    return res.json({ user: publicUser(row), token: row.email, message: 'Password set. Welcome!' });
  }

  if (password !== row.password) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  res.json({ user: publicUser(row), token: row.email });
});

/** Tell the client whether an email exists and whether it still needs a first password. */
app.post('/api/check-email', (req, res) => {
  const user = findUser((req.body || {}).email);
  if (!user) return res.status(404).json({ error: 'Email not found.' });
  res.json({ exists: true, firstTime: !user.password, name: user.name });
});

/**
 * Forgot password: flag that this member wants a reset. Nothing secret is submitted and
 * nothing secret comes back — the admin can only clear the old password, after which the
 * member picks a fresh one themselves on their next login.
 */
app.post('/api/forgot', (req, res) => {
  const { email } = req.body || {};
  const users = readCsv(file('login'));
  const row = users.find((u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase());
  if (!row) return res.status(404).json({ error: 'Email not found.' });
  row.reset_request = new Date().toISOString();
  writeCsv(file('login'), users, COLS.login);
  res.json({ message: 'Reset requested. Once the admin approves it, log in and choose a new password.' });
});

// ---- read routes --------------------------------------------------------
app.get('/api/summary', (_req, res) => res.json(computeSummary()));
app.get('/api/rules', (_req, res) => res.json(computeRules()));
app.get('/api/investments', (_req, res) => res.json(readCsv(file('investments'))));
app.get('/api/loans', (_req, res) => res.json(readCsv(file('loans'))));
app.get('/api/donations', (_req, res) => res.json(readCsv(file('donations'))));
app.get('/api/members', (_req, res) =>
  res.json(readCsv(file('login')).filter((u) => String(u.is_admin) !== '1').map((u) => u.name)));

/** Everyone who can appear in the chat (members + admin) — powers @mention autocomplete. */
app.get('/api/people', (_req, res) =>
  res.json(readCsv(file('login')).map((u) => u.name).filter(Boolean)));

// ---- community routes ---------------------------------------------------
app.get('/api/posts', (_req, res) =>
  res.json(readCsv(file('posts')).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))));

app.post('/api/posts', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  const { text, image } = req.body || {};
  if (!text && !image) return res.status(400).json({ error: 'Write something or add a photo.' });
  const rows = readCsv(file('posts'));
  const post = {
    id: nextId(rows), member: user.name, text: text || '',
    image: image || '', timestamp: new Date().toISOString(),
  };
  appendCsv(file('posts'), post, COLS.posts);
  res.json(post);
});

/**
 * Chat history, oldest first. `?since=<id>` returns only messages newer than that id,
 * which is what the client's live-poll uses so it doesn't re-download the whole thread.
 */
app.get('/api/chat', (req, res) => {
  const all = pruneChat().sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const since = parseInt(req.query.since, 10);
  res.json(isNaN(since) ? all : all.filter((m) => (parseInt(m.id, 10) || 0) > since));
});

/** One-line preview of a message — mirrors describe() in public/js/chatlive.js. */
function preview(msg) {
  if (msg.text) return msg.text.slice(0, 120);
  return { image: '📷 Photo', video: '🎬 Video', audio: '🎙 Voice message', file: '📎 File' }[msg.media_type]
    || 'New message';
}

/** Names this message @mentions, so the service worker can personalise the title. */
function mentionedNames(text) {
  const body = String(text || '');
  const names = readCsv(file('login')).map((u) => u.name).filter(Boolean);
  if (/@all(?![\w])/i.test(body)) return names;
  return names.filter((name) => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(body));
}

/**
 * Wake everyone else's phone. Deliberately not awaited: a push service being slow or down
 * must never delay (or fail) the message the user just sent.
 */
function pushChat(sender, msg) {
  push.notifyOthers(sender.email, {
    member: msg.member,
    body: preview(msg),
    mentions: mentionedNames(msg.text),
    url: '/index.html',
  });
}

app.post('/api/chat', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  const { text, reply_to } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Message is empty.' });
  const rows = pruneChat();
  const msg = {
    id: nextId(rows), member: user.name, text,
    media: '', media_type: '', media_name: '', media_size: '',
    reply_to: reply_to || '', timestamp: new Date().toISOString(),
  };
  appendCsv(file('chat'), msg, COLS.chat);
  res.json(msg);
  pushChat(user, msg);
});

// ---- push notification routes -------------------------------------------

/** The VAPID public key the browser needs before it can create a subscription. */
app.get('/api/push/key', (_req, res) => res.json({ key: push.publicKey() }));

/**
 * Register this device so the server can reach it while the app is closed.
 * Normally identified by the x-user header. The service worker has no access to the
 * stored token, so when it renews an expired subscription it sends `oldEndpoint` instead
 * and we inherit the owner from the row being replaced.
 */
app.post('/api/push/subscribe', (req, res) => {
  const { subscription, oldEndpoint } = req.body || {};
  const user = currentUser(req) || (oldEndpoint ? push.findByEndpoint(oldEndpoint) : null);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  if (!push.save(user, subscription)) {
    return res.status(400).json({ error: 'Invalid subscription.' });
  }
  if (oldEndpoint && oldEndpoint !== subscription.endpoint) push.remove(oldEndpoint);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required.' });
  res.json({ ok: true, removed: push.remove(endpoint) });
});

// Skip rows whose upload is gone (e.g. the folder was cleared) — a broken image
// in the memories banner looks far worse than one fewer slide.
app.get('/api/photos', (_req, res) =>
  res.json(readCsv(file('photos'))
    .filter((p) => p.filename && (blobStorage.configured()
      ? /^https:\/\//i.test(p.filename)
      : fs.existsSync(path.join(UPLOADS, path.basename(p.filename)))))
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))));

// ---- uploads ------------------------------------------------------------
const storage = blobStorage.configured() ? multer.memoryStorage() : multer.diskStorage({
  destination: UPLOADS,
  filename: (_req, f, cb) => {
    const safe = f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, f, cb) => cb(null, /^image\//.test(f.mimetype)),
});

// Chat accepts any attachment: photo, audio, video or an arbitrary file
// (bigger cap for short clips and documents).
const chatMedia = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

async function uploadToBlob(req, res, next) {
  if (!blobStorage.configured() || !req.file) return next();
  try {
    const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const saved = await blobStorage.upload(req.file.buffer, `${Date.now()}_${safe}`, req.file.mimetype);
    req.file.filename = saved.url;
    req.file.size = saved.size;
    next();
  } catch (error) {
    res.status(502).json({ error: `Could not save upload: ${error.message}` });
  }
}

/**
 * Classify an upload for rendering. Anything that isn't playable/viewable inline
 * is treated as a generic 'file' and shown as a download card.
 */
function mediaKind(mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^video\//.test(mime)) return 'video';
  return 'file';
}

/** Send a chat message carrying a photo / audio / video / file (and optional caption). */
app.post('/api/chat/media', chatMedia.single('media'), uploadToBlob, (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const rows = pruneChat();
  const msg = {
    id: nextId(rows), member: user.name,
    text: (req.body && req.body.text) || '',
    media: req.file.filename, media_type: mediaKind(req.file.mimetype),
    media_name: req.file.originalname || req.file.filename,
    media_size: req.file.size || '',
    reply_to: (req.body && req.body.reply_to) || '', timestamp: new Date().toISOString(),
  };
  appendCsv(file('chat'), msg, COLS.chat);
  res.json(msg);
  pushChat(user, msg);
});

app.post('/api/photos', upload.single('photo'), uploadToBlob, (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  const rows = readCsv(file('photos'));
  const photo = {
    id: nextId(rows), member: user.name, filename: req.file.filename,
    caption: (req.body && req.body.caption) || '', timestamp: new Date().toISOString(),
  };
  appendCsv(file('photos'), photo, COLS.photos);
  res.json({ ...photo, url: blobStorage.configured() ? photo.filename : `/uploads/${photo.filename}` });
});

// Also allow attaching an uploaded image to a post in one call.
app.post('/api/posts/photo', upload.single('photo'), uploadToBlob, (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  const rows = readCsv(file('posts'));
  const post = {
    id: nextId(rows), member: user.name, text: (req.body && req.body.text) || '',
    image: req.file ? (blobStorage.configured() ? req.file.filename : `/uploads/${req.file.filename}`) : '',
  };
  appendCsv(file('posts'), post, COLS.posts);
  res.json(post);
});

// ---- admin routes -------------------------------------------------------
app.post('/api/admin/investment', requireAdmin, (req, res) => {
  const { member, amount, date } = req.body || {};
  if (!member || !amount) return res.status(400).json({ error: 'Member and amount are required.' });
  const rows = readCsv(file('investments'));
  const row = { id: nextId(rows), member, amount, date: date || new Date().toISOString().slice(0, 10) };
  appendCsv(file('investments'), row, COLS.investments);
  res.json(row);
});

app.post('/api/admin/loan', requireAdmin, (req, res) => {
  const { member, amount, date, purpose, status, due_date } = req.body || {};
  if (!member || !amount) return res.status(400).json({ error: 'Member and amount are required.' });
  const rows = readCsv(file('loans'));
  const row = {
    id: nextId(rows), member, amount,
    date: date || new Date().toISOString().slice(0, 10),
    purpose: purpose || '', status: status || 'outstanding', due_date: due_date || '',
  };
  appendCsv(file('loans'), row, COLS.loans);
  res.json(row);
});

app.post('/api/admin/donation', requireAdmin, (req, res) => {
  const { organization, amount, date, link, type } = req.body || {};
  if (!organization || !amount) return res.status(400).json({ error: 'Organization and amount are required.' });
  const rows = readCsv(file('donations'));
  const row = {
    id: nextId(rows), organization, amount,
    date: date || new Date().toISOString().slice(0, 10),
    link: link || '', type: type || 'general',
  };
  appendCsv(file('donations'), row, COLS.donations);
  res.json(row);
});

/** Delete a ledger row (investment / loan / donation) by id. */
function deleteRow(name, cols) {
  return (req, res) => {
    const id = String(req.params.id);
    const rows = readCsv(file(name));
    const kept = rows.filter((r) => String(r.id) !== id);
    if (kept.length === rows.length) return res.status(404).json({ error: 'Record not found.' });
    writeCsv(file(name), kept, cols);
    res.json({ ok: true, removed: id });
  };
}
app.delete('/api/admin/investment/:id', requireAdmin, deleteRow('investments', COLS.investments));
app.delete('/api/admin/loan/:id', requireAdmin, deleteRow('loans', COLS.loans));
app.delete('/api/admin/donation/:id', requireAdmin, deleteRow('donations', COLS.donations));

/** Remove uploaded files referenced by a set of rows (best-effort). */
function unlinkFiles(rows, pick) {
  for (const r of rows) {
    const ref = pick(r);
    if (!ref) continue;
    if (blobStorage.configured()) blobStorage.remove(ref).catch(() => {});
    else try { fs.unlinkSync(path.join(UPLOADS, path.basename(ref))); } catch { /* already gone */ }
  }
}

/** Clear an entire community collection (chat / posts / photos) and its media. */
function clearCollection(name, cols, pick) {
  return (_req, res) => {
    const rows = readCsv(file(name));
    writeCsv(file(name), [], cols);
    if (pick) unlinkFiles(rows, pick);
    res.json({ ok: true, cleared: rows.length });
  };
}
app.delete('/api/admin/chat', requireAdmin, clearCollection('chat', COLS.chat, (r) => r.media));
app.delete('/api/admin/posts', requireAdmin, clearCollection('posts', COLS.posts, (r) => r.image));
app.delete('/api/admin/photos', requireAdmin, clearCollection('photos', COLS.photos, (r) => r.filename));

/** Set (or clear) the admin-decided winner for a rule. Empty value removes the override. */
app.post('/api/admin/rule-override', requireAdmin, (req, res) => {
  const { rule_key, final_value } = req.body || {};
  if (!rule_key) return res.status(400).json({ error: 'rule_key is required.' });
  const rows = readCsv(OVERRIDES);
  const existing = rows.find((r) => r.rule_key === rule_key);
  if (final_value === '' || final_value == null) {
    const filtered = rows.filter((r) => r.rule_key !== rule_key);
    writeCsv(OVERRIDES, filtered, COLS.overrides);
  } else if (existing) {
    existing.final_value = final_value;
    writeCsv(OVERRIDES, rows, COLS.overrides);
  } else {
    rows.push({ rule_key, final_value });
    writeCsv(OVERRIDES, rows, COLS.overrides);
  }
  res.json({ ok: true, rules: computeRules() });
});

/**
 * List every member (not the admin) for the admin panel.
 * Passwords are deliberately NOT included — not even the admin gets to read them. The
 * only lever here is a reset, which blanks the password so its owner picks a new one.
 */
app.get('/api/admin/members', requireAdmin, (_req, res) => {
  res.json(readCsv(file('login')).filter((u) => String(u.is_admin) !== '1')
    .map((u) => ({
      email: u.email,
      name: u.name,
      hasPassword: !!u.password,
      resetRequested: u.reset_request || '',
    })));
});

/** Set a member's login email (e.g. replacing a placeholder with their real one). */
app.post('/api/admin/member-email', requireAdmin, (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  const users = readCsv(file('login'));
  const row = users.find((u) => u.name === name);
  if (!row) return res.status(404).json({ error: 'Member not found.' });
  const clash = users.find((u) => u.name !== name && u.email.toLowerCase() === email.toLowerCase());
  if (clash) return res.status(400).json({ error: 'That email is already used by someone else.' });
  row.email = email.trim();
  writeCsv(file('login'), users, COLS.login);
  res.json({ ok: true, email: row.email });
});

/**
 * Reset a member's password: blank it, so their next login sets a fresh one — the same
 * password-less state they started in. The admin can never read or choose a password,
 * only hand the choice back to its owner.
 */
app.post('/api/admin/reset-password', requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const users = readCsv(file('login'));
  const row = users.find((u) => u.name === name);
  if (!row) return res.status(404).json({ error: 'Member not found.' });
  if (String(row.is_admin) === '1') {
    return res.status(400).json({ error: 'The admin password can only be changed in login.csv.' });
  }
  row.password = '';
  row.reset_request = '';   // handled.
  writeCsv(file('login'), users, COLS.login);
  res.json({ ok: true, hasPassword: false });
});

/** Members waiting on a reset (for the admin panel). No secrets — just who asked, and when. */
app.get('/api/admin/pending-passwords', requireAdmin, (_req, res) => {
  res.json(readCsv(file('login'))
    .filter((u) => u.reset_request && String(u.is_admin) !== '1')
    .map((u) => ({ email: u.email, name: u.name, requested: u.reset_request })));
});

/**
 * Notification health, for the admin panel. Whose phones can we actually reach, and is
 * the data folder the kind that survives a deploy? If it isn't, every redeploy throws
 * away the VAPID keys and every subscription with them — which is the usual reason
 * notifications "just stop".
 */
app.get('/api/admin/push-status', requireAdmin, (_req, res) => {
  res.json({
    devices: push.devices(),
    dataDir: googleStorage.configured() ? 'Google Sheets + Drive' : DATA,
    persistent: googleStorage.configured() || PERSISTENT,
    keySource: process.env.VAPID_PUBLIC ? 'environment' : 'data/vapid.json',
  });
});

/** Send a test notification to every registered device, the admin's own included. */
app.post('/api/admin/push-test', requireAdmin, async (req, res) => {
  const user = currentUser(req);
  const results = await push.notifyAll({
    member: user.name,
    body: 'Test notification — if you can read this, push is working. 🌼',
    mentions: [],
    url: '/index.html',
  });
  res.json({ sent: results.filter((r) => r.ok).length, results });
});

// Multer / generic error handler.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'That file is too big — the limit is 30 MB.' });
  }
  res.status(400).json({ error: err.message || 'Something went wrong.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🌼 Daffodils Buddies Fund running at http://localhost:${PORT}`);
    console.log(`📁 Data: ${googleStorage.configured() ? 'Google Sheets + Drive' : `${DATA}${PERSISTENT ? '  (persistent)' : '  (bundled folder — resets on every deploy!)'}`}`);
    if (boot.seeded.length) console.log(`🌱 Seeded onto the disk: ${boot.seeded.join(', ')}`);
  });
}

module.exports = app;
