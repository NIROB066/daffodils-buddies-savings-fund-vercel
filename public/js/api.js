/* api.js — tiny fetch wrapper + shared session helpers. */
const Session = {
  get user() {
    try { return JSON.parse(localStorage.getItem('daf_user') || 'null'); }
    catch { return null; }
  },
  set(user, token) {
    localStorage.setItem('daf_user', JSON.stringify(user));
    localStorage.setItem('daf_token', token);
  },
  get token() { return localStorage.getItem('daf_token') || ''; },
  clear() { localStorage.removeItem('daf_user'); localStorage.removeItem('daf_token'); },
};

async function api(pathname, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (Session.token) headers['x-user'] = Session.token;
  let payload;
  if (form) {
    payload = form; // FormData: let the browser set the content-type boundary.
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${pathname}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
  return data;
}

// Colorful, stable avatar color per name.
function avatarColor(name) {
  const colors = ['#2fbf71', '#f2c14e', '#56c4e8', '#a78bfa', '#ff6b6b', '#7ff0c0'];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return colors[h % colors.length];
}
function initials(name) { return String(name || '?').trim().charAt(0).toUpperCase(); }

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  return '৳' + v.toLocaleString('en-IN');
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(s) {
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
