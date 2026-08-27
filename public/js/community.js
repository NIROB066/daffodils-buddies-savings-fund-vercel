/* community.js — photo slider, posts feed, and chat with replies, @mentions and
   attachments (photo / voice / video / any file).

   Cross-device playback: we never transcode. Instead every clip is probed with
   canPlayType() and, if this browser can't decode it (e.g. a Chrome-recorded .webm
   opened on an iPhone), we render a download card rather than a dead player. */
const Community = (function () {
  let photos = [], posts = [], chat = [], people = [];
  let slideIdx = 0, slideTimer = null, replyTo = null;
  let pendingMedia = null; // { kind, file }

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
            <img src="/uploads/${esc(p.filename)}" data-filename="${esc(p.filename)}" alt="${esc(p.caption)}" loading="lazy" />
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
        ${p.text ? `<div>${esc(p.text)}</div>` : ''}
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
    return `/download/${encodeURIComponent(m.media)}?name=${encodeURIComponent(m.media_name || m.media)}`;
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

  function mediaHtml(m) {
    if (!m.media) return '';
    const url = `/uploads/${encodeURIComponent(m.media)}`;
    const name = m.media_name || m.media;

    if (m.media_type === 'image') {
      return `<div class="media-wrap">
        <img class="chat-media" src="${url}" loading="lazy" alt="${esc(name)}" />
        ${dlBtn(m)}
      </div>`;
    }
    if (m.media_type === 'audio') {
      if (!canPlay('audio', name)) return fileCard(m, "This browser can't play this recording — download it");
      // No `muted`: voice notes must be audible. preload=metadata keeps mobile data down.
      return `<div class="media-wrap">
        <audio class="chat-media" controls playsinline preload="metadata" src="${url}"></audio>
        ${dlBtn(m)}
      </div>`;
    }
    if (m.media_type === 'video') {
      if (!canPlay('video', name)) return fileCard(m, "This browser can't play this video — download it");
      // playsinline stops iOS from hijacking the whole screen; controls give volume,
      // and we deliberately do NOT set `muted` so the clip plays with sound.
      return `<div class="media-wrap">
        <video class="chat-media" controls playsinline preload="metadata" src="${url}"></video>
        ${dlBtn(m)}
      </div>`;
    }
    return fileCard(m);
  }

  /* ---- mentions ---- */
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Wrap @Name in a chip. Runs on already-escaped text, so it can't inject markup. */
  function linkMentions(escaped) {
    if (!people.length) return escaped;
    const names = [...people].sort((a, b) => b.length - a.length).map(reEsc).join('|');
    const re = new RegExp(`@(${names})(?![\\w])`, 'g');
    const me = (Session.user && Session.user.name) || '';
    return escaped.replace(re, (_all, name) =>
      `<span class="mention${name === me ? ' me' : ''}">@${name}</span>`);
  }

  /** Does this message mention me by name? */
  function mentionsMe(m) {
    const me = (Session.user && Session.user.name) || '';
    if (!me) return false;
    return new RegExp(`@${reEsc(me)}(?![\\w])`).test(m.text || '');
  }

  /* ---- chat ---- */
  function renderChat() {
    const box = document.getElementById('chat-box');
    if (!box) return;
    const me = Session.user && Session.user.name;
    const byId = Object.fromEntries(chat.map((m) => [String(m.id), m]));

    if (!chat.length) {
      box.innerHTML = '<div class="empty">No messages yet — start the conversation! 💬</div>';
      return;
    }

    // Keep the scroll pinned to the bottom only if the reader was already there.
    const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

    box.innerHTML = chat.map((m) => {
      const mine = m.member === me;
      const ctx = m.reply_to && byId[m.reply_to]
        ? `<div class="reply-ctx">↩ ${esc(byId[m.reply_to].member)}: ${esc((byId[m.reply_to].text || '').slice(0, 40))}</div>` : '';
      const body = m.text ? `<div class="txt">${linkMentions(esc(m.text))}</div>` : '';
      return `<div class="bubble ${mine ? 'mine' : ''} ${mentionsMe(m) ? 'hit' : ''}" data-id="${esc(m.id)}">
        ${mine ? '' : `<div class="who">${esc(m.member)}</div>`}
        ${ctx}
        ${mediaHtml(m)}
        ${body}
        <div class="brow">
          <span class="stamp">${fmtTime(m.timestamp)}</span>
          <span class="rbtn" data-reply="${esc(m.id)}" data-who="${esc(m.member)}" data-text="${esc((m.text || '').slice(0, 40))}">reply</span>
        </div>
      </div>`;
    }).join('');

    if (wasAtBottom) box.scrollTop = box.scrollHeight;
    box.querySelectorAll('.rbtn').forEach((b) =>
      b.addEventListener('click', () => setReply(b.dataset.reply, b.dataset.who, b.dataset.text)));

    // If a player fails at runtime (codec the probe didn't catch), swap in a download card.
    box.querySelectorAll('video.chat-media, audio.chat-media').forEach((el) => {
      el.addEventListener('error', () => {
        const msg = chat.find((c) => String(c.id) === el.closest('.bubble').dataset.id);
        if (msg) el.closest('.media-wrap').outerHTML = fileCard(msg, "Can't play here — download it");
      });
    });
  }

  function scrollToBottom() {
    const box = document.getElementById('chat-box');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function setReply(id, who, text) {
    replyTo = id;
    document.getElementById('reply-text').textContent = `Replying to ${who}: ${text}`;
    document.getElementById('reply-banner').classList.add('show');
    document.getElementById('chat-text').focus();
  }
  function clearReply() {
    replyTo = null;
    document.getElementById('reply-banner').classList.remove('show');
  }

  /* ---- @mention autocomplete ---- */
  let mentionMatches = [], mentionIdx = 0, mentionStart = -1;

  function closeMentions() {
    mentionMatches = []; mentionStart = -1;
    document.getElementById('mention-pop').classList.remove('show');
  }

  function updateMentions() {
    const ta = document.getElementById('chat-text');
    const before = ta.value.slice(0, ta.selectionStart);
    const hit = before.match(/(^|\s)@([\p{L}\w]*)$/u);
    if (!hit) return closeMentions();

    const term = hit[2].toLowerCase();
    mentionMatches = people.filter((n) => n.toLowerCase().startsWith(term));
    if (!mentionMatches.length) return closeMentions();

    mentionStart = before.length - hit[2].length - 1; // index of the '@'
    mentionIdx = 0;
    renderMentions();
  }

  function renderMentions() {
    const pop = document.getElementById('mention-pop');
    pop.innerHTML = mentionMatches.map((n, i) => `
      <button type="button" class="${i === mentionIdx ? 'on' : ''}" data-name="${esc(n)}">
        <span class="avatar-sm" style="background:${avatarColor(n)}">${initials(n)}</span>${esc(n)}
      </button>`).join('');
    pop.classList.add('show');
    pop.querySelectorAll('button').forEach((b) =>
      b.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(b.dataset.name); }));
  }

  function pickMention(name) {
    const ta = document.getElementById('chat-text');
    const caret = ta.selectionStart;
    ta.value = ta.value.slice(0, mentionStart) + `@${name} ` + ta.value.slice(caret);
    const pos = mentionStart + name.length + 2;
    ta.setSelectionRange(pos, pos);
    closeMentions();
    ta.focus();
  }

  /** Returns true if the keystroke was consumed by the mention popup. */
  function mentionKey(e) {
    if (!mentionMatches.length) return false;
    if (e.key === 'ArrowDown') { mentionIdx = (mentionIdx + 1) % mentionMatches.length; renderMentions(); return true; }
    if (e.key === 'ArrowUp') { mentionIdx = (mentionIdx - 1 + mentionMatches.length) % mentionMatches.length; renderMentions(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mentionMatches[mentionIdx]); return true; }
    if (e.key === 'Escape') { closeMentions(); return true; }
    return false;
  }

  /* ---- actions ---- */
  function bind() {
    document.getElementById('photo-upload').addEventListener('click', uploadPhoto);
    document.getElementById('post-send').addEventListener('click', sendPost);
    document.getElementById('chat-send').addEventListener('click', sendChat);
    document.getElementById('reply-cancel').addEventListener('click', clearReply);

    const ta = document.getElementById('chat-text');
    ta.addEventListener('input', updateMentions);
    ta.addEventListener('blur', () => setTimeout(closeMentions, 120));
    ta.addEventListener('keydown', (e) => {
      if (mentionKey(e)) { e.preventDefault(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    document.getElementById('mention-btn').addEventListener('click', () => {
      const pos = ta.selectionStart;
      ta.value = ta.value.slice(0, pos) + '@' + ta.value.slice(pos);
      ta.setSelectionRange(pos + 1, pos + 1);
      ta.focus();
      updateMentions();
    });

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
      else { pendingMedia.file = f; }
      renderAttach();
    });
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
    const form = new FormData();
    form.append('photo', file);
    form.append('caption', document.getElementById('photo-cap').value);
    try {
      await api('/photos', { method: 'POST', form });
      document.getElementById('photo-file').value = '';
      document.getElementById('photo-cap').value = '';
      Toast.show('Photo uploaded! 📸');
      await load();
    } catch (e) { Toast.show(e.message, true); }
  }

  async function sendPost() {
    const text = document.getElementById('post-text').value.trim();
    if (!text) return Toast.show('Write something to post.', true);
    try {
      await api('/posts', { method: 'POST', body: { text } });
      document.getElementById('post-text').value = '';
      Toast.show('Posted! 🌼');
      posts = await api('/posts'); renderPosts();
    } catch (e) { Toast.show(e.message, true); }
  }

  async function sendChat() {
    const ta = document.getElementById('chat-text');
    const text = ta.value.trim();
    closeMentions();

    if (pendingMedia && pendingMedia.file) {
      const form = new FormData();
      form.append('media', pendingMedia.file);
      form.append('text', text);
      form.append('reply_to', replyTo || '');
      const btn = document.getElementById('chat-send');
      btn.disabled = true;
      try {
        const msg = await api('/chat/media', { method: 'POST', form });
        ta.value = ''; pendingMedia = null; renderAttach(); clearReply();
        chat.push(msg); renderChat(); scrollToBottom();
      } catch (e) { Toast.show(e.message, true); }
      finally { btn.disabled = false; }
      return;
    }

    if (!text) return;
    try {
      const msg = await api('/chat', { method: 'POST', body: { text, reply_to: replyTo || '' } });
      ta.value = ''; clearReply();
      chat.push(msg); renderChat(); scrollToBottom();
    } catch (e) { Toast.show(e.message, true); }
  }

  /* ---- live-poll hooks (used by chatlive.js) ---- */
  /** Merge freshly-polled messages; returns the ones that were actually new. */
  function applyIncoming(list) {
    const known = new Set(chat.map((m) => String(m.id)));
    const fresh = list.filter((m) => !known.has(String(m.id)));
    if (!fresh.length) return [];
    chat.push(...fresh);
    renderChat();
    return fresh;
  }
  const lastId = () => chat.reduce((max, m) => Math.max(max, parseInt(m.id, 10) || 0), 0);

  return { load, bind, renderChat, applyIncoming, lastId, scrollToBottom, mentionsMe };
})();
