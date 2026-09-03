/* community.js — photo slider, posts feed, and chat with replies, @mentions,
   reactions, editing, search and attachments (photo / voice / video / any file).

   Cross-device playback: we never transcode. Instead every clip is probed with
   canPlayType() and, if this browser can't decode it (e.g. a Chrome-recorded .webm
   opened on an iPhone), we render a download card rather than a dead player. */
const Community = (function () {
  let photos = [], posts = [], chat = [], people = [];
  let slideIdx = 0, slideTimer = null, replyTo = null;
  let pendingMedia = null;   // { kind, file }
  let editingId = null;      // message being edited in place
  let receipts = {};         // name → highest message id that person has read
  let typing = [];           // names currently typing
  let term = '';             // chat search term (lower-cased)
  let hits = [], hitIdx = 0; // ids of matching messages + which one we're parked on
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉'];
  const SPEEDS = [1, 1.5, 2];
  const mediaUrl = (value) => /^https?:\/\//i.test(String(value || ''))
    ? value : `/uploads/${encodeURIComponent(value || '')}`;
  const myName = () => (Session.user && Session.user.name) || '';

  // In-flight upload feedback + the server's hard caps (chat 30 MB, memories 8 MB).
  let sendingMedia = null;                       // label of the media being sent, or null
  const MAX_CHAT_MEDIA = 30 * 1024 * 1024;
  const MAX_MEMORY_PHOTO = 8 * 1024 * 1024;
  // Vercel's serverless functions refuse request bodies over 4.5 MB (multipart
  // overhead included), so anything at/above 4 MB rides the direct-to-Blob path.
  const DIRECT_UPLOAD_MIN = 4 * 1024 * 1024;

  // Vercel's serverless functions refuse request bodies over 4.5 MB, so any video
  // clip bigger than that used to die with a vague error (multer never even ran).
  // The browser SDK lets us PUT the bytes straight into Blob storage instead. It is
  // loaded once, on demand, from a pinned CDN; if that ever fails we fall back to
  // the classic server upload, which still handles anything under the function cap.
  const BLOB_CLIENT_URL = 'https://esm.sh/@vercel/blob@2.8.0/client?target=es2020&bundle';
  let blobClientPromise = null;
  function loadBlobClient() {
    if (!blobClientPromise) {
      blobClientPromise = import(BLOB_CLIENT_URL).catch((error) => {
        blobClientPromise = null; // transient blip? try again on the next send
        throw error;
      });
    }
    return blobClientPromise;
  }

  /** The three bouncing dots reused everywhere a send is in flight. */
  function dotsHtml(extraClass = '') {
    return `<span class="typing-dots ${extraClass}"><i></i><i></i><i></i></span>`;
  }

  /** A "Sending…" bubble pinned to the bottom of the thread while an upload goes up. */
  function sendingBubbleHtml(label) {
    return `<div class="bubble mine sending" data-id="pending" aria-busy="true">
      <div class="txt">${esc(label)}</div>
      <div class="brow">${dotsHtml()} <span class="stamp">Sending…</span></div>
    </div>`;
  }

  /**
   * Upload a staged chat file. Files at/above 4 MB go straight into Vercel Blob
   * from the browser (scoped client token + PUT) — the only way to get past the
   * 4.5 MB serverless-function body cap — then return the Blob URL to the server.
   * Small files and backends without Blob keep the classic server upload.
   */
  async function uploadChatMedia(file, text, replyTo) {
    const kind = /^image\//.test(file.type) ? 'image'
      : /^video\//.test(file.type) ? 'video'
        : /^audio\//.test(file.type) ? 'audio' : 'file';

    let sdk = null;
    if (file.size >= DIRECT_UPLOAD_MIN || kind === 'video') {
      try { sdk = await loadBlobClient(); } catch { /* CDN unreachable → classic */ }
      if (sdk && sdk.put) {
        try {
          const meta = await api('/uploads/client-token', {
            method: 'POST',
            body: { kind: 'chat', name: file.name, type: file.type || 'application/octet-stream', size: file.size },
          });
          const blob = await sdk.put(meta.pathname, file, {
            access: 'public',
            token: meta.token,
            contentType: file.type || 'application/octet-stream',
          });
          return await api('/chat/media-url', {
            method: 'POST',
            body: {
              url: blob.url, media_type: kind, media_name: file.name,
              media_size: file.size, text, reply_to: replyTo || '',
            },
          });
        } catch (error) {
          // No Blob store on this backend → send it through the server as before.
          if (error && error.status === 501) { /* fall through to classic */ }
          else throw error;
        }
      }
    }

    const form = new FormData();
    form.append('media', file);
    form.append('text', text);
    form.append('reply_to', replyTo || '');
    return await api('/chat/media', { method: 'POST', form });
  }

  /** Memory photo upload — same direct-to-Blob strategy as chat media. */
  async function uploadMemoryPhoto(file, caption) {
    let sdk = null;
    if (file.size >= DIRECT_UPLOAD_MIN) {
      try { sdk = await loadBlobClient(); } catch { /* CDN unreachable → classic */ }
      if (sdk && sdk.put) {
        try {
          const meta = await api('/uploads/client-token', {
            method: 'POST',
            body: { kind: 'photo', name: file.name, type: file.type || 'application/octet-stream', size: file.size },
          });
          const blob = await sdk.put(meta.pathname, file, {
            access: 'public',
            token: meta.token,
            contentType: file.type || 'application/octet-stream',
          });
          return await api('/photos-url', { method: 'POST', body: { url: blob.url, caption } });
        } catch (error) {
          if (error && error.status === 501) { /* fall through to classic */ }
          else throw error;
        }
      }
    }

    const form = new FormData();
    form.append('photo', file);
    form.append('caption', caption);
    return await api('/photos', { method: 'POST', form });
  }

  /** Post image upload — direct-to-Blob on Vercel, multipart elsewhere. */
  async function uploadPostImage(file, text) {
    let sdk = null;
    if (file.size >= DIRECT_UPLOAD_MIN) {
      try { sdk = await loadBlobClient(); } catch { /* CDN unreachable → classic */ }
      if (sdk && sdk.put) {
        try {
          const meta = await api('/uploads/client-token', {
            method: 'POST',
            body: { kind: 'photo', name: file.name, type: file.type || 'application/octet-stream', size: file.size },
          });
          const blob = await sdk.put(meta.pathname, file, {
            access: 'public',
            token: meta.token,
            contentType: file.type || 'application/octet-stream',
          });
          return await api('/posts/photo-url', { method: 'POST', body: { url: blob.url, text } });
        } catch (error) {
          if (error && error.status === 501) { /* fall through to classic */ }
          else throw error;
        }
      }
    }

    const form = new FormData();
    form.append('photo', file);
    form.append('text', text);
    return await api('/posts/photo', { method: 'POST', form });
  }

  /** Busy state for a button: bouncing dots + a "Uploading…"-style label, or restore. */
  function setButtonLoading(btn, busyLabel) {
    if (!btn) return;
    if (busyLabel) {
      if (btn.dataset.restore === undefined) btn.dataset.restore = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('loading');
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = `<span class="btn-dots"><i></i><i></i><i></i></span> ${esc(busyLabel)}…`;
    } else {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
      if (btn.dataset.restore !== undefined) {
        btn.innerHTML = btn.dataset.restore;
        delete btn.dataset.restore;
        hydrateIcons(btn); // the restored <span data-ico> needs its SVG back
      }
    }
  }

  async function load() {
    [photos, posts, chat, people] = await Promise.all([
      api('/photos'), api('/posts'), api('/chat'), api('/people').catch(() => []),
    ]);
    renderSlider();
    renderPosts();
    renderChat();
  }

  /* ---- photo slider ---- */
  function renderSlider() {
    const el = document.getElementById('photo-slider');
    if (!photos.length) {
      // One wrapping <span>: .slide-empty centres with grid, so loose text and <b>
      // would otherwise each become their own row.
      el.innerHTML = `<div class="slide-empty">
        <span>📷 No memories yet — add the first one from <b>Our Corner → Memories</b>!</span>
      </div>`;
      return;
    }
    el.innerHTML = `
      <div class="slides" id="slides">
        ${photos.map((p) => `
          <div class="slide">
            <img src="${esc(mediaUrl(p.filename))}" data-filename="${esc(p.filename)}" alt="${esc(p.caption)}" loading="lazy" />
            <div class="cap"><b>${esc(p.member)}</b>${p.caption ? ' — ' + esc(p.caption) : ''}</div>
          </div>`).join('')}
      </div>
      <div class="dots">${photos.map((_, i) => `<i data-i="${i}"></i>`).join('')}</div>`;
    slideIdx = 0;
    update();
    el.querySelectorAll('.slide img').forEach((image) => image.addEventListener('error', () => {
      photos = photos.filter((photo) => photo.filename !== image.dataset.filename);
      renderSlider();
    }, { once: true }));
    el.querySelectorAll('.dots i').forEach((d) => d.addEventListener('click', () => { slideIdx = +d.dataset.i; update(); restart(); }));
    restart();
  }
  function update() {
    const slides = document.getElementById('slides');
    if (!slides) return;
    slides.style.transform = `translateX(-${slideIdx * 100}%)`;
    document.querySelectorAll('#photo-slider .dots i').forEach((d, i) => d.classList.toggle('on', i === slideIdx));
  }
  function restart() {
    clearInterval(slideTimer);
    if (photos.length > 1) slideTimer = setInterval(() => { slideIdx = (slideIdx + 1) % photos.length; update(); }, 4000);
  }

  /* ---- posts ---- */
  function renderPosts() {
    const el = document.getElementById('posts-feed');
    if (!posts.length) { el.innerHTML = '<div class="empty">No posts yet — say hello! 👋</div>'; return; }
    el.innerHTML = posts.map((p) => `
      <div class="feed-post">
        <div class="ph">
          <span class="avatar-sm" style="background:${avatarColor(p.member)}">${initials(p.member)}</span>
          <div><div class="who">${esc(p.member)}</div><div class="when">${fmtTime(p.timestamp)}</div></div>
        </div>
        ${p.text ? `<div class="body">${linkMentions(linkUrls(esc(p.text)))}</div>` : ''}
        ${p.image ? `<img src="${esc(p.image)}" alt="post image" loading="lazy" />` : ''}
      </div>`).join('');
  }

  /* ---- media helpers ---- */
  const MIME = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    ogv: 'video/ogg', mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
    m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    oga: 'audio/ogg', aac: 'audio/aac', opus: 'audio/ogg', flac: 'audio/flac',
  };
  const ext = (name) => String(name || '').toLowerCase().split('.').pop();

  /** Can THIS browser decode the clip? '' from canPlayType means a definite no. */
  function canPlay(kind, name) {
    const mime = MIME[ext(name)];
    if (!mime) return true;               // unknown container: let the element try
    const probe = document.createElement(kind === 'audio' ? 'audio' : 'video');
    if (!probe.canPlayType) return true;
    return probe.canPlayType(mime) !== '';
  }

  function fmtBytes(n) {
    const b = Number(n) || 0;
    if (!b) return '';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Download URL that restores the original filename via Content-Disposition. */
  function dlUrl(m) {
    return /^https?:\/\//i.test(String(m.media || ''))
      ? m.media : `/download/${encodeURIComponent(m.media)}?name=${encodeURIComponent(m.media_name || m.media)}`;
  }
  function dlBtn(m, label = 'Save') {
    return `<a class="dl-btn" href="${dlUrl(m)}" title="Download ${esc(m.media_name || '')}">${ICON.download}<span>${label}</span></a>`;
  }

  /** A file/unsupported-media card: icon, name, size and a download button. */
  function fileCard(m, note) {
    const name = esc(m.media_name || m.media);
    const size = fmtBytes(m.media_size);
    return `<a class="file-card" href="${dlUrl(m)}">
      <span class="fc-ic">${ICON.file}</span>
      <span class="fc-meta"><b>${name}</b><i>${note || size || 'Tap to download'}</i></span>
      <span class="fc-dl">${ICON.download}</span>
    </a>`;
  }

  /** 1× / 1.5× / 2× — one button that cycles, so it works with a thumb. */
  function speedBtn() {
    return `<button type="button" class="speed-btn" data-speed="0" title="Playback speed">1×</button>`;
  }

  function mediaHtml(m) {
    if (!m.media) return '';
    const url = mediaUrl(m.media);
    const name = m.media_name || m.media;

    if (m.media_type === 'image') {
      return `<div class="media-wrap">
        <img class="chat-media" src="${url}" loading="lazy" alt="${esc(name)}"
             data-full="${url}" data-dl="${dlUrl(m)}" data-cap="${esc(name)}" />
        ${dlBtn(m)}
      </div>`;
    }
    if (m.media_type === 'audio') {
      if (!canPlay('audio', name)) return fileCard(m, "This browser can't play this recording — download it");
      // No `muted`: voice notes must be audible. preload=metadata keeps mobile data down.
      return `<div class="media-wrap">
        <audio class="chat-media" controls playsinline preload="metadata" src="${url}"></audio>
        ${speedBtn()}
        ${dlBtn(m)}
      </div>`;
    }
    if (m.media_type === 'video') {
      if (!canPlay('video', name)) return fileCard(m, "This browser can't play this video — download it");
      // playsinline stops iOS from hijacking the whole screen; controls give volume,
      // and we deliberately do NOT set `muted` so the clip plays with sound.
      return `<div class="media-wrap">
        <video class="chat-media" controls playsinline preload="metadata" src="${url}"></video>
        ${speedBtn()}
        ${dlBtn(m)}
      </div>`;
    }
    return fileCard(m);
  }

  /** Cycle a player through 1× → 1.5× → 2× and label the button with where it landed. */
  function cycleSpeed(btn) {
    const player = btn.closest('.media-wrap').querySelector('video, audio');
    if (!player) return;
    const next = (Number(btn.dataset.speed) + 1) % SPEEDS.length;
    btn.dataset.speed = String(next);
    player.playbackRate = SPEEDS[next];
    btn.textContent = `${SPEEDS[next]}×`;
    btn.classList.toggle('fast', next > 0);
  }

  /* ---- mentions ---- */
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionNames = () => ['all', ...people];

  /* ---- link previews ----
     Metadata is cached per URL for the life of the page. renderChat() runs on every
     poll, so without this a card would be torn down and re-fetched every few seconds —
     which is exactly why previews used to flicker in and out. */
  const previewCache = new Map();    // url → { data, partial, at, tries }
  const previewInFlight = new Set(); // urls we've already asked the server about
  const PREVIEW_RETRY_MS = 60000;
  const PREVIEW_TRIES = 3;

  const youtubeId = (url) =>
    url.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i)?.[1] || '';

  /** The markup for one preview card, from whatever we know about the URL so far. */
  function previewCard(url, data) {
    const yt = youtubeId(url);
    const host = url.match(/^https?:\/\/(?:www\.)?([^/]+)/i)?.[1] || 'Web link';
    const image = (data && data.image) || (yt ? `https://img.youtube.com/vi/${yt}/hqdefault.jpg` : '');
    const title = (data && data.title) || (yt ? 'YouTube video' : host);
    const desc = (data && (data.description || data.site)) || (yt ? 'youtube.com' : 'Open link');
    // A big image reads as a card; a thumbnail-less link stays a compact strip.
    const rich = image ? ' rich' : '';
    return `<a class="url-preview${rich}" data-preview-url="${esc(url)}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
        ${image ? `<img src="${esc(image)}" alt="" loading="lazy" onerror="this.closest('.url-preview').classList.remove('rich');this.remove()" />` : ''}
        <span class="url-preview-info"><b>${esc(title)}</b><small>${esc(desc)}</small></span>
      </a>`;
  }

  /** Turn pasted http(s) URLs into safe links after the message was escaped. */
  function linkUrls(escaped) {
    const links = [];
    const withPlaceholders = escaped.replace(/https?:\/\/[^\s<]+/gi, (value) => {
      const trailing = value.match(/[.,!?;:)\]]+$/)?.[0] || '';
      const raw = trailing ? value.slice(0, -trailing.length) : value;
      // The text arrived HTML-escaped; the URL itself has to go back to its real form
      // before it can be used as an href or looked up in the cache.
      const url = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const token = `\u0000${links.length}\u0000`;
      const card = previewCard(url, (previewCache.get(url) || {}).data);
      links.push(`${card}<a class="chat-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${trailing}`);
      return token;
    });
    return withPlaceholders.replace(/\u0000(\d+)\u0000/g, (_token, index) => links[index]);
  }

  /**
   * Should we (still) ask the server about this URL? A good answer is kept forever; a
   * `partial` one — the server couldn't read the page — is kept too, so the card stays
   * put, but we give it a couple more goes a minute apart before settling for it.
   */
  function needsPreview(url) {
    if (previewInFlight.has(url)) return false;
    const entry = previewCache.get(url);
    if (!entry) return true;
    return entry.partial && entry.tries < PREVIEW_TRIES && Date.now() - entry.at > PREVIEW_RETRY_MS;
  }

  /** Fetch metadata for any card we haven't resolved yet, then patch it in place. */
  function hydratePreviews(root) {
    root.querySelectorAll('.url-preview[data-preview-url]').forEach(async (card) => {
      const url = card.dataset.previewUrl;
      if (!needsPreview(url)) return;
      previewInFlight.add(url);
      let data = null;
      try { data = await api(`/link-preview?url=${encodeURIComponent(url)}`); } catch { /* offline */ }
      previewInFlight.delete(url);
      if (!data) return;
      const tries = ((previewCache.get(url) || {}).tries || 0) + 1;
      previewCache.set(url, { data, partial: !!data.partial, at: Date.now(), tries });
      document.querySelectorAll(`.url-preview[data-preview-url="${CSS.escape(url)}"]`)
        .forEach((node) => { node.outerHTML = previewCard(url, data); });
    });
  }

  /** Wrap @Name in a chip. Runs on already-escaped text, so it can't inject markup. */
  function linkMentions(escaped) {
    const names = mentionNames().sort((a, b) => b.length - a.length).map(reEsc).join('|');
    const re = new RegExp(`@(${names})(?![\\w])`, 'g');
    const me = (Session.user && Session.user.name) || '';
    return escaped.replace(re, (_all, name) =>
      `<span class="mention${name === 'all' || name === me ? ' me' : ''}">@${name}</span>`);
  }

  /** Does this message mention me by name? */
  function mentionsMe(m) {
    const me = (Session.user && Session.user.name) || '';
    if (!me) return false;
    return /@all(?![\w])/i.test(m.text || '') || new RegExp(`@${reEsc(me)}(?![\\w])`).test(m.text || '');
  }

  /* ---- chat ---- */

  /** "Today" / "Yesterday" / "12 Aug 2026" — the divider between days. */
  function dayLabel(stamp) {
    const d = new Date(stamp);
    if (isNaN(d)) return '';
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  const clockOf = (stamp) => {
    const d = new Date(stamp);
    return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };

  /** Delivery state for your own messages: ✓ sent, ✓✓ read (bright once everyone has). */
  function ticksHtml(m, mine) {
    if (!mine) return '';
    const others = people.filter((n) => n && n !== myName());
    if (!others.length) return '';
    const id = parseInt(m.id, 10) || 0;
    const seen = others.filter((n) => (receipts[n] || 0) >= id);
    const title = seen.length ? `Read by ${seen.join(', ')}` : 'Sent';
    return `<span class="ticks ${seen.length === others.length ? 'read' : ''}" title="${esc(title)}">`
      + `${seen.length ? ICON.checks : ICON.check}</span>`;
  }

  function reactionsHtml(m) {
    const entries = Object.entries(m.reactions || {});
    if (!entries.length) return '';
    return `<div class="reacts">${entries.map(([emoji, names]) => `
      <button type="button" class="${names.includes(myName()) ? 'mine' : ''}"
              data-react="${esc(emoji)}" data-id="${esc(m.id)}" title="${esc(names.join(', '))}">
        ${esc(emoji)}<i>${names.length}</i>
      </button>`).join('')}</div>`;
  }

  /** Everything the user typed that we're happy to search: body text + attachment name. */
  const haystack = (m) => `${m.text || ''} ${m.media_name || ''}`.toLowerCase();

  function bubbleHtml(m, byId) {
    const mine = m.member === myName();
    const gone = String(m.deleted) === '1';
    const original = m.reply_to && byId[m.reply_to];
    const ctx = original
      ? `<div class="reply-ctx" data-jump="${esc(m.reply_to)}">↩ ${esc(original.member)}: `
        + `${esc(String(original.deleted) === '1' ? 'deleted message' : (original.text || original.media_type || 'attachment').slice(0, 48))}</div>`
      : '';

    if (gone) {
      return `<div class="bubble gone ${mine ? 'mine' : ''}" data-id="${esc(m.id)}">
        ${mine ? '' : `<div class="who">${esc(m.member)}</div>`}
        <div class="txt">🚫 This message was deleted</div>
        <div class="brow"><span class="stamp">${clockOf(m.timestamp)}</span></div>
      </div>`;
    }

    const body = m.text ? `<div class="txt">${linkMentions(linkUrls(esc(m.text)))}</div>` : '';
    const dim = term && !haystack(m).includes(term) ? ' dimmed' : '';
    return `<div class="bubble ${mine ? 'mine' : ''} ${mentionsMe(m) ? 'hit' : ''}${dim}" data-id="${esc(m.id)}">
      <button type="button" class="mbtn" title="Message actions" data-menu="${esc(m.id)}">${ICON.more}</button>
      ${mine ? '' : `<div class="who">${esc(m.member)}</div>`}
      ${ctx}
      ${mediaHtml(m)}
      ${body}
      ${reactionsHtml(m)}
      <div class="brow">
        <span class="stamp">${clockOf(m.timestamp)}</span>
        ${m.edited_at ? '<span class="edited">edited</span>' : ''}
        <span class="rbtn" data-reply="${esc(m.id)}">reply</span>
        ${ticksHtml(m, mine)}
      </div>
    </div>`;
  }

  function renderChat() {
    const box = document.getElementById('chat-box');
    if (!box) return;
    const byId = Object.fromEntries(chat.map((m) => [String(m.id), m]));

    if (!chat.length) {
      box.innerHTML = '<div class="empty">No messages yet — start the conversation! 💬</div>'
        + (sendingMedia ? sendingBubbleHtml(sendingMedia) : '');
      refreshSearchState();
      return;
    }

    // Keep the scroll pinned to the bottom only if the reader was already there.
    const wasAtBottom = atBottom(box);

    let lastDay = '';
    box.innerHTML = chat.map((m) => {
      const day = dayLabel(m.timestamp);
      const sep = day && day !== lastDay ? `<div class="day-sep"><span>${esc(day)}</span></div>` : '';
      lastDay = day || lastDay;
      return sep + bubbleHtml(m, byId);
    }).join('') + (sendingMedia ? sendingBubbleHtml(sendingMedia) : '');

    hydratePreviews(box);
    highlightMatches(box);
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
    refreshSearchState();
    updateJump();

    // If a player fails at runtime (codec the probe didn't catch), swap in a download card.
    box.querySelectorAll('video.chat-media, audio.chat-media').forEach((el) => {
      el.addEventListener('error', () => {
        const msg = chat.find((c) => String(c.id) === el.closest('.bubble').dataset.id);
        if (msg) el.closest('.media-wrap').outerHTML = fileCard(msg, "Can't play here — download it");
      });
    });
  }

  const atBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 60;

  function scrollToBottom() {
    const box = document.getElementById('chat-box');
    if (box) box.scrollTop = box.scrollHeight;
    missed = 0;
    updateJump();
  }

  /** Scroll a message into view and flash it (used by search and reply context). */
  function jumpTo(id) {
    const el = document.querySelector(`#chat-box .bubble[data-id="${CSS.escape(String(id))}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;   // restart the animation if it's already running
    el.classList.add('flash');
  }

  /* ---- jump-to-latest button ---- */
  let missed = 0;

  function updateJump() {
    const box = document.getElementById('chat-box');
    const btn = document.getElementById('chat-jump');
    if (!box || !btn) return;
    const down = !atBottom(box);
    btn.hidden = !down;
    if (!down) missed = 0;
    const badge = document.getElementById('chat-jump-count');
    badge.hidden = missed < 1;
    badge.textContent = missed > 9 ? '9+' : String(missed);
  }

  /* ---- search ---- */
  function setSearch(value) {
    term = String(value || '').trim().toLowerCase();
    renderChat();
    if (term && hits.length) jumpTo(hits[hitIdx]);
  }

  function refreshSearchState() {
    const previous = hits[hitIdx];
    hits = term ? chat.filter((m) => String(m.deleted) !== '1' && haystack(m).includes(term)).map((m) => String(m.id)) : [];
    hitIdx = Math.max(0, hits.indexOf(String(previous)));

    const count = document.getElementById('chat-search-count');
    if (!count) return;
    count.hidden = !term;
    count.textContent = hits.length ? `${hitIdx + 1}/${hits.length}` : 'none';
    ['chat-search-prev', 'chat-search-next', 'chat-search-clear'].forEach((id) => {
      document.getElementById(id).hidden = !term;
    });
  }

  function stepSearch(delta) {
    if (!hits.length) return;
    hitIdx = (hitIdx + delta + hits.length) % hits.length;
    refreshSearchState();
    jumpTo(hits[hitIdx]);
  }

  /**
   * Wrap search matches in <mark>. Done over text nodes after rendering rather than in
   * the HTML string, so it can never break a link or inject markup.
   */
  function highlightMatches(root) {
    if (!term) return;
    root.querySelectorAll('.bubble:not(.dimmed) .txt').forEach((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const lower = node.nodeValue.toLowerCase();
        if (!lower.includes(term)) continue;
        const frag = document.createDocumentFragment();
        let from = 0;
        for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, from)) {
          frag.append(node.nodeValue.slice(from, at));
          const mark = document.createElement('mark');
          mark.textContent = node.nodeValue.slice(at, at + term.length);
          frag.append(mark);
          from = at + term.length;
        }
        frag.append(node.nodeValue.slice(from));
        node.replaceWith(frag);
      }
    });
  }

  function setReply(id) {
    const m = chat.find((x) => String(x.id) === String(id));
    if (!m) return;
    cancelEdit();
    replyTo = String(id);
    const label = String(m.deleted) === '1' ? 'deleted message'
      : (m.text || { image: 'Photo', video: 'Video', audio: 'Voice message', file: 'File' }[m.media_type] || 'message');
    document.getElementById('reply-text').textContent = `Replying to ${m.member}: ${label.slice(0, 60)}`;
    document.getElementById('reply-banner').classList.add('show');
    document.getElementById('chat-text').focus();
  }
  function clearReply() {
    replyTo = null;
    document.getElementById('reply-banner').classList.remove('show');
  }

  /* ---- edit / delete / react ---- */
  function startEdit(id) {
    const m = chat.find((x) => String(x.id) === String(id));
    if (!m || m.member !== myName() || String(m.deleted) === '1') return;
    clearReply();
    editingId = String(id);
    const ta = document.getElementById('chat-text');
    ta.value = m.text || '';
    autoGrow(ta);
    ta.focus();
    document.getElementById('edit-banner').classList.add('show');
  }

  function cancelEdit() {
    if (!editingId) return;
    editingId = null;
    const ta = document.getElementById('chat-text');
    ta.value = '';
    autoGrow(ta);
    document.getElementById('edit-banner').classList.remove('show');
  }

  /** Swap an updated message into the local thread and repaint. */
  function replaceMessage(msg) {
    const at = chat.findIndex((m) => String(m.id) === String(msg.id));
    if (at === -1) return;
    chat[at] = msg;
    renderChat();
  }

  async function deleteMessage(id) {
    if (!confirm('Delete this message for everyone?')) return;
    try {
      replaceMessage(await api(`/chat/${encodeURIComponent(id)}`, { method: 'DELETE' }));
      Toast.show('Message deleted.');
    } catch (e) { Toast.show(e.message, true); }
  }

  async function react(id, emoji) {
    try {
      replaceMessage(await api(`/chat/${encodeURIComponent(id)}/react`, { method: 'POST', body: { emoji } }));
    } catch (e) { Toast.show(e.message, true); }
  }

  async function copyMessage(id) {
    const m = chat.find((x) => String(x.id) === String(id));
    const text = m && (m.text || m.media_name);
    if (!text) return Toast.show('Nothing to copy.', true);
    try {
      await navigator.clipboard.writeText(text);
      Toast.show('Copied to clipboard 📋');
    } catch { Toast.show('Your browser blocked the clipboard.', true); }
  }

  /* ---- message action menu (⋯ button, long-press, right-click) ---- */
  function closeMenu() {
    document.getElementById('msg-menu').hidden = true;
    document.getElementById('msg-menu-scrim').hidden = true;
  }

  function openMenu(id, anchor) {
    const m = chat.find((x) => String(x.id) === String(id));
    if (!m || String(m.deleted) === '1') return;
    const mine = m.member === myName();
    const isAdmin = Session.user && Session.user.isAdmin;

    document.getElementById('mm-reacts').innerHTML = REACTIONS.map((emoji) => {
      const on = ((m.reactions || {})[emoji] || []).includes(myName());
      return `<button type="button" class="${on ? 'on' : ''}" data-emoji="${esc(emoji)}">${esc(emoji)}</button>`;
    }).join('');

    const actions = [
      { key: 'reply', label: 'Reply', icon: ICON.reply },
      ...(m.text ? [{ key: 'copy', label: 'Copy text', icon: ICON.copy }] : []),
      ...(mine && m.text ? [{ key: 'edit', label: 'Edit', icon: ICON.edit }] : []),
      ...(m.media ? [{ key: 'save', label: 'Download attachment', icon: ICON.download }] : []),
      ...(mine || isAdmin ? [{ key: 'delete', label: 'Delete', icon: ICON.trash, danger: true }] : []),
    ];
    document.getElementById('mm-actions').innerHTML = actions.map((a) =>
      `<button type="button" data-act="${a.key}" class="${a.danger ? 'danger' : ''}">${a.icon}<span>${a.label}</span></button>`).join('');

    const menu = document.getElementById('msg-menu');
    menu.dataset.id = String(id);
    menu.hidden = false;
    document.getElementById('msg-menu-scrim').hidden = false;

    // Anchor to the bubble, then nudge back inside the viewport.
    const box = (anchor || document.body).getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left), window.innerWidth - size.width - 8);
    const top = box.bottom + size.height + 8 > window.innerHeight
      ? Math.max(8, box.top - size.height - 6)
      : box.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function runMenuAction(key) {
    const id = document.getElementById('msg-menu').dataset.id;
    closeMenu();
    if (key === 'reply') return setReply(id);
    if (key === 'copy') return copyMessage(id);
    if (key === 'edit') return startEdit(id);
    if (key === 'delete') return deleteMessage(id);
    if (key === 'save') {
      const m = chat.find((x) => String(x.id) === String(id));
      if (m && m.media) window.open(dlUrl(m), '_blank', 'noopener');
    }
  }

  /* ---- photo lightbox ---- */
  function openLightbox(img) {
    document.getElementById('lb-img').src = img.dataset.full;
    document.getElementById('lb-cap').textContent = img.dataset.cap || '';
    document.getElementById('lb-dl').href = img.dataset.dl;
    document.getElementById('lightbox').hidden = false;
  }
  function closeLightbox() {
    document.getElementById('lightbox').hidden = true;
    document.getElementById('lb-img').src = '';
  }

  /* ---- @mention autocomplete ---- */
  let mentionMatches = [], mentionIdx = 0, mentionStart = -1, mentionTarget = null;

  function closeMentions() {
    mentionMatches = []; mentionStart = -1; mentionTarget = null;
    const p1 = document.getElementById('mention-pop');
    if (p1) p1.classList.remove('show');
    const p2 = document.getElementById('post-mention-pop');
    if (p2) p2.classList.remove('show');
  }

  function updateMentions(el) {
    const ta = el || document.getElementById('chat-text');
    if (!ta) return closeMentions();
    mentionTarget = ta;
    const before = ta.value.slice(0, ta.selectionStart);
    const hit = before.match(/(^|\s)@([\p{L}\w]*)$/u);
    if (!hit) return closeMentions();

    const term = hit[2].toLowerCase();
    mentionMatches = mentionNames().filter((n) => n.toLowerCase().startsWith(term));
    if (!mentionMatches.length) return closeMentions();

    mentionStart = before.length - hit[2].length - 1; // index of the '@'
    mentionIdx = 0;
    renderMentions(ta);
  }

  function renderMentions(ta) {
    const pop = (ta && ta.id === 'post-text')
      ? document.getElementById('post-mention-pop')
      : document.getElementById('mention-pop');
    if (!pop) return;
    pop.innerHTML = mentionMatches.map((n, i) => `
      <button type="button" class="${i === mentionIdx ? 'on' : ''}" data-name="${esc(n)}">
        <span class="avatar-sm" style="background:${avatarColor(n)}">${initials(n)}</span>${esc(n)}
      </button>`).join('');
    pop.classList.add('show');
    pop.querySelectorAll('button').forEach((b) =>
      b.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(b.dataset.name); }));
  }

  function pickMention(name) {
    const ta = mentionTarget || document.getElementById('chat-text');
    if (!ta) return closeMentions();
    const caret = ta.selectionStart;
    ta.value = ta.value.slice(0, mentionStart) + `@${name} ` + ta.value.slice(caret);
    const pos = mentionStart + name.length + 2;
    ta.setSelectionRange(pos, pos);
    autoGrow(ta);
    closeMentions();
    ta.focus();
  }

  /** Returns true if the keystroke was consumed by the mention popup. */
  function mentionKey(e) {
    if (!mentionMatches.length) return false;
    if (e.key === 'ArrowDown') { mentionIdx = (mentionIdx + 1) % mentionMatches.length; renderMentions(mentionTarget); return true; }
    if (e.key === 'ArrowUp') { mentionIdx = (mentionIdx - 1 + mentionMatches.length) % mentionMatches.length; renderMentions(mentionTarget); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mentionMatches[mentionIdx]); return true; }
    if (e.key === 'Escape') { closeMentions(); return true; }
    return false;
  }

  /* ---- emoji picker ---- */
  const EMOJI = {
    Smileys: ['😀', '😂', '🥹', '😊', '😍', '🤩', '😘', '😉', '😎', '🤓', '🥳', '🤔', '😅', '😭', '😡', '🥺', '😴', '🤯', '🙄', '😬'],
    Gestures: ['👍', '👎', '👏', '🙏', '🤝', '💪', '✌️', '🤞', '👌', '🙌', '👋', '🫶'],
    Hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💕', '✨', '🔥', '🎉'],
    Life: ['🌼', '🌻', '🌈', '☕', '🍕', '🎂', '⚽', '🎵', '💸', '📸', '🚀', '🏆'],
  };

  function renderEmojiPicker() {
    const pop = document.getElementById('emoji-pop');
    pop.innerHTML = Object.entries(EMOJI).map(([group, list]) => `
      <div class="eg-title">${group}</div>
      <div class="eg-grid">${list.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}</div>`).join('');
  }

  function insertAtCaret(text) {
    const ta = document.getElementById('chat-text');
    const at = ta.selectionStart;
    ta.value = ta.value.slice(0, at) + text + ta.value.slice(ta.selectionEnd);
    ta.setSelectionRange(at + text.length, at + text.length);
    autoGrow(ta);
    ta.focus();
  }

  /* ---- composer helpers ---- */
  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }

  /** Tell the others we're writing — at most once every few seconds. */
  let typingSentAt = 0;
  function pingTyping() {
    if (Date.now() - typingSentAt < 3000) return;
    typingSentAt = Date.now();
    api('/chat/typing', { method: 'POST', body: {} }).catch(() => {});
  }

  /** Accept a file from a picker, a paste or a drop and stage it for sending. */
  function stageFile(file) {
    if (!file) return;
    const kind = /^image\//.test(file.type) ? 'image'
      : /^video\//.test(file.type) ? 'video'
        : /^audio\//.test(file.type) ? 'audio' : 'file';
    pendingMedia = { kind, file };
    renderAttach();
  }

  /* ---- actions ---- */
  function bind() {
    document.getElementById('photo-upload').addEventListener('click', uploadPhoto);
    document.getElementById('post-send').addEventListener('click', sendPost);
    document.getElementById('post-photo').addEventListener('change', () => {
      const file = document.getElementById('post-photo').files[0];
      if (file && file.size > MAX_MEMORY_PHOTO) {
        document.getElementById('post-photo').value = '';
        Toast.show('That image is too big — the limit is 8 MB.', true);
      }
    });
    document.getElementById('chat-send').addEventListener('click', sendChat);
    document.getElementById('reply-cancel').addEventListener('click', clearReply);
    document.getElementById('edit-cancel').addEventListener('click', cancelEdit);

    const ta = document.getElementById('chat-text');
    ta.addEventListener('input', () => { updateMentions(ta); autoGrow(ta); if (ta.value.trim()) pingTyping(); });
    ta.addEventListener('blur', () => setTimeout(closeMentions, 120));
    ta.addEventListener('keydown', (e) => {
      if (mentionKey(e)) { e.preventDefault(); return; }
      if (e.key === 'Escape' && editingId) { e.preventDefault(); return cancelEdit(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
    document.getElementById('mention-btn').addEventListener('click', () => {
      insertAtCaret('@');
      updateMentions(ta);
    });

    const postTa = document.getElementById('post-text');
    if (postTa) {
      postTa.addEventListener('input', () => { updateMentions(postTa); autoGrow(postTa); });
      postTa.addEventListener('blur', () => setTimeout(closeMentions, 120));
      postTa.addEventListener('keydown', (e) => {
        if (mentionKey(e)) { e.preventDefault(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendPost(); }
      });
    }

    bindEmoji();
    bindChatBox();
    bindSearch();
    bindMenu();
    bindLightbox();
    bindDropZone();
    autoGrow(ta);

    // Attachments: photo picks an image, video opens the camera, file takes anything,
    // audio records a live voice message (no file upload).
    const fileInput = document.getElementById('chat-media-file');
    const pick = (kind, accept, capture) => {
      pendingMedia = { kind };
      fileInput.setAttribute('accept', accept);
      if (capture) fileInput.setAttribute('capture', capture);
      else fileInput.removeAttribute('capture');
      fileInput.value = '';
      fileInput.click();
    };
    document.getElementById('attach-photo').addEventListener('click', () => pick('image', 'image/*'));
    // capture="environment" opens the phone camera in video mode; the clip is handed
    // straight to us and is NOT saved to the photo library.
    document.getElementById('attach-video').addEventListener('click', () => pick('video', 'video/*', 'environment'));
    document.getElementById('attach-file').addEventListener('click', () => pick('file', '*/*'));
    document.getElementById('attach-audio').addEventListener('click', toggleRecord);
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) { pendingMedia = null; }
      else if (pendingMedia) { pendingMedia.file = f; }
      else stageFile(f);   // a drop/paste/auto-picked file — classify it ourselves
      renderAttach();
    });
  }

  function bindEmoji() {
    renderEmojiPicker();
    const pop = document.getElementById('emoji-pop');
    document.getElementById('emoji-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeMentions();
      pop.classList.toggle('show');
    });
    pop.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-emoji]');
      if (!btn) return;
      insertAtCaret(btn.dataset.emoji);
      pop.classList.remove('show');
    });
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && e.target.id !== 'emoji-btn') pop.classList.remove('show');
    });
  }

  /** One delegated listener for everything inside the thread. */
  function bindChatBox() {
    const box = document.getElementById('chat-box');

    box.addEventListener('click', (e) => {
      const speed = e.target.closest('.speed-btn');
      if (speed) { e.preventDefault(); return cycleSpeed(speed); }
      const menu = e.target.closest('[data-menu]');
      if (menu) return openMenu(menu.dataset.menu, menu.closest('.bubble'));
      const reply = e.target.closest('[data-reply]');
      if (reply) return setReply(reply.dataset.reply);
      const jump = e.target.closest('[data-jump]');
      if (jump) return jumpTo(jump.dataset.jump);
      const chip = e.target.closest('[data-react]');
      if (chip) return react(chip.dataset.id, chip.dataset.react);
      const photo = e.target.closest('img.chat-media');
      if (photo) return openLightbox(photo);
    });

    box.addEventListener('contextmenu', (e) => {
      const bubble = e.target.closest('.bubble');
      if (!bubble || e.target.closest('a, video, audio')) return;
      e.preventDefault();
      openMenu(bubble.dataset.id, bubble);
    });

    box.addEventListener('scroll', updateJump, { passive: true });
    bindTouchGestures(box);
  }

  /**
   * Phone gestures on a bubble: drag right to reply, press and hold for the action menu.
   * Any real movement cancels the hold, so scrolling never pops the menu open.
   */
  function bindTouchGestures(box) {
    let bubble = null, startX = 0, startY = 0, holdTimer = null, swiping = false;

    const reset = () => {
      clearTimeout(holdTimer);
      if (bubble) bubble.style.transform = '';
      bubble = null; swiping = false;
    };

    box.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return reset();
      const target = e.target.closest('.bubble');
      if (!target || target.classList.contains('gone') || e.target.closest('a, video, audio, button')) return;
      bubble = target;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      holdTimer = setTimeout(() => { openMenu(bubble.dataset.id, bubble); reset(); }, 480);
    }, { passive: true });

    box.addEventListener('touchmove', (e) => {
      if (!bubble) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(holdTimer);
      if (!swiping && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.6) swiping = true;
      if (swiping) bubble.style.transform = `translateX(${Math.max(0, Math.min(dx, 64))}px)`;
    }, { passive: true });

    box.addEventListener('touchend', (e) => {
      if (!bubble) return;
      const dx = (e.changedTouches[0] || {}).clientX - startX;
      const target = bubble;
      const far = swiping && dx > 45;
      reset();
      if (far) setReply(target.dataset.id);
    });
    box.addEventListener('touchcancel', reset);
  }

  function bindSearch() {
    const input = document.getElementById('chat-search-input');
    input.addEventListener('input', () => setSearch(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); input.value = ''; setSearch(''); }
    });
    document.getElementById('chat-search-prev').addEventListener('click', () => stepSearch(-1));
    document.getElementById('chat-search-next').addEventListener('click', () => stepSearch(1));
    document.getElementById('chat-search-clear').addEventListener('click', () => {
      input.value = ''; setSearch(''); input.focus();
    });
    document.getElementById('chat-jump').addEventListener('click', scrollToBottom);
  }

  function bindMenu() {
    document.getElementById('msg-menu-scrim').addEventListener('click', closeMenu);
    document.getElementById('mm-reacts').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-emoji]');
      if (!btn) return;
      const id = document.getElementById('msg-menu').dataset.id;
      closeMenu();
      react(id, btn.dataset.emoji);
    });
    document.getElementById('mm-actions').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) runMenuAction(btn.dataset.act);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeLightbox(); } });
  }

  function bindLightbox() {
    document.getElementById('lb-close').addEventListener('click', closeLightbox);
    document.getElementById('lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox') closeLightbox();
    });
  }

  /** Paste or drop an image/file straight into the composer. */
  function bindDropZone() {
    const zone = document.querySelector('.chat-compose');
    const ta = document.getElementById('chat-text');

    ta.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData ? e.clipboardData.files : [])][0];
      if (!item) return;
      e.preventDefault();
      stageFile(item);
    });

    ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add('dropping');
    }));
    ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.remove('dropping');
    }));
    zone.addEventListener('drop', (e) => stageFile(e.dataTransfer && e.dataTransfer.files[0]));
  }

  /* ---- voice recording (talk, don't upload a file) ---- */
  let recorder = null, recChunks = [], recStart = 0, recTimer = null;

  /** Prefer MP4/AAC where the browser can record it — that's the one container every
      phone and desktop can play back. Chrome only offers WebM, hence the fallback. */
  function bestAudioType() {
    const prefer = ['audio/mp4', 'audio/mpeg', 'audio/webm;codecs=opus', 'audio/webm'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return prefer.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function toggleRecord() {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return Toast.show('Voice recording is not supported on this browser.', true);
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return Toast.show('Please allow microphone access to record.', true); }

    recChunks = [];
    const type = bestAudioType();
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      const mt = (recorder && recorder.mimeType) || 'audio/webm';
      const x = mt.includes('mp4') || mt.includes('m4a') ? 'm4a'
        : mt.includes('mpeg') ? 'mp3' : mt.includes('ogg') ? 'ogg' : 'webm';
      const blob = new Blob(recChunks, { type: mt });
      pendingMedia = { kind: 'audio', file: new File([blob], `voice_${Date.now()}.${x}`, { type: mt }) };
      document.getElementById('attach-audio').classList.remove('recording');
      renderAttach();
    };
    recorder.start();
    recStart = performance.now();
    document.getElementById('attach-audio').classList.add('recording');
    renderRecording();
    recTimer = setInterval(renderRecording, 250);
  }

  function renderRecording() {
    const el = document.getElementById('chat-attach');
    const secs = Math.floor((performance.now() - recStart) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    el.innerHTML = `<span class="chip recording"><span class="rec-dot"></span> Recording ${mm}:${ss}</span>
      <span class="rec-actions"><button class="btn small" id="rec-stop">Stop</button><span class="x" id="rec-cancel">✕</span></span>`;
    el.classList.add('show');
    document.getElementById('rec-stop').addEventListener('click', () => recorder && recorder.stop());
    document.getElementById('rec-cancel').addEventListener('click', () => {
      recChunks = [];
      if (recorder) { recorder.onstop = null; try { recorder.stop(); } catch {} recorder.stream && recorder.stream.getTracks().forEach((t) => t.stop()); }
      clearInterval(recTimer);
      recorder = null; pendingMedia = null;
      document.getElementById('attach-audio').classList.remove('recording');
      renderAttach();
    });
  }

  function renderAttach() {
    const el = document.getElementById('chat-attach');
    if (!pendingMedia || !pendingMedia.file) { el.classList.remove('show'); el.innerHTML = ''; return; }
    const f = pendingMedia.file;
    const label = { audio: '🎙 Voice message ready', video: '🎬 Video', image: '📷 Photo', file: '📎 File' }[pendingMedia.kind];
    const text = pendingMedia.kind === 'audio'
      ? label
      : `${label}: ${esc(f.name.slice(0, 24))} · ${fmtBytes(f.size)}`;
    el.innerHTML = `<span class="chip">${text}</span><span class="x" id="attach-cancel">✕</span>`;
    el.classList.add('show');
    document.getElementById('attach-cancel').addEventListener('click', () => { pendingMedia = null; renderAttach(); });
  }

  async function uploadPhoto() {
    const file = document.getElementById('photo-file').files[0];
    if (!file) return Toast.show('Choose an image first.', true);
    if (file.size > MAX_MEMORY_PHOTO) return Toast.show('That image is too big — the limit is 8 MB.', true);
    const btn = document.getElementById('photo-upload');
    setButtonLoading(btn, 'Uploading');
    const caption = document.getElementById('photo-cap').value;
    try {
      await uploadMemoryPhoto(file, caption);
      document.getElementById('photo-file').value = '';
      document.getElementById('photo-cap').value = '';
      Toast.show('Photo uploaded! 📸');
      await load();
    } catch (e) { Toast.show(e.message, true); }
    finally { setButtonLoading(btn, null); }
  }

  async function sendPost() {
    const text = document.getElementById('post-text').value.trim();
    const image = document.getElementById('post-photo').files[0];
    if (!text && !image) return Toast.show('Write something or add a photo.', true);
    if (image && image.size > MAX_MEMORY_PHOTO) return Toast.show('That image is too big — the limit is 8 MB.', true);
    const btn = document.getElementById('post-send');
    setButtonLoading(btn, image ? 'Uploading' : 'Posting');
    try {
      await (image ? uploadPostImage(image, text) : api('/posts', { method: 'POST', body: { text } }));
      document.getElementById('post-text').value = '';
      document.getElementById('post-photo').value = '';
      Toast.show('Posted! 🌼');
      posts = await api('/posts'); renderPosts();
    } catch (e) { Toast.show(e.message, true); }
    finally { setButtonLoading(btn, null); }
  }

  async function sendChat() {
    const ta = document.getElementById('chat-text');
    const text = ta.value.trim();
    closeMentions();
    document.getElementById('emoji-pop').classList.remove('show');

    if (editingId) {
      if (!text) return Toast.show('Message is empty — delete it instead.', true);
      const id = editingId;
      try {
        const msg = await api(`/chat/${encodeURIComponent(id)}`, { method: 'PATCH', body: { text } });
        cancelEdit();
        replaceMessage(msg);
      } catch (e) { Toast.show(e.message, true); }
      return;
    }

    if (pendingMedia && pendingMedia.file) {
      const file = pendingMedia.file;
      if (file.size > MAX_CHAT_MEDIA) return Toast.show('That file is too big — the limit is 30 MB.', true);
      const label = { image: 'Photo', video: 'Video', audio: 'Voice message', file: 'File' }[pendingMedia.kind] || 'File';
      const btn = document.getElementById('chat-send');
      btn.disabled = true;
      sendingMedia = `Sending ${label}…`;
      renderChat();                 // show the bouncing-dots bubble straight away
      scrollToBottom();
      try {
        const msg = await uploadChatMedia(file, text, replyTo || '');
        ta.value = ''; autoGrow(ta); pendingMedia = null; renderAttach(); clearReply();
        sendingMedia = null;
        chat.push(msg); renderChat(); scrollToBottom();
      } catch (e) {
        sendingMedia = null;
        renderChat();               // take the stuck "Sending…" bubble away
        Toast.show(e.message, true);
      } finally { btn.disabled = false; }
      return;
    }

    if (!text) return;
    try {
      const msg = await api('/chat', { method: 'POST', body: { text, reply_to: replyTo || '' } });
      ta.value = ''; autoGrow(ta); clearReply();
      chat.push(msg); renderChat(); scrollToBottom();
    } catch (e) { Toast.show(e.message, true); }
  }

  /* ---- live-poll hooks (used by chatlive.js) ---- */

  /** The whole thread, straight from the server — used when reactions/edits moved on. */
  function replaceAll(list) {
    const known = new Set(chat.map((m) => String(m.id)));
    const fresh = list.filter((m) => !known.has(String(m.id)));
    chat = list;
    renderChat();
    return fresh;
  }

  /** Merge freshly-polled messages; returns the ones that were actually new. */
  function applyIncoming(list) {
    const known = new Set(chat.map((m) => String(m.id)));
    const fresh = list.filter((m) => !known.has(String(m.id)));
    if (!fresh.length) return [];
    chat.push(...fresh);
    if (!atBottom(document.getElementById('chat-box'))) {
      missed += fresh.filter((m) => m.member !== myName()).length;
    }
    renderChat();
    return fresh;
  }

  /** Who is typing right now (names, excluding me). */
  function setTyping(names) {
    const next = (names || []).filter(Boolean);
    if (next.join('|') === typing.join('|')) return;
    typing = next;
    const row = document.getElementById('typing-row');
    if (!row) return;
    row.hidden = !typing.length;
    if (!typing.length) return;
    const who = typing.length === 1 ? `${typing[0]} is typing`
      : typing.length === 2 ? `${typing[0]} and ${typing[1]} are typing`
        : 'Several buddies are typing';
    row.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span><span>${esc(who)}…</span>`;
  }

  /** How far each buddy has read — drives the ✓/✓✓ on your own messages. */
  function setReceipts(map) {
    const next = map || {};
    if (JSON.stringify(next) === JSON.stringify(receipts)) return;
    receipts = next;
    renderChat();
  }

  const lastId = () => chat.reduce((max, m) => Math.max(max, parseInt(m.id, 10) || 0), 0);

  async function reloadPosts() {
    try {
      posts = await api('/posts');
      renderPosts();
    } catch {}
  }

  return {
    load, bind, renderChat, applyIncoming, replaceAll, lastId, scrollToBottom,
    mentionsMe, setTyping, setReceipts, reloadPosts,
  };
})();
