/* auth.js — login / first-password / forgot-password flow for login.html */
(function () {
  // If already logged in, go straight to the dashboard.
  if (Session.user) { location.replace('index.html'); return; }

  const $ = (id) => document.getElementById(id);
  const steps = { email: $('step-email'), password: $('step-password'), forgot: $('step-forgot') };
  const msg = $('msg');

  function show(step) {
    Object.entries(steps).forEach(([k, el]) => el.classList.toggle('hidden', k !== step));
    msg.className = 'msg';
  }
  function say(text, kind = 'error') {
    msg.textContent = text;
    msg.className = `msg show ${kind}`;
  }

  // Step 1 → check the email, then either ask for a password or offer first-time setup.
  $('btn-continue').addEventListener('click', async () => {
    const email = $('email').value.trim();
    if (!email) return say('Please enter your email.');
    try {
      const info = await api('/check-email', { method: 'POST', body: { email } });
      $('password').value = '';
      $('pw-label').textContent = info.firstTime
        ? `Welcome ${info.name}! Set a password to get started`
        : `Password for ${info.name}`;
      show('password');
      $('password').focus();
    } catch (e) {
      say(e.message);
    }
  });

  $('btn-login').addEventListener('click', doLogin);
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-continue').click(); });

  async function doLogin() {
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!password) return say('Please enter a password.');
    try {
      const res = await api('/login', { method: 'POST', body: { email, password } });
      Session.set(res.user, res.token);
      location.replace('index.html');
    } catch (e) {
      say(e.message);
    }
  }

  // Forgot-password flow: ask for a reset. No password is ever proposed or revealed —
  // the admin just clears the old one, then the member sets a fresh one on next login.
  $('to-forgot').addEventListener('click', () => { $('f-email').value = $('email').value.trim(); show('forgot'); });
  $('back-1').addEventListener('click', () => show('email'));
  $('back-2').addEventListener('click', () => show('email'));
  $('btn-forgot').addEventListener('click', async () => {
    const email = $('f-email').value.trim();
    if (!email) return say('Enter your email.');
    try {
      const res = await api('/forgot', { method: 'POST', body: { email } });
      say(res.message, 'ok');
    } catch (e) {
      say(e.message);
    }
  });
})();
