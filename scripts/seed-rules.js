#!/usr/bin/env node
/**
 * seed-rules.js — rebuild data/rules_votes.csv from rules.xlsx
 *
 * An .xlsx is a zip of XML. Rather than pull in a spreadsheet dependency, we unzip
 * with the system `unzip` (already used during development) OR fall back to reading a
 * pre-extracted copy. We parse sharedStrings + sheet1 and emit one CSV row per rule.
 *
 * Output columns: rule_key,label,Nirob,Yen,Riyad,Nasif
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { stringify } = require('../lib/csv');

const ROOT = path.join(__dirname, '..');
const XLSX = path.join(ROOT, 'rules.xlsx');
const OUT = path.join(ROOT, 'data', 'rules_votes.csv');

// Stable keys for each rule row (row number in the sheet -> key + friendly label).
const RULE_MAP = {
  5:  ['bank',              'Bank selection'],
  6:  ['fund_amount',       'Fund amount / month (per person)'],
  7:  ['account_holders',   'Account holders'],
  8:  ['nominee',           'Nominee policy'],
  12: ['loan_max_at_once',  'How much loan can be taken at a time'],
  13: ['loan_min_balance',  'Minimum account balance that must remain'],
  14: ['loan_for_whom',     'For whom loans can be taken'],
  15: ['loan_situations',   'Valid situations for a loan application'],
  16: ['loan_max_time',     'Maximum time to return a loan'],
  20: ['gift_amount',       'How much can be gifted'],
  21: ['gift_occasion',     'Gift to one of us on an occasion'],
  22: ['gift_crisis',       'Gifting on a serious crisis / accident'],
  23: ['donation_national', 'Donation amount on a national crisis'],
  24: ['donation_org',      'Organization selection for a national-crisis donation'],
};
const MEMBER_COLS = { B: 'Nirob', C: 'Yen', D: 'Riyad', E: 'Nasif' };

function extractXlsx() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daf-xlsx-'));
  execFileSync('unzip', ['-o', XLSX, '-d', tmp], { stdio: 'ignore' });
  return tmp;
}

function textOf(siXml) {
  const parts = [...siXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
  return decode(parts.join(''));
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parse(dir) {
  const ssXml = fs.readFileSync(path.join(dir, 'xl', 'sharedStrings.xml'), 'utf8');
  const strings = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const sheet = fs.readFileSync(path.join(dir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
  const rows = {};
  for (const rm of sheet.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = Number(rm[1]);
    const cells = {};
    for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*?t="(\w)")?[^>]*?>(?:<v>([\s\S]*?)<\/v>)?<\/c>/g)) {
      const [, col, type, raw] = cm;
      if (raw == null || raw === '') continue;
      cells[col] = type === 's' ? strings[Number(raw)] : raw;
    }
    rows[rn] = cells;
  }
  return rows;
}

function main() {
  let dir;
  try {
    dir = extractXlsx();
  } catch (err) {
    console.error('Could not unzip rules.xlsx (need the `unzip` tool on PATH):', err.message);
    process.exit(1);
  }

  const rows = parse(dir);
  const header = ['rule_key', 'label', 'Nirob', 'Yen', 'Riyad', 'Nasif'];
  const out = [header];

  for (const [rn, [key, label]] of Object.entries(RULE_MAP)) {
    const cells = rows[rn] || {};
    const votes = Object.entries(MEMBER_COLS).map(([col]) => cells[col] || '');
    out.push([key, label, ...votes]);
  }

  fs.writeFileSync(OUT, stringify(out), 'utf8');
  console.log(`Wrote ${out.length - 1} rules to ${path.relative(ROOT, OUT)}`);
}

main();
