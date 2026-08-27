/**
 * rules.js — turn the four friends' votes into the fund's ruleset.
 *
 * For each rule row we tally the votes, pick the option with the most votes, flag ties,
 * and let an admin override (data/rules_overrides.csv) win over the computed result.
 */
const { readCsv } = require('./csv');
const { file } = require('./paths');

const VOTES = file('rules_votes');
const OVERRIDES = file('rules_overrides');
const MEMBERS = ['Nirob', 'Yen', 'Riyad', 'Nasif'];

/**
 * Normalize a vote for tallying so trivial spelling/casing differences count together
 * (e.g. "20% of the main balace" vs "20% of the Main Balance"). The display value keeps
 * the original wording of whichever variant appears first.
 */
function normKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/balace/g, 'balance') // known typo in the source sheet
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

function tally(votes) {
  const groups = new Map(); // normKey -> { display, count, voters:[] }
  votes.forEach(({ member, value }) => {
    if (value == null || value === '') return;
    const k = normKey(value);
    if (!groups.has(k)) groups.set(k, { display: value, count: 0, voters: [] });
    const g = groups.get(k);
    g.count += 1;
    g.voters.push(member);
  });
  const options = [...groups.values()].sort((a, b) => b.count - a.count);
  const top = options.length ? options[0].count : 0;
  const winners = options.filter((o) => o.count === top && top > 0);
  return { options, winners, tie: winners.length > 1 };
}

function loadOverrides() {
  const map = {};
  for (const row of readCsv(OVERRIDES)) {
    if (row.rule_key) map[row.rule_key] = row.final_value;
  }
  return map;
}

/**
 * Compute the ruleset. Returns an array of:
 *   { key, label, options:[{value,count,voters}], winners:[...], tie, value, source }
 * where `value` is what the UI should display and `source` is 'admin' | 'vote' | 'none'.
 */
function computeRules() {
  const voteRows = readCsv(VOTES);
  const overrides = loadOverrides();

  return voteRows.map((row) => {
    const votes = MEMBERS.map((m) => ({ member: m, value: row[m] }));
    const { options, winners, tie } = tally(votes);

    let value = '';
    let source = 'none';
    if (overrides[row.rule_key] != null && overrides[row.rule_key] !== '') {
      value = overrides[row.rule_key];
      source = 'admin';
    } else if (winners.length === 1) {
      value = winners[0].display;
      source = 'vote';
    } else if (winners.length > 1) {
      value = winners.map((w) => w.display).join(' / ');
      source = 'vote';
    }

    return {
      key: row.rule_key,
      label: row.label,
      options: options.map((o) => ({ value: o.display, count: o.count, voters: o.voters })),
      winners: winners.map((w) => w.display),
      tie: tie && source !== 'admin',
      value,
      source,
    };
  });
}

/** Look up a single computed rule's display value by key (used by fund math / UI). */
function ruleValue(rules, key) {
  const r = rules.find((x) => x.key === key);
  return r ? r.value : '';
}

module.exports = { computeRules, ruleValue, MEMBERS, VOTES, OVERRIDES };
