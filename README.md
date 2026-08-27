# Daffodils Buddies Savings Fund 🌼

A colorful, mobile-friendly web app for four friends (**Nirob, Yen, Riyad, Nasif**) running a
monthly savings fund together: track investments/loans/donations, see the voted house rules,
and socialize (photo memories, posts, chat).

Built to be fun to open, not enterprise-grade — see [Design priorities](#design-priorities).

## Stack

| Layer    | Choice                                            |
|----------|----------------------------------------------------|
| Backend  | Node.js + Express (`server.js`), no build step      |
| Frontend | Vanilla HTML/CSS/JS (`public/`), no framework       |
| Database | Google Sheets tabs in Vercel; CSV files remain local fallback |
| Uploads  | Google Drive in Vercel; `multer` → `$DATA_DIR/uploads/` locally |
| Notifications | Web Push (`web-push` + VAPID) via `public/sw.js` |

## Project structure

```
.
├── server.js               # static file serving + JSON API (routes below)
├── api/index.js             # Vercel serverless entrypoint
├── lib/
│   ├── csv.js               # CSV parse/stringify (handles quotes, commas, newlines)
│   ├── google-storage.js     # Google Sheets + Drive provider
│   ├── paths.js              # where live data lives ($DATA_DIR / mounted disk / bundled data/)
│   ├── fund.js               # balance & "loan available now" math (the ONLY place with money math)
│   ├── push.js                # Web Push: VAPID keys, device subscriptions, fan-out on new chat
│   └── rules.js               # tally votes → winner, detect ties, apply admin overrides
├── scripts/
│   └── seed-rules.js          # rebuild data/rules_votes.csv from rules.xlsx
├── public/
│   ├── index.html              # dashboard shell (Overview/Invest/Loans/Donate/Rules/Admin + Our Corner)
│   ├── login.html               # login / set-password / forgot-password page
│   ├── css/styles.css            # all styling
│   └── js/
│       ├── api.js                  # tiny fetch wrapper
│       ├── auth.js                  # login/logout/session
│       ├── app.js                    # boot + tab/section wiring
│       ├── nav.js                     # top chip-nav + mobile bottom nav
│       ├── dashboard.js                 # Overview / Investments / Loans / Donations rendering
│       ├── rules.js                      # Rules tab (vote tally banner + rule list)
│       ├── community.js                   # photo slider, posts feed, chat (+ photo/audio/video)
│       ├── admin.js                        # admin tab (add ledger rows, reset passwords, push health)
│       └── icons.js                         # inline SVG icon set
├── data/                    # SEED data — copied to DATA_DIR when a file is missing there
│   ├── login.csv               # email,name,password,is_admin,reset_request
│   ├── investments.csv          # id,member,amount,date
│   ├── loans.csv                 # id,member,amount,date,purpose,status,due_date
│   ├── donations.csv              # id,organization,amount,date,link,type
│   ├── rules_votes.csv             # rule_key,label,Nirob,Yen,Riyad,Nasif
│   ├── rules_overrides.csv          # rule_key,final_value (admin decision beats the tally)
│   ├── posts.csv, chat.csv, photos.csv  # community content
│   └── uploads/                      # uploaded images (git-ignored, folder kept via .gitkeep)
├── rules.xlsx                # source spreadsheet for the house-rules vote (local only, git-ignored)
├── project-idea.txt          # original project brief (local only, git-ignored)
├── CLAUDE.md                 # instructions for AI coding agents working on this repo
├── Procfile                  # `web: node server.js` (Render/Railway/Heroku-style start command)
├── ecosystem.config.js       # pm2 process definition for self-hosting (sets DATA_DIR + PORT)
└── package.json
```

## Project spec

- Four friends each save **৳250/month** into a shared fund.
- The fund is used for **personal loans** in times of need, and occasional **donations** to
  charitable organizations.
- **House rules** are decided by vote (see `rules.xlsx`) — the option with the most votes wins;
  an admin override in `data/rules_overrides.csv` always beats the tally (used for ties or
  free-form decisions).
- **Money math** (see `lib/fund.js`) lives in exactly one place:
  - `balance = Σ investments − Σ outstanding loans − Σ donations`
  - `loanAvailableNow = max(0, min(50% × balance, balance − 20% × totalInvested))`
- **Login** (`data/login.csv`): members start password-less; the first successful login (by
  email) lets them set a password. "Forgot password" records a reset *request* — no password
  is proposed or stored. The admin approves by **clearing** the password, and the member
  chooses a new one on their next login.
- **Admin** (the `is_admin=1` row in `data/login.csv`): can add investments/loans/donations,
  manage member emails, reset (never read) passwords, clear chat/posts/photos, and set rule
  overrides.
- **Our Corner**: a chat with replies + photo/audio/video attachments, a post feed, and an
  auto-sliding photo slider ("Memories") at the top of the dashboard.
- Currency is always shown as **BDT (৳)**.

### API routes (all under `/api`, JSON in/out)

| Method & path                              | Purpose                                  |
|---------------------------------------------|-------------------------------------------|
| `POST /login`, `/check-email`, `/forgot`      | auth flow                                 |
| `GET /summary`                                 | balance, loan-available-now, totals        |
| `GET /rules`                                    | vote tally + winners                        |
| `GET /investments` `/loans` `/donations` `/members` | read-only ledgers                      |
| `GET/POST /posts`, `/chat`                       | community feed & chat                      |
| `POST /chat/media`, `/photos`, `/posts/photo`      | uploads (multer)                          |
| `GET /push/key`, `POST /push/subscribe` `/push/unsubscribe` | Web Push registration            |
| `GET /admin/push-status`, `POST /admin/push-test`   | which devices are reachable + test push |
| `POST /admin/reset-password`                         | blank a member's password (never read/set one) |
| `POST/DELETE /admin/*`                              | admin-only writes (requires admin session) |

## Design priorities

Per the project brief: **UI delight > security**. Auth is intentionally simple — a token in
`localStorage` identifies the user and the server trusts it. This is a private app for four
friends, not a public product; don't add heavy auth or turn this into a hardened system.
Local development keeps data in CSV files. Vercel uses Google Sheets as the database and Google
Drive as the upload store. Follow the beginner-friendly deployment guide below.

## Deploying to Vercel

### 1. Create the Google Sheet

Create or use one Google Spreadsheet. The app treats each tab as one CSV file. Keep these tab
names exactly as written:

`login`, `investments`, `loans`, `donations`, `rules_votes`, `overrides`, `posts`, `chat`,
`photos`

The first row of every tab must contain that CSV file's header. The existing CSV headers are
listed in the `data/` folder. The app creates a `push_subs` tab automatically when notifications
are used.

Copy the Spreadsheet ID from its URL:

```text
https://docs.google.com/spreadsheets/d/THIS_IS_THE_SHEET_ID/edit
```

### 2. Create a Google service account

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project, or select an existing project.
2. Enable **Google Sheets API** and **Google Drive API**.
3. Open **IAM & Admin → Service Accounts** and create a service account.
4. Create a JSON key for it and download the file temporarily. Never commit this file.
5. Copy the service account email. It looks like `something@project.iam.gserviceaccount.com`.

Share the Spreadsheet with that email as **Editor**. Create a Google Drive folder for uploads,
share that folder with the same email as **Editor**, and copy the folder ID from its URL:

```text
https://drive.google.com/drive/folders/THIS_IS_THE_FOLDER_ID
```

### 3. Deploy the app

Push the project to GitHub, then go to [vercel.com](https://vercel.com/), choose **Add New →
Project**, import the repository, and click **Deploy**. The first deploy may show a storage error;
that is expected until the environment variables are added.

Open the Vercel project and go to **Settings → Environment Variables**. Add these four required
variables for **Production**, **Preview**, and **Development**:

| Variable | Value |
|---|---|
| `GOOGLE_SHEET_ID` | The Spreadsheet ID from step 1 |
| `GOOGLE_DRIVE_FOLDER_ID` | The Drive folder ID from step 2 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | The service account email |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | The `private_key` value from the downloaded JSON key |

For the private key, paste the complete value including `BEGIN PRIVATE KEY` and `END PRIVATE
KEY`. Keep the `\\n` characters if Vercel displays them that way. Do not paste the whole JSON file.
Then choose **Redeploy** from the Vercel deployment menu.

At this point the app works, and data survives Vercel redeploys. Test login, adding one small
investment, and uploading one image before inviting everyone.

### 4. Optional: enable phone notifications

VAPID is only for Web Push notifications. It is not a Google password, not a Vercel password,
and not needed for the dashboard, savings records, chat, or uploads. You can skip this step.

If you want notifications, run this locally in the project folder:

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

The command prints two values: `publicKey` and `privateKey`. Add them to Vercel as:

| Variable | Value |
|---|---|
| `VAPID_PUBLIC` | The printed `publicKey` |
| `VAPID_PRIVATE` | The printed `privateKey` |
| `VAPID_SUBJECT` | Your email, for example `mailto:you@example.com` |

Generate these keys once and keep them forever. Do not generate new keys on every deploy, or
phones will need to subscribe again. After adding them, redeploy and enable notifications from
the app on each device.

### Troubleshooting Vercel

- **Storage unavailable:** check all four Google variables and confirm the Sheet and Drive folder
  are shared with the service-account email.
- **Private key error:** paste only the JSON file's `private_key` value, including both header and
  footer. Keep its newline escapes.
- **Images do not load:** confirm the Drive folder is shared with the service account and the
  upload completed after the latest deployment.
- **Notifications do not work:** confirm all three `VAPID_*` variables exist, then redeploy. The
  app itself does not require VAPID.

## Run it locally

Requires Node.js **>= 18**.

```bash
npm install     # first time only
npm start       # serves http://localhost:3000  (honors $PORT if set)
```

Log in with the admin account below, or as one of the four members (first login sets a password).

> ⚠️ `npm start` is for **development only**. It sets no `DATA_DIR`, so the app reads and
> writes the repo's own `data/` seed folder — anything you add or delete in the UI shows up as
> a dirty git working tree. To actually host the app, use
> [Self-hosting on your own PC](#self-hosting-on-your-own-pc-pm2--cloudflare-tunnel), which
> starts it via `ecosystem.config.js` and keeps live data outside the repo.

### Seed / regenerate rules

The voting matrix lives in `rules.xlsx`. To rebuild `data/rules_votes.csv` from it:

```bash
npm run seed
```

This parses the spreadsheet (no external deps — unzips the `.xlsx` and reads the XML) and
rewrites `data/rules_votes.csv`. It does **not** touch `data/rules_overrides.csv` or any ledger.

### Accounts

Credentials are **not** kept in this README — look them up in `data/login.csv`, which is the
only place they live.

- **Admin:** the row with `is_admin=1`. Change its `password` field to rotate the admin password.
- **Members:** Nirob, Yen, Riyad, Nasif — start with an empty password; first login sets it.

**Passwords belong to their owner — not to the admin.** The admin panel never displays or
accepts a member's password; the only control is *Reset password*, which blanks it so the
member picks a new one at their next login. `/api/admin/members` deliberately returns just a
`hasPassword` flag.

> `data/login.csv` still holds passwords in plain text on disk. Keep this repository
> **private**, and never paste real passwords into README.md, CLAUDE.md, issues or commit
> messages.

### Resetting demo data

Empty a ledger by leaving only its header row, e.g. `data/investments.csv` →
`id,member,amount,date`.

## Chat notifications (Web Push)

New chat messages are delivered by **real Web Push**, not by the page's polling loop. When
someone posts, the server signs a push with its VAPID keys and hands it to the browser's push
service, which wakes `public/sw.js` and draws the notification — so alerts arrive even when
the app is completely closed. (The in-page poll still drives the green dot and unread badge;
it can't be the notification path, because phones freeze a backgrounded app's JavaScript.)

- Local hosting can generate keys into `<DATA_DIR>/vapid.json`. Vercel must use the same
  `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT` values on every deployment; its
  `push_subs` tab stores the registered devices in Google Sheets.
- VAPID is optional. Without it, the app's dashboard, records, uploads, and chat still work;
  only push notifications are unavailable.
- Notifications require **https** — they will not work over a plain LAN address like
  `http://192.168.x.x:3000`. `localhost` counts as secure for desktop testing.
- **You never get a notification for your own message.** The server skips the sender's own
  devices, so testing by messaging yourself from one phone always looks broken. Use the
  **Send a test notification** button in the Admin tab, which pushes to everyone including you.

### Checking who can be reached

The Admin tab has a 🔔 **Notifications** card listing every device that has registered, grouped
by person, plus who hasn't set it up yet. If someone is missing from that list, no message can
ever reach them — they need to tap the 🔔 on their own device first.

### Turning them on

| Device | What to do |
|--------|------------|
| Desktop / Android | Click the 🔔 in the header and allow. |
| **iPhone / iPad** | Open the site in **Safari** → **Share** → **Add to Home Screen**. Then open Daffodils *from the Home Screen icon* and tap the 🔔 there. |

iOS only exposes notifications to Home Screen web apps — a browser tab can never receive
them, and permission granted to Safari or Chrome itself does not carry over to the installed
app. Once allowed, the app re-subscribes silently on every launch, so this is a one-time step.

## Self-hosting on your own PC (PM2 + Cloudflare Tunnel)

This is how `https://fund.daffodils-buddies.uk` is served: the app runs on a Windows PC under
**PM2**, and a **Cloudflare Tunnel** publishes it without opening a router port.

Two pieces must be alive for the site to work. If either is down, the site is down:

| Piece | What it does | Check |
|-------|--------------|-------|
| `pm2` process `daffodils` | runs `server.js` on `localhost:3000` | `pm2 list` → `online` |
| `cloudflared` service | connects that port to Cloudflare's edge | `sc query cloudflared` → `RUNNING` |

### Why `npm start` doesn't survive a closed terminal

`npm start` runs `node server.js` in the **foreground**, as a child process of your terminal.
Closing the window kills the whole process tree — that's Windows working as designed, not a
bug. PM2 fixes this by running the app under a **background Windows service** that owns no
terminal, so it keeps going after you log out and comes back after a reboot.

### One-time setup

```bat
cd /d P:\Private-Projects\daffodils-buddies-savings-fund
npm install
pm2 start ecosystem.config.js
pm2 save
```

**Use `ecosystem.config.js`, not `pm2 start server.js`.** The config file is the only thing
that sets `DATA_DIR=P:\daffodils-data` and `cwd`. Start the bare script and the app falls back
to the repo's `data/` folder, so your real records get written into git-tracked seed files —
and the PM2 service starts in `System32`, so it won't even find `public/`.

**`pm2 save` is the step people skip.** It writes the current process list to
`C:\Users\<you>\.pm2\dump.pm2`, and the PM2 service replays that file on boot. Without it PM2
comes back empty after a restart and the site is silently down. Re-run `pm2 save` any time you
add, rename or remove an app.

Now close the terminal — the app is owned by the service, not your shell.

### Verify

```bat
pm2 list                          :: daffodils | online
curl -I http://localhost:3000/    :: HTTP/1.1 200 OK
pm2 logs daffodils --lines 20
```

The startup log must show your live folder, not the bundled one:

```
📁 Data: P:\daffodils-data  (persistent)
```

### Everyday commands

```bat
pm2 restart daffodils     :: after a code change
pm2 stop daffodils
pm2 logs daffodils        :: live output (Ctrl+C just detaches, app keeps running)
pm2 list
```

### Running more than one app

PM2 handles many apps, but each needs **its own name and its own port**. Reusing either
breaks things quietly:

- **Same name** — `pm2 restart daffodils` would restart *both* apps, and `pm2 delete` would
  remove both.
- **Same port** — the second app crash-loops with `EADDRINUSE`, since this app already holds
  `3000`.

So give each one a distinct name and port:

```bat
:: this app — keeps 3000, via its config file
cd /d P:\Private-Projects\daffodils-buddies-savings-fund
pm2 start ecosystem.config.js

:: another app — different name, different port
cd /d P:\Private-Projects\daf-buddies-shooting-game
set PORT=3001
pm2 start server/index.js --name shooting-game
pm2 save
```

Each app also needs its own Cloudflare tunnel route pointing at its own port
(`fund.…` → `localhost:3000`, `game.…` → `localhost:3001`).

### Cloudflare Tunnel

The tunnel is installed as the Windows service `cloudflared`, started from a token:

```
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run --token-file C:\ProgramData\cloudflared\token
```

In the Cloudflare Zero Trust dashboard (*Networks → Tunnels → daffodils*), the published
application route maps `fund.daffodils-buddies.uk` → `http://localhost:3000`.

**If the dashboard shows the tunnel as `Down`**, no `cloudflared` process is connected and the
public URL fails (usually Cloudflare error 1033) — even though `localhost:3000` still works
fine. Start the service from an **Administrator** terminal:

```bat
net start cloudflared
sc query cloudflared      :: want STATE : 4  RUNNING
```

Optionally have Windows revive it if it ever crashes (this does not cover a clean `net stop`):

```bat
sc failure cloudflared reset= 0 actions= restart/5000/restart/5000/restart/60000
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Site dies when the terminal closes | started with `npm start` | use `pm2 start ecosystem.config.js` |
| Everything gone after a reboot | `pm2 save` was never run | `pm2 start …` then `pm2 save` |
| `localhost:3000` works, public URL doesn't | `cloudflared` stopped | `net start cloudflared` (as admin) |
| Public URL works, app doesn't respond | pm2 process stopped/errored | `pm2 list`, `pm2 logs daffodils` |
| Git shows `data/*.csv` modified | app ran without `DATA_DIR` | start via `ecosystem.config.js`; `git checkout -- data/` |
| Second app won't stay up | port `3000` already taken | give it a different `PORT` |
| Wrong app answers on a port | two pm2 entries share a name | `pm2 delete <name>` removes **all** of them — re-add each from its own config |
| `pm2 list` looks empty or wrong | shell didn't inherit `PM2_HOME` and spawned its own daemon | use a freshly opened terminal (service home is `C:\ProgramData\pm2\home`) |
| Log says `(bundled folder — resets on every deploy!)` | `DATA_DIR` never reached the process | check `ecosystem.config.js` was used |

### Limits of self-hosting

The site is only reachable while **that PC is powered on, awake and online**. Sleep,
hibernate, a reboot mid-tunnel, or an ISP hiccup all take it offline. Disable sleep on the
host if you want it up around the clock — or deploy to [Render](#deploying-on-render) instead,
which has none of these constraints.

## Deploying on Render

This app needs a **long-running Node process with a writable, persistent filesystem** (it reads
and writes CSV files and uploaded images on every request) — that rules out serverless hosts
like Vercel, whose functions have no persistent disk. Render (or Railway) is a good fit:

1. Push this repo to GitHub.
2. In Render, **New → Web Service**, connect the repo.
3. Settings:
   - **Environment:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js` (matches the `Procfile`)
   - **Instance type:** Free tier is fine to start
4. **Add a persistent disk** (Render → your service → *Disks*), mount path `/var/data`.
5. **Set `DATA_DIR=/var/data`** (Render → *Environment*). This is the step that makes data
   survive: without it the app writes into the repo's own `data/` folder, which is replaced
   from git on every single deploy.
6. Deploy. Render will give you a `https://<service-name>.onrender.com` URL.

The startup log tells you which folder won:

```
📁 Data: /var/data  (persistent)
🌱 Seeded onto the disk: login.csv, rules_votes.csv, …
```

If it instead says **`(bundled folder — resets on every deploy!)`**, `DATA_DIR` didn't reach
the process. The Admin tab shows the same warning under 🔔 Notifications.

### How seeding works

The repo's `data/` folder is a **seed**, not live storage. On boot the app copies any file
that's *missing* from `DATA_DIR` — so a brand-new disk starts with the committed logins and
rule votes instead of an empty app. Files already on the disk are never touched or
overwritten, so your real data always wins.

That also means editing a CSV in the repo and redeploying will **not** change anything in
production — the disk already has that file. Change it through the app, or edit it on the
disk via a Render shell.

### Notes

- Free-tier Render services spin down when idle and take a few seconds to wake on the next
  request — expect a cold-start delay after inactivity.
- Mounting the disk directly over the repo's `data/` path also works, but `DATA_DIR` is
  clearer and is what the startup log and admin warning check for.
