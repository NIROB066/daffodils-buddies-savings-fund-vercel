/**
 * fund.js — balance and loan-availability math for the fund.
 *
 * Rules (from the vote):
 *   - A loan can be at most 50% of the current account balance at a time.
 *   - A minimum reserve of 20% of the total invested must always remain.
 *   - Max time to return a loan: 3 months.
 */
const { readCsv } = require('./csv');
const { file } = require('./paths');

const MEMBERS = ['Nirob', 'Yen', 'Riyad', 'Nasif'];

const MAX_LOAN_FRACTION = 0.5;   // 50% of balance at a time
const MIN_RESERVE_FRACTION = 0.2; // 20% of total invested must remain

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function ym(dateStr) {
  // Expects YYYY-MM-DD; returns "YYYY-MM" (falls back to the raw prefix).
  return String(dateStr || '').slice(0, 7);
}

/** An outstanding loan is one whose status is not 'returned' / 'repaid' / 'closed'. */
function isOutstanding(status) {
  const s = String(status || '').toLowerCase();
  return !['returned', 'repaid', 'closed', 'paid'].includes(s);
}

function computeSummary() {
  const investments = readCsv(file('investments'));
  const loans = readCsv(file('loans'));
  const donations = readCsv(file('donations'));

  const totalInvested = investments.reduce((s, r) => s + num(r.amount), 0);
  const outstandingLoans = loans
    .filter((l) => isOutstanding(l.status))
    .reduce((s, r) => s + num(r.amount), 0);
  const totalLoaned = loans.reduce((s, r) => s + num(r.amount), 0);
  const totalDonated = donations.reduce((s, r) => s + num(r.amount), 0);

  const balance = totalInvested - outstandingLoans - totalDonated;
  const minReserve = MIN_RESERVE_FRACTION * totalInvested;
  const maxSingleLoan = MAX_LOAN_FRACTION * balance;
  const loanAvailableNow = Math.max(0, Math.min(maxSingleLoan, balance - minReserve));

  // Per-member investment / loan totals.
  const perMember = MEMBERS.map((m) => {
    const invested = investments.filter((r) => r.member === m).reduce((s, r) => s + num(r.amount), 0);
    const loaned = loans
      .filter((r) => r.member === m && isOutstanding(r.status))
      .reduce((s, r) => s + num(r.amount), 0);
    return { member: m, invested, outstandingLoan: loaned };
  }).sort((a, b) => b.invested - a.invested);

  // Monthly + yearly investment rollups.
  const byMonth = {};
  const byYear = {};
  investments.forEach((r) => {
    const m = ym(r.date);
    const y = String(r.date || '').slice(0, 4);
    byMonth[m] = (byMonth[m] || 0) + num(r.amount);
    byYear[y] = (byYear[y] || 0) + num(r.amount);
  });
  const monthly = Object.entries(byMonth)
    .filter(([k]) => k)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, amount]) => ({ month, amount }));
  const yearly = Object.entries(byYear)
    .filter(([k]) => k)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, amount]) => ({ year, amount }));

  return {
    currency: '৳',
    totalInvested,
    outstandingLoans,
    totalLoaned,
    totalDonated,
    balance,
    minReserve,
    maxSingleLoan,
    loanAvailableNow,
    counts: {
      investments: investments.length,
      loans: loans.length,
      donations: donations.length,
      members: MEMBERS.length,
    },
    perMember,
    monthly,
    yearly,
  };
}

module.exports = { computeSummary, MEMBERS, MAX_LOAN_FRACTION, MIN_RESERVE_FRACTION };
