/**
 * csv.js — dependency-free CSV read/write for the fund's data files.
 * Handles quoted fields, embedded commas, quotes ("") and newlines.
 */
const fs = require('fs');
const path = require('path');
const googleStorage = require('./google-storage');

const googleRows = new Map();
const googleWrites = new Map();
const localGen = new Map();   // name → bumped by every local write, to detect a mid-read change
let googleLoading = null;
let googleTabs = null;        // set once the tabs are known to exist
let loadedAt = 0;

/**
 * How long an instance may trust its cached rows. Vercel runs several instances at once,
 * so a cache that never expired was why a message sent through one of them stayed
 * invisible on the others until they were recycled — "refresh many times to see it".
 * A refresh is a single batchGet, so the quota cost is one read per window per instance.
 */
const CACHE_MS = Number(process.env.SHEETS_CACHE_MS || 3000);

function googleTab(file) {
  return path.basename(file, '.csv') === 'rules_overrides' ? 'overrides' : path.basename(file, '.csv');
}

function usingGoogle() {
  return googleStorage.configured();
}

async function loadGoogleTabs(columns) {
  const names = Object.keys(columns);
  const tabs = [...new Set(names.map((name) => googleTab(`${name}.csv`)))];
  let readable = googleTabs;
  if (!readable) {
    // A tab we create in this same pass is empty, so skip it on the first load only;
    // from the next refresh on it exists and must be read like any other.
    const populated = new Set(await googleStorage.ensureTabs(tabs));
    readable = tabs.filter((tab) => populated.has(tab));
    googleTabs = tabs;
    for (const name of names) if (!googleRows.has(name)) googleRows.set(name, []);
  }
  // Our own queued rows are newer than anything the sheet can hand back.
  await flushGoogleWrites();
  const before = new Map(localGen);
  const rows = await googleStorage.readTabs(readable);
  for (const name of names) {
    const tab = googleTab(`${name}.csv`);
    if (!rows.has(tab)) continue;
    if ((localGen.get(name) || 0) !== (before.get(name) || 0)) continue;   // written mid-read
    googleRows.set(name, rows.get(tab) || []);
  }
  loadedAt = Date.now();
}

/**
 * Bring this instance's cache up to date, at most once per CACHE_MS.
 * A failure must not be cached: on Vercel a single transient Sheets error (quota, 5xx)
 * used to leave the promise rejected for the life of the instance, so every request that
 * landed on it answered 503 while other instances served fine.
 */
function initGoogleStorage(columns) {
  if (!usingGoogle()) return Promise.resolve();
  if (loadedAt && Date.now() - loadedAt < CACHE_MS) return Promise.resolve();
  if (!googleLoading) {
    googleLoading = loadGoogleTabs(columns).finally(() => { googleLoading = null; });
  }
  if (!loadedAt) return googleLoading;
  // We already have rows: a failed refresh costs freshness, not the request.
  return googleLoading.catch((error) => {
    console.error('Google Sheets refresh failed, serving cached rows:', error.message);
  });
}

function queueGoogleWrite(name, operation) {
  const previous = googleWrites.get(name) || Promise.resolve();
  const next = previous.then(operation).catch((error) => {
    console.error(`Google Sheets write failed for ${name}:`, error.message);
  }).finally(() => { if (googleWrites.get(name) === next) googleWrites.delete(name); });
  googleWrites.set(name, next);
}

/**
 * Settle every queued Sheets write. Serverless hosts freeze the instance the moment the
 * response is sent, so a write nobody waited for is a write that may never land.
 */
function flushGoogleWrites() {
  if (!googleWrites.size) return Promise.resolve();
  return Promise.all([...googleWrites.values()]).then(() => {});
}

/** Parse CSV text into an array of row-arrays (including the header row). */
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // Flush trailing field/row (file may not end with a newline).
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse CSV text into an array of objects keyed by the header row. */
function parse(text) {
  const rows = parseRows(text);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1)
    // Drop fully-empty trailing lines.
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
      return obj;
    });
}

function escapeField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Stringify an array of row-arrays into CSV text (with trailing newline). */
function stringify(rows) {
  return rows.map((r) => r.map(escapeField).join(',')).join('\n') + '\n';
}

/** Stringify an array of objects using an explicit column order. */
function stringifyObjects(objs, columns) {
  const rows = [columns, ...objs.map((o) => columns.map((c) => o[c]))];
  return stringify(rows);
}

// ---- file helpers -------------------------------------------------------

function readCsv(file) {
  if (usingGoogle()) return googleRows.get(path.basename(file, '.csv')) || [];
  if (!fs.existsSync(file)) return [];
  return parse(fs.readFileSync(file, 'utf8'));
}

/** Overwrite a CSV file from an array of objects. Creates parent dir if needed. */
function writeCsv(file, objs, columns) {
  if (usingGoogle()) {
    const name = path.basename(file, '.csv');
    googleRows.set(name, objs);
    localGen.set(name, (localGen.get(name) || 0) + 1);
    queueGoogleWrite(name, () => googleStorage.writeTab(googleTab(file), objs, columns));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyObjects(objs, columns), 'utf8');
}

/** Append one object as a new row, writing the header if the file is new/empty. */
function appendCsv(file, obj, columns) {
  if (usingGoogle()) {
    const name = path.basename(file, '.csv');
    const rows = googleRows.get(name) || [];
    rows.push(obj);
    googleRows.set(name, rows);
    localGen.set(name, (localGen.get(name) || 0) + 1);
    queueGoogleWrite(name, () => googleStorage.appendTab(googleTab(file), obj, columns));
    return;
  }
  const existing = readCsv(file);
  existing.push(obj);
  writeCsv(file, existing, columns);
}

module.exports = {
  parse, parseRows, stringify, stringifyObjects, readCsv, writeCsv, appendCsv,
  initGoogleStorage, flushGoogleWrites,
};
