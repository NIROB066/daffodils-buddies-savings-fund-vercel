/**
 * csv.js — dependency-free CSV read/write for the fund's data files.
 * Handles quoted fields, embedded commas, quotes ("") and newlines.
 */
const fs = require('fs');
const path = require('path');
const googleStorage = require('./google-storage');

const googleRows = new Map();
const googleWrites = new Map();
let googleLoading = null;
let googleLoaded = false;

function googleTab(file) {
  return path.basename(file, '.csv') === 'rules_overrides' ? 'overrides' : path.basename(file, '.csv');
}

function usingGoogle() {
  return googleStorage.configured();
}

async function loadGoogleTabs(columns) {
  const names = Object.keys(columns);
  const tabs = [...new Set(names.map((name) => googleTab(`${name}.csv`)))];
  const populated = new Set(await googleStorage.ensureTabs(tabs));
  const rows = await googleStorage.readTabs(tabs.filter((tab) => populated.has(tab)));
  // Only publish once every tab loaded, so a half-filled cache can never look complete.
  for (const name of names) googleRows.set(name, rows.get(googleTab(`${name}.csv`)) || []);
  googleLoaded = true;
}

/**
 * Load all application tabs once per serverless instance.
 * A failure must not be cached: on Vercel a single transient Sheets error (quota, 5xx)
 * used to leave the promise rejected for the life of the instance, so every request that
 * landed on it answered 503 while other instances served fine.
 */
function initGoogleStorage(columns) {
  if (!usingGoogle() || googleLoaded) return Promise.resolve();
  if (!googleLoading) {
    googleLoading = loadGoogleTabs(columns).finally(() => { googleLoading = null; });
  }
  return googleLoading;
}

function queueGoogleWrite(name, operation) {
  const previous = googleWrites.get(name) || Promise.resolve();
  const next = previous.then(operation).catch((error) => {
    console.error(`Google Sheets write failed for ${name}:`, error.message);
  });
  googleWrites.set(name, next);
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
    queueGoogleWrite(name, () => googleStorage.appendTab(googleTab(file), obj, columns));
    return;
  }
  const existing = readCsv(file);
  existing.push(obj);
  writeCsv(file, existing, columns);
}

module.exports = {
  parse, parseRows, stringify, stringifyObjects, readCsv, writeCsv, appendCsv,
  initGoogleStorage,
};
