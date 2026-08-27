---
name: daffodils-dev
description: Run, seed, and reset the Daffodils Buddies Savings Fund app. Use when starting the local server, regenerating rules from rules.xlsx, resetting demo data, or looking up admin credentials and data-file locations.
---

# Daffodils Buddies — Dev Skill

Local Node/Express app. Vanilla HTML/CSS/JS frontend, CSV files as the database.

## Run it
```bash
npm install      # first time only
npm start        # serves http://localhost:3000  (honors $PORT)
```

## Seed / regenerate rules
The voting matrix lives in `rules.xlsx`. To rebuild `data/rules_votes.csv` from it:
```bash
npm run seed
```
This parses the spreadsheet (no external deps — unzips the xlsx and reads the XML) and rewrites `data/rules_votes.csv`. It does NOT touch `data/rules_overrides.csv` (admin decisions) or any ledger.

## Where data lives (all CSV, inside the repo)
- `data/login.csv` — `email,name,password,temp_password,is_admin`
- `data/investments.csv` — `id,member,amount,date`
- `data/loans.csv` — `id,member,amount,date,purpose,status,due_date`
- `data/donations.csv` — `id,organization,amount,date,link,type`
- `data/rules_votes.csv` — one row per rule, the four friends' votes
- `data/rules_overrides.csv` — `rule_key,final_value` (admin-decided winner for ties/free-form)
- `data/posts.csv`, `data/chat.csv`, `data/photos.csv` — community
- `data/uploads/` — uploaded images

## Accounts
- Admin: the row in `data/login.csv` with `is_admin=1`. Read the username/password from that
  file — they are deliberately **not** written down here or in any other tracked file.
- Members (Nirob, Yen, Riyad, Nasif) start with an empty password; first login sets it.
- Forgot password writes to the `temp_password` column; the admin promotes it to `password` manually.

## Reset demo data
Empty a ledger by leaving only its header row, e.g. `data/investments.csv` → `id,member,amount,date`.

## Money math (see `lib/fund.js`)
- `balance = Σ investments − Σ outstanding loans − Σ donations`
- `loanAvailableNow = max(0, min(50% × balance, balance − 20% × totalInvested))`

## Deploy
Render/Railway free web service. Start command `node server.js`; app binds `process.env.PORT`.
For data that survives redeploys, mount a persistent disk at `data/`.
