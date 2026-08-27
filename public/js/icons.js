/* icons.js — a small set of clean line icons (Lucide-derived), inlined as SVG so the UI
   doesn't rely on emoji. ICON[name] returns markup; hydrate() fills any [data-ico] node. */
const ICON = (function () {
  const S = (body) =>
    `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return {
    heart:  S('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>'),
    wallet: S('<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-2"/><path d="M21 12a2 2 0 0 0-2-2h-4a2 2 0 0 0 0 4h4a2 2 0 0 0 2-2Z"/>'),
    hands:  S('<path d="M12 6 8.5 2.5a2.1 2.1 0 0 0-3 3L11 11"/><path d="m12 6 3.5-3.5a2.1 2.1 0 0 1 3 3L13 11"/><path d="M3 11h4l3 3 2-2 3 3h5"/><path d="M3 11v4a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4"/>'),
    gift:   S('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>'),
    scroll: S('<path d="M8 21h9a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v12"/><path d="M5 17a2 2 0 0 0 2 2M9 7h6M9 11h6M9 15h4"/>'),
    tool:   S('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2l-6 6a1.4 1.4 0 0 0 2 2l6-6a4 4 0 0 0 5.2-5.4l-2.3 2.3-2.1-.6-.6-2.1Z"/><circle cx="18" cy="6" r="3"/>'),
    flower: S('<circle cx="12" cy="12" r="2.5"/><path d="M12 9.5c0-3 1-5 0-6.5-1 1.5 0 3.5 0 6.5Zm0 5c0 3-1 5 0 6.5 1-1.5 0-3.5 0-6.5Zm2.5-2.5c3 0 5-1 6.5 0-1.5 1-3.5 0-6.5 0Zm-5 0c-3 0-5-1-6.5 0 1.5 1 3.5 0 6.5 0Z"/>'),
    message:S('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-4-1L3 20l1.1-4.9A8.4 8.4 0 1 1 21 11.5Z"/>'),
    image:  S('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/>'),
    edit:   S('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    send:   S('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>'),
    trash:  S('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/>'),
    plus:   S('<path d="M12 5v14M5 12h14"/>'),
    camera: S('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h8l2 3h3a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/>'),
    mic:    S('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    video:  S('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8Z"/>'),
    upload: S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
    sun:    S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon:   S('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'),
    logout: S('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
    x:      S('<path d="M18 6 6 18M6 6l12 12"/>'),
    clip:   S('<path d="M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.48-8.48"/>'),
    file:   S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>'),
    download:S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
    bell:   S('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    at:     S('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>'),
    chevron:S('<path d="m6 9 6 6 6-6"/>'),
  };
})();

/** Replace the contents of every [data-ico] element under root with its icon SVG. */
function hydrateIcons(root) {
  (root || document).querySelectorAll('[data-ico]').forEach((el) => {
    const name = el.getAttribute('data-ico');
    if (ICON[name]) el.innerHTML = ICON[name];
  });
}
document.addEventListener('DOMContentLoaded', () => hydrateIcons());
