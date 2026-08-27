const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

function configured() {
  return Boolean(SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

function credentials() {
  if (!configured()) throw new Error('Google storage is not configured.');
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

let clients;
function getClients() {
  if (!clients) {
    const auth = credentials();
    clients = {
      sheets: google.sheets({ version: 'v4', auth }),
    };
  }
  return clients;
}

function columnName(index) {
  let result = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}

function statusOf(error) {
  return error?.code ?? error?.response?.status ?? 0;
}

/**
 * Sheets answers 429 once the 60-reads-per-minute quota is hit, and the odd 5xx/reset on
 * a cold start. Those are transient, but on Vercel a single failure used to poison the
 * whole instance, so retry them here before anyone sees an error.
 */
function transient(error) {
  const status = statusOf(error);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(error?.code);
}

async function withRetry(operation, attempts = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts - 1 || !transient(error)) throw error;
      const wait = Math.min(4000, 300 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function rowsFromValues(values) {
  if (!values || !values.length) return [];
  const headers = values[0];
  return values.slice(1).filter((row) => row.some((value) => value !== '')).map((row) => {
    const item = {};
    headers.forEach((header, index) => { item[header] = row[index] ?? ''; });
    return item;
  });
}

async function readTab(tab) {
  const { sheets } = getClients();
  const result = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:ZZ`,
  }));
  return rowsFromValues(result.data.values);
}

/** One API call for every tab — a per-tab read burst is what trips the quota. */
async function readTabs(tabs) {
  const out = new Map();
  if (!tabs.length) return out;
  const { sheets } = getClients();
  const result = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: tabs.map((tab) => `${tab}!A:ZZ`),
  }));
  const ranges = result.data.valueRanges || [];
  tabs.forEach((tab, index) => out.set(tab, rowsFromValues(ranges[index]?.values)));
  return out;
}

/** Creates any missing tabs and reports which ones already held data. */
async function ensureTabs(tabs) {
  const { sheets } = getClients();
  const result = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' }));
  const existing = new Set((result.data.sheets || []).map((sheet) => sheet.properties.title));
  const requests = tabs.filter((tab) => !existing.has(tab)).map((title) => ({ addSheet: { properties: { title } } }));
  if (requests.length) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } }));
  }
  return tabs.filter((tab) => existing.has(tab));
}

async function writeTab(tab, rows, columns) {
  const { sheets } = getClients();
  const values = [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ''))];
  await withRetry(() => sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A:ZZ` }));
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1:${columnName(columns.length - 1)}${values.length}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  }));
}

async function appendTab(tab, row, columns) {
  const { sheets } = getClients();
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:${columnName(columns.length - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [columns.map((column) => row[column] ?? '')] },
  }));
}

module.exports = { configured, ensureTabs, readTab, readTabs, writeTab, appendTab };
