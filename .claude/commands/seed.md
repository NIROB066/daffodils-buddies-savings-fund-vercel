---
description: Regenerate data/rules_votes.csv from rules.xlsx (the voting spreadsheet)
---

Run the rules seed script and report what changed:

1. Run `npm run seed` (equivalently `node scripts/seed-rules.js`).
2. Read the resulting `data/rules_votes.csv` and summarize each rule's winning option and any ties.
3. Do NOT modify `data/rules_overrides.csv` — those are admin decisions.

The spreadsheet `rules.xlsx` holds one rule per row with the four friends' votes (Nirob, Yen, Riyad, Nasif). The majority option wins; ties are surfaced for the admin to resolve via `rules_overrides.csv`.
