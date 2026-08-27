# CLAUDE.md — Daffodils Buddies Savings Fund

A colorful, mobile-friendly web app for four friends (Nirob, Yen, Riyad, Nasif) running a
monthly savings fund: track invests/loans/donations, show the voted rules, and socialize
(photos, posts, chat).

## Stack
- **Backend:** Node.js + Express (`server.js`). No build step.
- **Frontend:** vanilla HTML/CSS/JS in `public/`. No framework.
- **Database:** CSV files in the runtime data dir (read/written by `lib/csv.js`).
- **Uploads:** `multer` → `$DATA_DIR/uploads/`.

## Layout
- `server.js` — static serving + JSON API.
- `lib/csv.js` — CSV parse/stringify (handles quotes, commas, newlines).
- `lib/paths.js` — resolves the runtime data dir and seeds it. **Always** get data paths
  from here (`file('login')`, `DATA`, `UPLOADS`) — never `path.join(__dirname, 'data')`.
- `lib/rules.js` — tally votes → winner, detect ties, apply admin overrides.
- `lib/fund.js` — balance and "loan available now" math.
- `lib/push.js` — Web Push: VAPID keys, device subscriptions, fan-out on new chat.
- `scripts/seed-rules.js` — rebuild `data/rules_votes.csv` from `rules.xlsx`.
- `public/` — `index.html` (dashboard shell), `login.html`, `css/`, `js/`.
- `data/` — **seed** CSVs + `uploads/`; live data goes to `$DATA_DIR` in production.

## Data storage
- The repo's `data/` folder is a SEED that ships with the code — every deploy replaces it.
  Live data lives in `$DATA_DIR` (Render: a persistent disk at `/var/data`).
- `lib/paths.js` picks: `$DATA_DIR` → a writable `/data` or `/var/data` mount → `data/`.
- On boot, seed files missing from the live dir are copied across. Existing files are
  never overwritten — real data always wins.

## Conventions
- Currency is **BDT (৳)**. Fund amount is ৳250/member/month.
- Money math lives ONLY in `lib/fund.js`; don't duplicate it in the frontend.
- Rules are data-driven: the winning option is computed from votes; a row in
  `rules_overrides.csv` (admin decision) always wins over the tally.
- Priority per the project brief: **UI delight > security**. Auth is intentionally simple
  (a token in localStorage identifies the user; the server trusts it). Do not add heavy auth.
- Keep all data inside the project (CSV) — no external database.

## Accounts
- Admin: the `is_admin=1` row in `login.csv`. **Never write real credentials into this
  file, README.md, commit messages or any other tracked file** — look them up in `login.csv`.
- Members start password-less; first login sets a password.
- **A member's password is theirs alone.** The admin cannot read or set one — the only
  control is a reset (blank it), after which the member picks a new one at next login.
  Never add a route or UI that returns a password or accepts one on someone's behalf.
  "Forgot password" records a request (`reset_request`), never a proposed password.

## Run
`npm install` then `npm start` → http://localhost:3000. See the `daffodils-dev` skill.
