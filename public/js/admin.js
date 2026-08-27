/* admin.js — admin-only panel: add investments/loans/donations, resolve rules,
   reset forgotten passwords and check that notifications can actually reach everyone. */
const Admin = (function () {
  let members = [];
  let memberRows = [];
  let ledgers = { investments: [], loans: [], donations: [] };
  let pushStatus = { devices: [], persistent: true };

  async function load() {
    if (!(Session.user && Session.user.isAdmin)) return;
    members = await api('/members');
    const [pending, investments, loans, donations, mrows, status] = await Promise.all([
      api('/admin/pending-passwords').catch(() => []),
      api('/investments'), api('/loans'), api('/donations'),
      api('/admin/members').catch(() => []),
      api('/admin/push-status').catch(() => ({ devices: [], persistent: true })),
    ]);
    ledgers = { investments, loans, donations };
    memberRows = mrows;
    pushStatus = status;
    render(pending);
    bind();
  }

  function memberOptions() {
    return members.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  }

  function render(pending) {
    const today = new Date().toISOString().slice(0, 10);
    const rules = Rules.rules || [];
    document.getElementById('admin-content').innerHTML = `
      <div class="admin-grid">
        <div class="card">
          <h3>➕ Add Investment</h3>
          <div class="form-row">
            <select id="ai-member">${memberOptions()}</select>
            <div class="form-inline">
              <input id="ai-amount" type="number" placeholder="Amount ৳" />
              <input id="ai-date" type="date" value="${today}" />
            </div>
            <button class="btn small" id="ai-add">Add investment</button>
          </div>
        </div>

        <div class="card">
          <h3>➕ Add Loan</h3>
          <div class="form-row">
            <select id="al-member">${memberOptions()}</select>
            <div class="form-inline">
              <input id="al-amount" type="number" placeholder="Amount ৳" />
              <input id="al-date" type="date" value="${today}" />
            </div>
            <input id="al-purpose" type="text" placeholder="Purpose (e.g. Delayed salary)" />
            <div class="form-inline">
              <select id="al-status"><option value="outstanding">outstanding</option><option value="returned">returned</option></select>
              <input id="al-due" type="date" placeholder="Due date" />
            </div>
            <button class="btn small" id="al-add">Add loan</button>
          </div>
        </div>

        <div class="card">
          <h3>➕ Add Donation</h3>
          <div class="form-row">
            <input id="ad-org" type="text" placeholder="Organization name" />
            <div class="form-inline">
              <input id="ad-amount" type="number" placeholder="Amount ৳" />
              <input id="ad-date" type="date" value="${today}" />
            </div>
            <input id="ad-link" type="text" placeholder="Link (optional)" />
            <select id="ad-type">
              <option value="general">general</option>
              <option value="national_crisis">national crisis</option>
              <option value="gift">gift</option>
            </select>
            <button class="btn small" id="ad-add">Add donation</button>
          </div>
        </div>

        <div class="card">
          <h3>🔑 Password Resets</h3>
          <div id="pending-list">${renderPending(pending)}</div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>✉️ Buddies' logins</h3>
        <p class="sub" style="margin-bottom:10px">Set each friend's real email so they can log in. Passwords are private — you can't see them, and neither can anyone else. If someone gets locked out, reset it and they'll choose a new one the next time they log in.</p>
        <div id="member-email-list">${memberRows.map(memberEmailRow).join('')}</div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>🔔 Notifications</h3>
        ${pushNotice()}
        <div id="push-devices">${renderDevices(pushStatus.devices)}</div>
        <button class="btn small secondary" id="push-test" style="margin-top:12px">Send a test notification</button>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>🗂️ Manage records</h3>
        <p class="sub" style="margin-bottom:10px">Remove any investment, loan or donation entered by mistake.</p>
        <div class="manage-grid">
          <div>
            <div class="manage-h">Investments</div>
            <div id="manage-investments">${manageList('investment', ledgers.investments, (r) => `${esc(r.member)} · ${fmtMoney(r.amount)}`, (r) => fmtDate(r.date))}</div>
          </div>
          <div>
            <div class="manage-h">Loans</div>
            <div id="manage-loans">${manageList('loan', ledgers.loans, (r) => `${esc(r.member)} · ${fmtMoney(r.amount)}`, (r) => esc(r.purpose || r.status || ''))}</div>
          </div>
          <div>
            <div class="manage-h">Donations</div>
            <div id="manage-donations">${manageList('donation', ledgers.donations, (r) => `${esc(r.organization)} · ${fmtMoney(r.amount)}`, (r) => fmtDate(r.date))}</div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>🧹 Community controls</h3>
        <p class="sub" style="margin-bottom:12px">Tidy up our corner. These clear everything in that space for everyone — use with care. 💚</p>
        <div class="danger-row">
          <div class="dr-info"><b>Chat history</b><span class="mr-meta">All messages &amp; shared media</span></div>
          <button class="btn small danger" data-clear="chat">Clear chat</button>
        </div>
        <div class="danger-row">
          <div class="dr-info"><b>Posts</b><span class="mr-meta">Every post on the feed</span></div>
          <button class="btn small danger" data-clear="posts">Clear posts</button>
        </div>
        <div class="danger-row">
          <div class="dr-info"><b>Memories</b><span class="mr-meta">All uploaded photos</span></div>
          <button class="btn small danger" data-clear="photos">Clear memories</button>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>⚖️ Resolve Rules (tie-breakers &amp; overrides)</h3>
        <p class="sub" style="margin-bottom:10px">Pick the final wording for tied or free-form rules. Leaving it blank uses the vote result.</p>
        <div id="override-list">${rules.map(overrideRow).join('')}</div>
      </div>`;
  }

  function manageList(type, rows, title, meta) {
    if (!rows || !rows.length) return '<div class="empty" style="padding:14px">Nothing yet.</div>';
    return rows.slice().reverse().map((r) => `
      <div class="manage-row">
        <div class="mr-info"><b>${title(r)}</b><span class="mr-meta">${meta(r)}</span></div>
        <button class="del-btn" title="Delete" data-del-type="${type}" data-del-id="${esc(r.id)}"><span data-ico="trash"></span></button>
      </div>`).join('');
  }

  function memberEmailRow(m) {
    const status = m.hasPassword
      ? '<span class="pill green">password set</span>'
      : '<span class="pill amber">waiting for first login</span>';
    const asked = m.resetRequested ? ' <span class="pill coral">reset requested</span>' : '';
    const name = esc(m.name);
    return `
      <div class="member-row">
        <div class="dr-info"><b>${name}</b> ${status}${asked}</div>
        <div class="member-fields">
          <div class="mf">
            <input type="text" class="member-email-input" data-name="${name}" value="${esc(m.email)}" placeholder="name@example.com" aria-label="${name}'s email" />
            <button class="btn small secondary" data-save-email="${name}">Save email</button>
          </div>
          <div class="mf">
            <button class="btn small secondary" data-reset-pass="${name}" ${m.hasPassword ? '' : 'disabled'}>
              ${m.hasPassword ? 'Reset password' : 'Nothing to reset'}
            </button>
          </div>
        </div>
      </div>`;
  }

  function renderPending(pending) {
    if (!pending || !pending.length) return '<div class="empty">No pending requests.</div>';
    return pending.map((p) => `
      <div class="row">
        <span class="who"><b>${esc(p.name)}</b> <span style="color:var(--muted);font-size:12px">asked ${fmtTime(p.requested)}</span></span>
        <button class="btn small" data-reset-pass="${esc(p.name)}">Reset</button>
      </div>`).join('');
  }

  function overrideRow(r) {
    const opts = r.options.map((o) =>
      `<option value="${esc(o.value)}" ${r.value === o.value ? 'selected' : ''}>${esc(o.value.slice(0, 60))}</option>`).join('');
    const flag = r.tie ? ' <span class="pill coral">tie</span>' : (r.source === 'admin' ? ' <span class="pill amber">override</span>' : '');
    return `
      <div class="override-row">
        <div>
          <label>${esc(r.label)}${flag}</label>
          <select data-rule="${esc(r.key)}">
            <option value="">— use vote result —</option>
            ${opts}
          </select>
        </div>
        <button class="btn small secondary" data-save="${esc(r.key)}">Save</button>
      </div>`;
  }

  /**
   * Devices that have turned notifications on. A message only reaches people listed here,
   * and never the sender — so testing by messaging yourself always looks like a failure.
   */
  function renderDevices(devices) {
    if (!devices || !devices.length) {
      return '<div class="empty">No devices yet. Each person opens the app and taps 🔔 once — on iPhone it has to be the Home Screen app, not Safari.</div>';
    }
    const byName = devices.reduce((acc, d) => {
      (acc[d.name] = acc[d.name] || []).push(d);
      return acc;
    }, {});
    return Object.entries(byName).map(([name, list]) => `
      <div class="manage-row">
        <div class="mr-info">
          <b>${esc(name)}</b>
          <span class="mr-meta">${list.length} device${list.length > 1 ? 's' : ''} · since ${fmtDate(list[0].created)}</span>
        </div>
        <span class="pill green">reachable</span>
      </div>`).join('');
  }

  /** Loud warning if the data folder is the bundled one — it resets on every deploy. */
  function pushNotice() {
    const missing = members.filter((m) => !pushStatus.devices.some((d) => d.name === m));
    const warn = pushStatus.persistent === false
      ? `<div class="danger-row" style="margin-bottom:10px"><div class="dr-info"><b>⚠️ Storage is not persistent</b><span class="mr-meta">Data is in <code>${esc(pushStatus.dataDir || '')}</code>, which resets on every deploy — notifications will keep breaking until a disk is mounted.</span></div></div>`
      : '';
    const waiting = missing.length
      ? `<p class="sub" style="margin-bottom:10px">Not set up yet: <b>${missing.map(esc).join(', ')}</b>.</p>`
      : '';
    return `${warn}<p class="sub" style="margin-bottom:10px">Whoever sends a message never gets their own notification — test with someone else's phone, or use the button below.</p>${waiting}`;
  }

  function bind() {
    document.getElementById('ai-add').addEventListener('click', addInvestment);
    document.getElementById('al-add').addEventListener('click', addLoan);
    document.getElementById('ad-add').addEventListener('click', addDonation);
    document.querySelectorAll('[data-save]').forEach((b) =>
      b.addEventListener('click', () => saveOverride(b.dataset.save)));
    document.querySelectorAll('[data-del-type]').forEach((b) =>
      b.addEventListener('click', () => deleteRecord(b.dataset.delType, b.dataset.delId)));
    document.querySelectorAll('[data-clear]').forEach((b) =>
      b.addEventListener('click', () => clearCollection(b.dataset.clear)));
    document.querySelectorAll('[data-save-email]').forEach((b) =>
      b.addEventListener('click', () => saveMemberEmail(b.dataset.saveEmail)));
    document.querySelectorAll('[data-reset-pass]').forEach((b) =>
      b.addEventListener('click', () => resetMemberPassword(b.dataset.resetPass)));
    const pushBtn = document.getElementById('push-test');
    if (pushBtn) pushBtn.addEventListener('click', sendTestPush);
    if (typeof hydrateIcons === 'function') hydrateIcons(document.getElementById('admin-content'));
  }

  async function clearCollection(kind) {
    const nice = { chat: 'chat history', posts: 'posts', photos: 'memories (photos)' }[kind] || kind;
    if (!window.confirm(`Clear all ${nice}? This removes it for everyone and cannot be undone.`)) return;
    try {
      const r = await api(`/admin/${kind}`, { method: 'DELETE' });
      Toast.show(`Cleared ${r.cleared || 0} item(s) 🧹`);
      if (window.Community && Community.load) await Community.load();
    } catch (e) { Toast.show(e.message, true); }
  }

  async function saveMemberEmail(name) {
    const input = document.querySelector(`.member-email-input[data-name="${CSS.escape(name)}"]`);
    const email = input.value.trim();
    if (!email) return Toast.show('Enter an email.', true);
    try {
      await api('/admin/member-email', { method: 'POST', body: { name, email } });
      Toast.show(`${name}'s email saved ✅`);
      await load();
    } catch (e) { Toast.show(e.message, true); }
  }

  /**
   * Hand the password choice back to its owner. Nobody — admin included — can read or
   * set someone else's password; clearing it is the only lever, and their next login
   * picks a fresh one.
   */
  async function resetMemberPassword(name) {
    if (!window.confirm(
      `Reset ${name}'s password?\n\nTheir current password stops working immediately, and the next time they log in they choose a new one. You won't see it — nobody but ${name} will.`
    )) return;
    try {
      await api('/admin/reset-password', { method: 'POST', body: { name } });
      Toast.show(`${name}'s password reset — their next login sets a new one. 🔑`);
      await load();
    } catch (e) { Toast.show(e.message, true); }
  }

  async function deleteRecord(type, id) {
    const nice = { investment: 'investment', loan: 'loan', donation: 'donation' }[type] || 'record';
    if (!window.confirm(`Delete this ${nice}? This cannot be undone.`)) return;
    try {
      await api(`/admin/${type}/${id}`, { method: 'DELETE' });
      Toast.show('Deleted 🗑️');
      await refreshAll();
      await load();
    } catch (e) { Toast.show(e.message, true); }
  }

  async function refreshAll() {
    await Dashboard.load();
    await Rules.load();
  }

  async function addInvestment() {
    const body = {
      member: val('ai-member'), amount: val('ai-amount'), date: val('ai-date'),
    };
    if (!body.amount) return Toast.show('Enter an amount.', true);
    try {
      await api('/admin/investment', { method: 'POST', body });
      Toast.show('Investment added ✅');
      document.getElementById('ai-amount').value = '';
      await refreshAll();
    } catch (e) { Toast.show(e.message, true); }
  }

  async function addLoan() {
    const body = {
      member: val('al-member'), amount: val('al-amount'), date: val('al-date'),
      purpose: val('al-purpose'), status: val('al-status'), due_date: val('al-due'),
    };
    if (!body.amount) return Toast.show('Enter an amount.', true);
    try {
      await api('/admin/loan', { method: 'POST', body });
      Toast.show('Loan added ✅');
      document.getElementById('al-amount').value = '';
      document.getElementById('al-purpose').value = '';
      await refreshAll();
    } catch (e) { Toast.show(e.message, true); }
  }

  async function addDonation() {
    const body = {
      organization: val('ad-org'), amount: val('ad-amount'), date: val('ad-date'),
      link: val('ad-link'), type: val('ad-type'),
    };
    if (!body.organization || !body.amount) return Toast.show('Enter organization and amount.', true);
    try {
      await api('/admin/donation', { method: 'POST', body });
      Toast.show('Donation added ✅');
      document.getElementById('ad-org').value = '';
      document.getElementById('ad-amount').value = '';
      document.getElementById('ad-link').value = '';
      await refreshAll();
    } catch (e) { Toast.show(e.message, true); }
  }

  /**
   * Fire a notification at every registered device, this one included — the quickest way
   * to tell "push is broken" apart from "nobody has turned notifications on yet".
   */
  async function sendTestPush() {
    const btn = document.getElementById('push-test');
    btn.disabled = true;
    try {
      const r = await api('/admin/push-test', { method: 'POST' });
      const failed = (r.results || []).filter((x) => !x.ok);
      if (!r.results.length) Toast.show('No devices registered yet — tap 🔔 on each phone first.', true);
      else if (failed.length) {
        // Name *and* reason: "failed for Nirob" alone sends you digging through server logs.
        Toast.show(`Sent to ${r.sent}. Failed — ${failed.map((f) => `${f.name} (${f.reason})`).join(', ')}`, true);
      } else Toast.show(`Test sent to ${r.sent} device(s) 🔔`);
      await load();
    } catch (e) { Toast.show(e.message, true); }
    btn.disabled = false;
  }

  async function saveOverride(key) {
    const sel = document.querySelector(`select[data-rule="${key}"]`);
    try {
      await api('/admin/rule-override', { method: 'POST', body: { rule_key: key, final_value: sel.value } });
      Toast.show('Rule updated ⚖️');
      await Rules.load();
      await load(); // re-render admin override list with fresh flags
    } catch (e) { Toast.show(e.message, true); }
  }

  const val = (id) => document.getElementById(id).value.trim();

  return { load };
})();
