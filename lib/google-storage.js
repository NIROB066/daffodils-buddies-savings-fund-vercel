const { google } = require('googleapis');
const { Readable } = require('stream');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

function configured() {
  return Boolean(SHEET_ID && DRIVE_FOLDER_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
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
      drive: google.drive({ version: 'v3', auth }),
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

async function readTab(tab) {
  const { sheets } = getClients();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:ZZ`,
  });
  const values = result.data.values || [];
  if (!values.length) return [];
  const headers = values[0];
  return values.slice(1).filter((row) => row.some((value) => value !== '')).map((row) => {
    const item = {};
    headers.forEach((header, index) => { item[header] = row[index] ?? ''; });
    return item;
  });
}

async function ensureTabs(tabs) {
  const { sheets } = getClients();
  const result = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const existing = new Set((result.data.sheets || []).map((sheet) => sheet.properties.title));
  const requests = tabs.filter((tab) => !existing.has(tab)).map((title) => ({ addSheet: { properties: { title } } }));
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  }
}

async function writeTab(tab, rows, columns) {
  const { sheets } = getClients();
  const values = [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ''))];
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A:ZZ` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1:${columnName(columns.length - 1)}${values.length}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

async function appendTab(tab, row, columns) {
  const { sheets } = getClients();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:${columnName(columns.length - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [columns.map((column) => row[column] ?? '')] },
  });
}

async function upload(buffer, name, mimeType) {
  const { drive } = getClients();
  const result = await drive.files.create({
    requestBody: { name, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id,name,size,mimeType',
    supportsAllDrives: true,
  });
  await drive.permissions.create({
    fileId: result.data.id,
    requestBody: { type: 'anyone', role: 'reader' },
    supportsAllDrives: true,
  });
  return {
    id: result.data.id,
    name: result.data.name,
    size: result.data.size || buffer.length,
    mimeType: result.data.mimeType || mimeType,
    url: `https://drive.google.com/uc?export=view&id=${result.data.id}`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${result.data.id}`,
  };
}

async function remove(fileId) {
  if (!fileId) return;
  try {
    fileId = new URL(fileId).searchParams.get('id') || fileId;
  } catch { /* stored value is already a Drive ID */ }
  await getClients().drive.files.delete({ fileId });
}

module.exports = { configured, ensureTabs, readTab, writeTab, appendTab, upload, remove };
