/* dashboard.js — renders Overview, Investments, Loans and Donations. */
const Dashboard = (function () {
  let summary = null;

  function av(name) { return `<span class="avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>`; }

  /** `v` may be a raw number — those animate from ৳0 — or ready-made markup. */
  function stat(k, v, cls, s) {
    const val = typeof v === 'number'
      ? `<div class="v ${cls || ''}" data-count="${v}">${fmtMoney(v)}</div>`
      : `<div class="v ${cls || ''}">${v}</div>`;
    return `<div class="stat"><div class="k">${k}</div>${val}${s ? `<div class="s">${s}</div>` : ''}</div>`;
  }

  const calmly = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Money counts up the first time its card scrolls into view — small delight,
     and it makes the totals feel earned rather than just printed. */
  function animateCounters(root) {
    const els = [...root.querySelectorAll('[data-count]')];
    if (!els.length) return;

    const run = (el) => {
      if (el.dataset.ran) return;
      el.dataset.ran = '1';
      const target = Number(el.dataset.count) || 0;
      if (calmly() || !target) { el.textContent = fmtMoney(target); return; }
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - start) / 850);
        el.textContent = fmtMoney(target * (1 - Math.pow(1 - p, 3)));  // ease-out
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    if (calmly() || !('IntersectionObserver' in window)) return els.forEach(run);
    // Start at zero *before* the browser paints, so there's no flash of the total.
    els.forEach((el) => { el.textContent = fmtMoney(0); });
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); run(e.target); } });
    }, { threshold: 0.3 });
    els.forEach((el) => io.observe(el));
    // Safety net: a card that never scrolls into view still shows the real number.
    setTimeout(() => els.forEach(run), 4000);
  }

  /** Fill a container, stagger its cards in, then count its numbers up. */
  function paint(id, html) {
    const el = document.getElementById(id);
    el.innerHTML = html;
    [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
    animateCounters(el);
  }

  async function load() {
    summary = await api('/summary');
    const [investments, loans, donations] = await Promise.all([api('/investments'), api('/loans'), api('/donations')]);
    renderCrew(summary);
    renderOverview(summary);
    renderInvest(summary, investments);
    renderLoans(summary, loans);
    renderDonations(summary, donations);
  }

  /** One heart per buddy, beating in sequence — a little pulse for the crew. */
  function hearts(n) {
    return Array.from({ length: n }, (_, i) =>
      `<span class="crew-heart" style="animation-delay:${i * 200}ms">💚</span>`).join('');
  }

  /* The note greets whoever is logged in. Each buddy keeps their own line —
     picked by their place in the (sorted) crew, so no two buddies read the same
     greeting and everyone's stays the same every time they sign in. */
  function crewNote(me, names) {
    const n = names.length;
    const i = names.indexOf(me);
    if (i < 0) return `${n} buddies, one fund`;
    const you = me.split(' ')[0];
    const mates = `${n - 1} ${n - 1 === 1 ? 'buddy' : 'buddies'}`;
    const lines = [
      `${you} + ${mates}, one fund`,
      `Welcome back, ${you} — ${mates} saving right along with you`,
      `${you}, you're 1 of ${n} keeping this fund alive`,
      `${mates} have your back, ${you}`,
    ];
    return lines[i % lines.length];
  }

  /** The four faces under the hero title — this fund is the people in it. */
  function renderCrew(s) {
    const me = (Session.user && Session.user.name) || '';
    const names = s.perMember.map((m) => m.member).sort((a, b) => a.localeCompare(b));
    const faces = names.map((n, i) => `
      <span class="avatar-sm ${n === me ? 'me' : ''}" title="${esc(n)}"
            style="background:${avatarColor(n)};animation-delay:${i * 70}ms">${initials(n)}</span>`).join('');
    document.getElementById('hero-crew').innerHTML =
      `<span class="crew-faces">${faces}</span>
       <span class="crew-note">${esc(crewNote(me, names))} ${hearts(names.length)}</span>`;
  }

  function renderOverview(s) {
    document.getElementById('loan-banner').innerHTML = `
      <div class="result-card">
        <div class="rk">Loan you can take right now</div>
        <div class="rv" data-count="${s.loanAvailableNow}">${fmtMoney(s.loanAvailableNow)}</div>
        <div class="rs">Loan ≤ 50% of balance (${fmtMoney(s.balance)}) · reserve ≥ 20% of invested (${fmtMoney(s.minReserve)})</div>
      </div>`;
    animateCounters(document.getElementById('loan-banner'));

    paint('overview-cards',
      stat('Total Balance', s.balance, 'green',
        `Invested ${fmtMoney(s.totalInvested)} · On loan ${fmtMoney(s.outstandingLoans)} · Donated ${fmtMoney(s.totalDonated)}`) +
      stat('Loan Available Now', s.loanAvailableNow, 'amber',
        `50% of balance, keeping a ${fmtMoney(s.minReserve)} reserve`) +
      stat('Members', `${s.counts.members} 🤝`, '', `${fmtMoney(250)} / person / month`) +
      stat('Reserve Floor', s.minReserve, '', 'Always kept in the fund'));
  }

  /** How many different months a buddy has chipped in — a warm streak, not a score. */
  function streak(months) {
    if (months >= 2) return `<span class="streak">🔥 ${months} months</span>`;
    if (months === 1) return '<span class="streak fresh">🌱 first month</span>';
    return '<span class="streak fresh">💤 not yet</span>';
  }

  function renderInvest(s, investments) {
    const byMember = {};
    investments.forEach((r) => {
      (byMember[r.member] = byMember[r.member] || new Set()).add(String(r.date || '').slice(0, 7));
    });

    // Friends, not competitors — show everyone's savings warmly, ordered by name (no ranking).
    const people = s.perMember.slice().sort((a, b) => a.member.localeCompare(b.member));
    const roster = people.map((m) => `
      <div class="mate">
        <span class="who">${av(m.member)} <b>${esc(m.member)}</b>${streak((byMember[m.member] || new Set()).size)}</span>
        <span class="mate-amt">${fmtMoney(m.invested)} <span class="mate-sub">saved 💚</span></span>
      </div>`).join('');

    const thisMonth = (s.monthly[s.monthly.length - 1] || {}).amount || 0;
    const thisYear = (s.yearly[s.yearly.length - 1] || {}).amount || 0;

    paint('invest-cards',
      stat('Total Invested', s.totalInvested, 'green', `${s.counts.investments} contributions of love`) +
      stat('This Month', thisMonth, '', s.monthly.length ? s.monthly[s.monthly.length - 1].month : '—') +
      stat('This Year', thisYear, '', s.yearly.length ? s.yearly[s.yearly.length - 1].year : '—') +
      `<div class="stat mates" style="grid-column: 1 / -1;">
         <div class="k">🤝 Our savings, together</div>
         <div class="mate-sub" style="margin:2px 0 6px">Every buddy chips in — every bit counts.</div>
         <div class="mate-list">${roster || '<div class="empty">No savings yet</div>'}</div>
       </div>`);

    document.getElementById('invest-table').innerHTML = table(
      ['Member', 'Amount', 'Date'],
      investments.slice().reverse().map((r) => [
        `<span class="who">${av(r.member)} ${esc(r.member)}</span>`, fmtMoney(r.amount), fmtDate(r.date),
      ]),
      'No savings logged yet — the first ৳250 starts our journey. 🌱'
    );
  }

  function renderLoans(s, loans) {
    const outstanding = loans.filter((l) => !['returned','repaid','closed','paid'].includes(String(l.status).toLowerCase()));
    paint('loan-cards',
      stat('Available to Borrow', s.loanAvailableNow, 'amber', 'Right now, for a single loan') +
      stat('Currently on Loan', s.outstandingLoans, 'coral', `${outstanding.length} active loan(s)`) +
      stat('Total Loaned', s.totalLoaned, '', 'Return within 3 months'));

    document.getElementById('loan-table').innerHTML = table(
      ['Member', 'Amount', 'Date', 'Purpose', 'Status'],
      loans.slice().reverse().map((r) => [
        `<span class="who">${av(r.member)} ${esc(r.member)}</span>`, fmtMoney(r.amount), fmtDate(r.date),
        esc(r.purpose || '—'), statusPill(r.status),
      ]),
      'No loans yet — the fund is here whenever a buddy needs a hand. 🤝'
    );
  }

  function renderDonations(s, donations) {
    paint('donation-cards',
      stat('Total Donated', s.totalDonated, 'green', `${s.counts.donations} donation(s) 🤲`));

    document.getElementById('donation-table').innerHTML = table(
      ['Organization', 'Amount', 'Date', 'Type', 'Link'],
      donations.slice().reverse().map((r) => [
        esc(r.organization), fmtMoney(r.amount), fmtDate(r.date),
        `<span class="pill sky">${esc((r.type || 'general').replace(/_/g, ' '))}</span>`,
        r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">visit ↗</a>` : '—',
      ]),
      'No donations yet — our first good deed together is coming soon. 🤲'
    );
  }

  function statusPill(status) {
    const done = ['returned', 'repaid', 'closed', 'paid'].includes(String(status || '').toLowerCase());
    return `<span class="pill ${done ? 'green' : 'coral'}">${esc(status || 'outstanding')}</span>`;
  }

  function table(headers, rows, emptyMsg) {
    if (!rows.length) return `<div class="empty">${emptyMsg}</div>`;
    return `<div class="table-scroll"><table class="table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  return { load, get summary() { return summary; } };
})();
