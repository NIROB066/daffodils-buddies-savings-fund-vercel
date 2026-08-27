/* app.js — bootstrap: session guard, header (theme + user), nav, social tabs, data load. */
const Toast = {
  show(text, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(this._t);
    this._t = setTimeout(() => { el.className = 'toast'; }, 2600);
  },
};

const Theme = {
  get() { return document.documentElement.getAttribute('data-theme') || 'light'; },
  set(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('daf_theme', t); } catch {}
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.innerHTML = ICON[t === 'dark' ? 'sun' : 'moon'];
  },
  toggle() { this.set(this.get() === 'dark' ? 'light' : 'dark'); },
  init() { this.set(this.get()); },
};

// Segmented control for the social panel (Chat / Memories / Posts).
function initSocialTabs() {
  const seg = document.getElementById('social-seg');
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${b.dataset.pane}`));
  }));
}

(async function () {
  const user = Session.user;
  if (!user) { location.replace('login.html'); return; }

  Theme.init();
  document.getElementById('theme-toggle').addEventListener('click', () => Theme.toggle());

  // Header identity.
  document.getElementById('chip-name').textContent = user.name + (user.isAdmin ? ' · admin' : '');
  const av = document.getElementById('chip-avatar');
  av.textContent = initials(user.name);
  av.style.background = avatarColor(user.name);

  // User menu.
  const menu = document.getElementById('user-menu');
  document.getElementById('user-chip').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('click', () => menu.classList.add('hidden'));
  document.getElementById('menu-logout').addEventListener('click', () => { Session.clear(); location.replace('login.html'); });

  initSocialTabs();
  Nav.build(user.isAdmin);
  Nav.initGestures();
  Community.bind();

  try {
    await Dashboard.load();
    await Rules.load();
    await Community.load();
    if (user.isAdmin) await Admin.load();
    // Chat polling / unread dot / notifications / mobile dock — after the first load,
    // so it starts from a known message id instead of re-announcing the whole history.
    ChatLive.init();
  } catch (e) {
    console.error(e);
    if (e.status === 401 || e.status === 403) { Session.clear(); location.replace('login.html'); return; }
    Toast.show('Could not load data: ' + e.message, true);
  }
})();
