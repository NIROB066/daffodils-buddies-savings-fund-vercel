/* chatlive.js — everything that makes the chat feel alive:
     • short-polls for new messages (incremental, via /api/chat?since=)
     • a slowly-blinking green dot + unread count wherever chat isn't on screen
     • web notifications (works on Android/desktop, and on iPhone once the app is
       added to the Home Screen — that's why we register a service worker)
     • on phones, a minimized chat bubble that expands into a bottom sheet, so you
       can chat from any page without leaving it. */
const ChatLive = (function () {
  const SEEN_KEY = 'daf_chat_seen';
  const HINT_KEY = 'daf_ios_hint';
  const FULL_KEY = 'daf_chat_full';
  const POLL_ACTIVE = 5000;    // tab in the foreground
  const POLL_IDLE = 20000;     // tab hidden — be gentle on the free-tier host

  let unread = 0, timer = null, swReg = null, dockOpen = false;
  let pushOn = false;                       // server can reach this device while it's closed
  let homeParent = null, homeNext = null;   // where #pane-chat lives when docked away
  let rev = '';                             // server's chat fingerprint, see /api/chat/live
  let reported = 0;                         // highest id we've told the server we've read

  const me = () => (Session.user && Session.user.name) || '';
  const seenId = () => parseInt(localStorage.getItem(SEEN_KEY) || '0', 10) || 0;
  const setSeen = (id) => { try { localStorage.setItem(SEEN_KEY, String(id)); } catch {} };

  /* ---- is the chat actually on screen right now? ---- */
  function chatVisible() {
    if (document.hidden) return false;
    if (dockOpen) return true;
    const pane = document.getElementById('pane-chat');
    if (!pane || !pane.classList.contains('active')) return false;
    // On a phone only the active section renders; on desktop the panel is always there.
    return Nav.isPhone() ? Nav.active === 'community' : true;
  }

  /* ---- unread badge + blinking dot ---- */
  function setUnread(n) {
    unread = Math.max(0, n);
    const on = unread > 0;

    document.querySelectorAll('.live-dot').forEach((d) => d.classList.toggle('on', on));

    const badge = document.getElementById('chat-fab-badge');
    if (badge) { badge.textContent = unread > 9 ? '9+' : String(unread); badge.hidden = !on; }

    // Chat tab in the segmented control + Corner in the bottom nav.
    const tab = document.querySelector('#social-seg button[data-pane="chat"]');
    if (tab) tab.classList.toggle('has-new', on);
    const corner = document.querySelector('#bottom-nav button[data-key="community"]');
    if (corner) corner.classList.toggle('has-new', on);

    document.title = on ? `(${unread}) Daffodils Buddies Fund` : 'Daffodils Buddies Fund';
  }

  function markRead() {
    const last = Community.lastId();
    if (last) setSeen(last);
    setUnread(0);
    // Let the others' ✓✓ catch up. Only when the marker actually moves.
    if (last > reported) {
      reported = last;
      api('/chat/seen', { method: 'POST', body: { id: last } }).catch(() => { reported = 0; });
    }
  }

  /* ---- notifications ---- */
  function describe(m) {
    if (m.text) return m.text.slice(0, 120);
    return { image: '📷 Photo', video: '🎬 Video', audio: '🎙 Voice message', file: '📎 File' }[m.media_type] || 'New message';
  }

  /**
   * In-page fallback for when a push subscription isn't available. This can only ever fire
   * while the app is awake — on iOS the JS is frozen the moment you leave the app — so the
   * real delivery path is the `push` handler in sw.js.
   */
  function notify(msgs) {
    if (pushOn) return;                       // the server already pushed this one
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const mine = msgs.filter((m) => Community.mentionsMe(m));
    const lead = mine[0] || msgs[msgs.length - 1];
    const title = mine.length
      ? `${lead.member} mentioned you 💬`
      : msgs.length > 1
        ? `${msgs.length} new messages in Buddies chat`
        : `${lead.member} · Daffodils Buddies`;
    const opts = {
      body: describe(lead),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'daf-chat',
      renotify: true,
      data: { url: '/' },
    };
    // showNotification via the SW is the only path iOS accepts (and it survives tab close).
    try {
      if (swReg && swReg.showNotification) swReg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch { /* some browsers throw on the constructor — never break the poll */ }
  }

  /* ---- web push ---- */

  /** VAPID keys travel as base64url; pushManager wants raw bytes. */
  function urlB64ToBytes(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  /** Was this subscription created for the VAPID key the server is using now? */
  function keyMatches(sub, bytes) {
    const current = sub.options && sub.options.applicationServerKey;
    if (!current) return true;   // can't tell — assume it's fine rather than churn
    const a = new Uint8Array(current);
    return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
  }

  /**
   * Hand this device's push address to the server so it can reach us with the app closed.
   * Safe to call repeatedly — re-registering the same endpoint just refreshes the row.
   */
  async function subscribePush() {
    if (!swReg || !swReg.pushManager || !Session.token) return false;
    try {
      const { key } = await api('/push/key');
      const bytes = urlB64ToBytes(key);
      let sub = await swReg.pushManager.getSubscription();

      // A subscription is bound to the server's VAPID key. If that key changed (say
      // data/vapid.json was lost on a redeploy), the old one can never be delivered to —
      // it would look "subscribed" while silently receiving nothing. Replace it.
      if (sub && !keyMatches(sub, bytes)) {
        const stale = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        api('/push/unsubscribe', { method: 'POST', body: { endpoint: stale } }).catch(() => {});
        sub = null;
      }
      if (!sub) {
        sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        });
      }
      await api('/push/subscribe', { method: 'POST', body: { subscription: sub } });
      pushOn = true;
      return true;
    } catch {
      pushOn = false;      // fall back to the in-page notification
      return false;
    }
  }

  async function askPermission() {
    if (!window.isSecureContext) {
      return Toast.show('Notifications need a secure (https) address.', true);
    }
    // iOS only exposes the Notification API inside a Home Screen app — in a browser tab it
    // is simply absent, so say what to do rather than "unsupported".
    if (isIOS() && !isStandalone()) {
      showInstallHint(true);
      return Toast.show('On iPhone: tap Share → "Add to Home Screen", then open it and tap 🔔.', true);
    }
    if (!('Notification' in window)) return Toast.show('This browser has no notification support.', true);
    if (Notification.permission === 'denied') {
      return Toast.show('Notifications are blocked — enable them in your browser settings.', true);
    }
    if (Notification.permission === 'granted') {
      const ok = await subscribePush();
      refreshBell();
      return Toast.show(ok ? 'Notifications are on 🔔' : 'Notifications on — but this device can\'t receive push.', !ok);
    }

    const res = await Notification.requestPermission();
    if (res === 'granted') {
      const ok = await subscribePush();
      Toast.show(ok
        ? 'Notifications on! 🔔 We\'ll ping you for new messages — even when the app is closed.'
        : 'Notifications on! 🔔 (Alerts arrive while the app is open.)');
    } else {
      Toast.show('No problem — the green dot will still show new messages.');
    }
    refreshBell();
  }

  const isIOS = () =>
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  /** One-time nudge: on iOS nothing can be delivered until the app lives on the Home Screen. */
  function showInstallHint(force) {
    const hint = document.getElementById('ios-install-hint');
    if (!hint || !isIOS() || isStandalone()) return;
    if (!force && localStorage.getItem(HINT_KEY)) return;
    hint.hidden = false;
  }

  function dismissInstallHint() {
    const hint = document.getElementById('ios-install-hint');
    if (hint) hint.hidden = true;
    try { localStorage.setItem(HINT_KEY, '1'); } catch {}
  }

  function refreshBell() {
    const btn = document.getElementById('notify-toggle');
    if (!btn) return;
    const granted = 'Notification' in window && Notification.permission === 'granted';
    btn.classList.toggle('on', granted);
    btn.title = pushOn
      ? 'Notifications are on — even when the app is closed'
      : granted ? 'Notifications are on while the app is open'
        : 'Turn on new-message notifications';
  }

  /* ---- polling ---- */

  /**
   * One request carries everything the thread needs: new messages, who's typing, and how
   * far everyone has read. `rev` is the server's fingerprint of the mutable bits — when
   * ours is stale we get the whole thread back instead, which is how a reaction, edit or
   * delete on an *older* message reaches us (a `since=` cursor could never see it).
   */
  async function poll() {
    try {
      const state = await api(`/chat/live?since=${Community.lastId()}&rev=${encodeURIComponent(rev)}`);
      rev = state.rev;
      Community.setTyping(state.typing);
      Community.setReceipts(state.receipts);

      const added = state.full ? Community.replaceAll(state.full) : Community.applyIncoming(state.messages);
      const fromOthers = added.filter((m) => m.member !== me());
      if (!fromOthers.length) return;

      if (chatVisible()) {
        markRead();
        Community.scrollToBottom();
      } else {
        setUnread(unread + fromOthers.length);
        notify(fromOthers);
      }
    } catch { /* offline or asleep — just try again next tick */ }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(poll, document.hidden ? POLL_IDLE : POLL_ACTIVE);
  }

  /* ---- mobile dock ---- */
  function openDock(full) {
    const pane = document.getElementById('pane-chat');
    homeParent = pane.parentNode;
    homeNext = pane.nextSibling;
    document.getElementById('dock-body').appendChild(pane);
    pane.classList.add('active');

    document.getElementById('chat-dock').hidden = false;
    document.getElementById('dock-scrim').hidden = false;
    setFull(full === undefined ? localStorage.getItem(FULL_KEY) === '1' : full);
    requestAnimationFrame(() => {
      document.getElementById('chat-dock').classList.add('open');
      document.getElementById('dock-scrim').classList.add('open');
    });
    dockOpen = true;
    markRead();
    Community.scrollToBottom();
    syncFab();
  }

  /** Bottom sheet ↔ whole screen. Remembered, because it's a personal preference. */
  function setFull(on) {
    const dock = document.getElementById('chat-dock');
    dock.classList.toggle('full', !!on);
    const btn = document.getElementById('dock-full');
    btn.innerHTML = on ? ICON.shrink : ICON.expand;
    btn.title = on ? 'Exit full screen' : 'Full screen';
    try { localStorage.setItem(FULL_KEY, on ? '1' : '0'); } catch {}
  }

  function toggleFull() {
    setFull(!document.getElementById('chat-dock').classList.contains('full'));
    Community.scrollToBottom();
  }

  function closeDock() {
    const dock = document.getElementById('chat-dock');
    const scrim = document.getElementById('dock-scrim');
    dock.classList.remove('open');
    scrim.classList.remove('open');
    dockOpen = false;

    const pane = document.getElementById('pane-chat');
    if (homeParent) homeParent.insertBefore(pane, homeNext);
    // Restore whichever social tab the segmented control says is active.
    const active = document.querySelector('#social-seg button.active');
    const key = active ? active.dataset.pane : 'chat';
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${key}`));

    setTimeout(() => { dock.hidden = true; scrim.hidden = true; }, 260);
    syncFab();
  }

  /** The bubble only makes sense on a phone, on a page that isn't the chat itself. */
  function syncFab() {
    const fab = document.getElementById('chat-fab');
    if (!fab) return;
    fab.hidden = !(Nav.isPhone() && !dockOpen && Nav.active !== 'community');
    // Keep the "next section" FAB out of the chat bubble's way.
    const next = document.getElementById('next-fab');
    if (next) next.classList.toggle('shifted', !fab.hidden);
  }

  /* ---- boot ---- */
  function init() {
    // Service worker: makes the app installable, and is what receives Web Push — the only
    // way a notification reaches a phone whose screen is locked.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then(() => navigator.serviceWorker.ready)
        .then((reg) => {
          swReg = reg;
          // Already allowed? Re-register silently so notifications stay on by default,
          // on every device, without anyone having to tap the bell again.
          if ('Notification' in window && Notification.permission === 'granted') {
            return subscribePush().then(refreshBell);
          }
        })
        .catch(() => { /* not fatal — notifications fall back to the in-page path */ });
      // Tapping a notification asks the page to surface the chat.
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (!e.data || e.data.type !== 'open-chat') return;
        if (Nav.isPhone() && Nav.active !== 'community') return openDock();
        const tab = document.querySelector('#social-seg button[data-pane="chat"]');
        if (tab) tab.click();
        markRead();
        Community.scrollToBottom();
      });
    }

    document.getElementById('notify-toggle').addEventListener('click', askPermission);
    document.getElementById('chat-fab').addEventListener('click', () => openDock());
    document.getElementById('dock-close').addEventListener('click', closeDock);
    document.getElementById('dock-full').addEventListener('click', toggleFull);
    document.getElementById('dock-scrim').addEventListener('click', closeDock);
    // On the Corner page the chat is inline and short; this hands it the whole screen.
    document.getElementById('chat-expand').addEventListener('click', () => openDock(true));
    const hintClose = document.getElementById('ios-hint-close');
    if (hintClose) hintClose.addEventListener('click', dismissInstallHint);
    refreshBell();
    // On iPhone, notifications are impossible until the app is on the Home Screen — say so
    // once, up front, instead of letting the bell fail silently.
    showInstallHint(false);

    // Seeing the chat clears the badge.
    document.getElementById('social-seg').addEventListener('click', () => setTimeout(() => {
      if (chatVisible()) markRead();
    }, 0));
    window.addEventListener('nav:change', () => { syncFab(); if (chatVisible()) markRead(); });
    window.addEventListener('resize', syncFab);
    document.addEventListener('visibilitychange', () => {
      schedule();
      if (chatVisible()) markRead(); else poll();
    });

    // Count what arrived while we were away, then start polling.
    const missed = Community.lastId() - seenId();
    if (chatVisible()) markRead();
    else setUnread(missed > 0 ? missed : 0);

    syncFab();
    schedule();
  }

  return { init, markRead, syncFab, openDock, closeDock };
})();
