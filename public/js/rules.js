/* rules.js — render the voted ruleset + a live "loan available now" result card. */
const Rules = (function () {
  let rules = [];

  async function load() { rules = await api('/rules'); render(); }

  function badge(rule) {
    if (rule.source === 'admin') return '<span class="pill amber">admin decision</span>';
    if (rule.tie) return '<span class="pill coral">tie — needs a decision</span>';
    if (rule.source === 'vote') return '<span class="pill green">by vote</span>';
    return '<span class="pill muted">not set</span>';
  }

  function voteTags(rule) {
    return rule.options.map((o) => {
      const who = (o.voters || []).join(', ');
      const win = rule.winners.includes(o.value);
      const label = o.value.length > 40 ? o.value.slice(0, 38) + '…' : o.value;
      return `<span class="pill ${win ? 'green' : 'muted'}" title="${esc(who)}">${esc(label)} · ${o.count}</span>`;
    }).join('');
  }

  function render() {
    const s = Dashboard.summary;
    const banner = document.getElementById('rules-banner');
    if (s && banner) {
      banner.innerHTML = `
        <div class="result-card">
          <div class="rk">Loan you can take right now</div>
          <div class="rv">${fmtMoney(s.loanAvailableNow)}</div>
          <div class="rs">Loan ≤ 50% of balance (${fmtMoney(s.balance)}) · reserve ≥ 20% of invested (${fmtMoney(s.minReserve)})</div>
        </div>`;
    }

    const el = document.getElementById('rules-list');
    if (!rules.length) { el.innerHTML = '<div class="empty">No rules loaded.</div>'; return; }
    el.innerHTML = rules.map((r) => `
      <div class="rule">
        <div class="rl">${esc(r.label)} ${badge(r)}</div>
        <div class="rv">${esc(r.value || '—')}</div>
        <div class="tags">${voteTags(r)}</div>
      </div>`).join('');
  }

  return { load, render, get rules() { return rules; } };
})();
