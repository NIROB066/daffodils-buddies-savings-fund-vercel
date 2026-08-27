/* nav.js — navigation.
   Desktop (>720px): the left column shows all fund sections in one scroll; the social
   panel is always visible on the right. A chip nav jumps to a fund section.
   Phone (<=720px): one section at a time via bottom nav + swipe + Next. Community is
   first so chat & memories greet you right at the start. */
const Nav = (function () {
  // Fund sections live in the left column; community is the right panel.
  const FUND = [
    { key: 'overview',  label: 'Overview',  icon: 'heart' },
    { key: 'invest',    label: 'Invest',    icon: 'wallet' },
    { key: 'loans',     label: 'Loans',     icon: 'hands' },
    { key: 'donations', label: 'Donate',    icon: 'gift' },
    { key: 'rules',     label: 'Rules',     icon: 'scroll' },
    { key: 'admin',     label: 'Admin',     icon: 'tool', adminOnly: true },
  ];
  const COMMUNITY = { key: 'community', label: 'Corner', icon: 'flower' };

  // Phone bottom-nav order — Community first (our friends care about it most).
  let mobileOrder = [];
  let active = 'community';
  const isPhone = () => window.matchMedia('(max-width: 720px)').matches;

  function build(isAdmin) {
    const fund = FUND.filter((s) => !s.adminOnly || isAdmin);
    mobileOrder = [COMMUNITY, ...fund];

    // Desktop chip nav (fund sections only; community is always on the right).
    const chip = document.getElementById('chipnav');
    chip.innerHTML = '';
    fund.forEach((s) => {
      const b = document.createElement('button');
      b.innerHTML = `<span class="chip-ic">${ICON[s.icon] || ''}</span> ${s.label}`;
      b.dataset.key = s.key;
      b.addEventListener('click', () => go(s.key));
      chip.appendChild(b);
    });

    // Mobile bottom nav (community + fund).
    const bottom = document.getElementById('bottom-nav');
    bottom.innerHTML = '';
    mobileOrder.forEach((s) => {
      const b = document.createElement('button');
      b.dataset.key = s.key;
      b.innerHTML = `<span class="ic">${ICON[s.icon] || ''}</span><span>${s.label}</span>`;
      b.addEventListener('click', () => go(s.key));
      bottom.appendChild(b);
    });

    if (!isAdmin) document.getElementById('admin-section').style.display = 'none';
    applyMode();
    go(isPhone() ? 'community' : 'overview');
  }

  function applyMode() {
    document.getElementById('main').classList.toggle('mobile', isPhone());
  }

  function go(key) {
    if (!mobileOrder.some((s) => s.key === key)) key = mobileOrder[0].key;
    active = key;
    document.querySelectorAll('#chipnav button, #bottom-nav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.key === key);
    });

    if (isPhone()) {
      document.querySelectorAll('.section').forEach((el) => el.classList.toggle('active', el.dataset.key === key));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      // Desktop: scroll the chosen fund section into view (community is always visible).
      const el = document.querySelector(`.main-col .section[data-key="${key}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    window.dispatchEvent(new CustomEvent('nav:change', { detail: { key } }));
  }

  function step(dir) {
    const idx = mobileOrder.findIndex((s) => s.key === active);
    const n = mobileOrder.length;
    go(mobileOrder[(idx + dir + n) % n].key);
  }

  function initGestures() {
    document.getElementById('next-fab').addEventListener('click', () => step(1));

    let x0 = null, y0 = null;
    const main = document.getElementById('main');
    main.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    main.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      // Ignore swipes that start on a horizontal scroller (chat/tables) less strictly:
      if (isPhone() && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) step(dx < 0 ? 1 : -1);
      x0 = y0 = null;
    }, { passive: true });

    // Crossing the phone/desktop breakpoint (rotating, resizing) changes how sections
    // are shown, so re-select the current one — otherwise nothing carries `.active`
    // and the phone layout would render an empty page.
    let wasPhone = isPhone();
    window.addEventListener('resize', () => {
      applyMode();
      if (isPhone() !== wasPhone) { wasPhone = isPhone(); go(active); }
    });
  }

  return { build, go, initGestures, get active() { return active; }, isPhone };
})();
