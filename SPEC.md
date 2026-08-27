# SPEC.md — Daffodils Buddies Savings Fund

Machine-oriented architecture reference. If you are an AI agent working on this
repository, read this file first; it describes every moving part, where it lives, and
the invariants you must not break.

---

## 1. What the product is

A private web app for four friends — **Nirob, Yen, Riyad, Nasif** — plus one **Admin**.
It does two things:

1. **Runs a savings fund.** Each member invests ৳250/month. The app tracks investments,
   loans and donations, and computes how much can safely be lent right now.
2. **Is their group chat.** "Our Corner" holds a WhatsApp-class chat, a photo memories
   slider and a small posts feed.

Currency is **BDT (৳)** everywhere.

### Design priorities (from the project brief, in order)

| Priority | Meaning |
| --- | --- |
| UI delight | Colourful, playful, mobile-first. Animation and warmth beat austerity. |
| Simplicity | No build step, no framework, no external database. |
| Security | Deliberately light. See §9 — do **not** "fix" this by adding heavy auth. |

---

## 2. Stack and constraints

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js ≥ 18 | `fetch` and `AbortSignal.timeout` are used natively |
| Server | Express 4 (`server.js`) | Single file, ~800 lines, static + JSON API |
| Frontend | Vanilla HTML/CSS/JS in `public/` | **No build step.** Scripts are plain `<script>` tags in load order |
| Database | CSV files (`lib/csv.js`) | One file per collection, in the runtime data dir |
| Uploads | `multer` → `$DATA_DIR/uploads/`, or Vercel Blob | |
| Notifications | `web-push` (VAPID) + a service worker | |

**Hard constraints**

- No bundler, no transpiler, no npm packages on the frontend.
- No SQL/NoSQL database. All persistent state is CSV.
- Money arithmetic lives **only** in `lib/fund.js`. Never re-derive it in the frontend.
- Data paths come **only** from `lib/paths.js`. Never `path.join(__dirname, 'data')`.

---

## 3. Repository layout

```
server.js                 Express app: static serving + the whole JSON API
api/index.js              Vercel serverless entry — `module.exports = require('../server')`

lib/
  paths.js                Resolves the runtime data dir; seeds it on boot
  csv.js                  CSV parse/stringify + read/write/append (+ Google Sheets backend)
  fund.js                 Balance and "loan available now" math
  rules.js                Vote tally → winner, tie detection, admin overrides
  push.js                 VAPID keys, device subscriptions, push fan-out
  blob-storage.js         Vercel Blob upload/remove (optional)
  google-storage.js       Google Sheets as a CSV replacement (optional)

public/
  index.html              Dashboard shell — every section and overlay lives here
  login.html              Login / first-password / forgot-password
  sw.js                   Service worker: installability, Web Push, notification clicks
  manifest.webmanifest    PWA manifest
  css/styles.css          Every style in the app, one file
  js/
    api.js                `Session`, `api()` fetch wrapper, formatters, `esc()`
    icons.js              `ICON[name]` inline SVGs, `hydrateIcons()` for `[data-ico]`
    nav.js                Tabs, phone vs desktop routing, swipe gestures
    auth.js               Login page logic
    dashboard.js          Overview / Invest / Loans / Donations
    rules.js              The voted ruleset
    community.js          Memories slider, posts feed, and the entire chat
    chatlive.js           Live polling, unread badges, push, mobile dock
    admin.js              Admin panel
    app.js                Boot sequence

data/                     SEED CSVs + uploads/. Replaced on every deploy.
scripts/seed-rules.js     Rebuild data/rules_votes.csv from rules.xlsx
```

---

## 4. Data storage

### 4.1 Where data actually lives

`lib/paths.js` resolves the runtime directory in this order:

1. `$DATA_DIR` — explicit, always wins.
2. `/data` or `/var/data` — adopted only if present **and writable** (Render disk).
3. `<repo>/data` — local development. **Ephemeral in production.**

Exports: `DATA`, `UPLOADS`, `SEED`, `IS_SEED`, `SOURCE`, `PERSISTENT`,
`file(name)` → `<DATA>/<name>.csv`, and `bootstrap()`.

`bootstrap()` copies seed files that are **missing** from the live directory. Existing
files are never overwritten — real data always wins over the seed.

### 4.2 Collections

Write order is declared in `COLS` at the top of `server.js`. `writeCsv` and `appendCsv`
both rewrite the whole file using that column list, so **adding a column is safe**:
existing rows gain an empty value and the header is updated.

| File | Columns |
| --- | --- |
| `login.csv` | `email, name, password, is_admin, reset_request` |
| `investments.csv` | `id, member, amount, date` |
| `loans.csv` | `id, member, amount, date, purpose, status, due_date` |
| `donations.csv` | `id, organization, amount, date, link, type` |
| `posts.csv` | `id, member, text, image, timestamp` |
| `chat.csv` | `id, member, text, media, media_type, media_name, media_size, reply_to, timestamp, reactions, deleted, edited_at` |
| `chat_state.csv` | `email, name, last_seen, updated` — read receipts, created at runtime |
| `photos.csv` | `id, member, filename, caption, timestamp` |
| `rules_votes.csv` | `rule_key, label, Nirob, Yen, Riyad, Nasif` |
| `rules_overrides.csv` | `rule_key, final_value` |
| `push_subs.csv` | `email, name, endpoint, p256dh, auth, created` |

Ids are auto-increment integers: `nextId(rows) = max(id) + 1`.

### 4.3 Chat-specific encodings

- **`reactions`** packs the whole map into one cell:
  `👍:Nirob|Yen;❤️:Riyad`. Names never contain `;`, `:` or `|`, so it round-trips
  without escaping. Parsed by `parseReactions()` / written by `encodeReactions()`.
  One emoji per person per message — sending the same one again removes it.
- **`deleted`** is `'1'` for a tombstone. The row survives so replies still resolve;
  `shapeMessage()` blanks the text, media and reactions before the row leaves the server.
- **`edited_at`** is the ISO time of the last edit, or empty.
- **Retention:** `pruneChat()` drops messages older than **7 days** (`CHAT_TTL_MS`) and
  unlinks their media. It runs on every chat read and write.

### 4.4 Alternative backends (optional, env-driven)

| Backend | Enabled by | Effect |
| --- | --- | --- |
| Vercel Blob | `BLOB_READ_WRITE_TOKEN` | Uploads go to Blob; `media`/`filename` hold absolute `https://` URLs |
| Google Sheets | `GOOGLE_SHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | `lib/csv.js` reads/writes spreadsheet tabs instead of files, through a per-instance row cache that expires after `SHEETS_CACHE_MS` (default 3 s) |

The cache **must** expire. Vercel runs several instances at once, each with its own copy;
a cache that never refreshed was why a message sent through one instance stayed invisible
on the others until they were recycled. A refresh is a single `batchGet`, so the cost is
one Sheets read per window per instance no matter how often clients poll.

Writes are queued, not awaited by handlers — but a serverless instance is frozen the
instant the response is sent, so `server.js` wraps `res.json` on `/api` and holds the
response until `flushGoogleWrites()` and any `background()` work (pushes) have settled,
capped at 4 s. **Anything started by a handler must go through `background()`**, or the
host may kill it mid-flight.

Both are transparent to callers: `readCsv`/`writeCsv`/`appendCsv` and `mediaUrl()` handle
either shape. Code that touches an upload must accept **both** a bare filename and a
full URL — the helper `mediaUrl()` in `community.js` and `/^https?:\/\//` tests in
`server.js` exist for exactly this.

---

## 5. Domain logic

### 5.1 Fund math — `lib/fund.js`

Constants: `MEMBERS = ['Nirob','Yen','Riyad','Nasif']`, `MAX_LOAN_FRACTION = 0.5`,
`MIN_RESERVE_FRACTION = 0.2`.

```
totalInvested     = Σ investments.amount
outstandingLoans  = Σ loans.amount where status ∉ {returned, repaid, closed, paid}
totalDonated      = Σ donations.amount
balance           = totalInvested − outstandingLoans − totalDonated
minReserve        = 0.2 × totalInvested
maxSingleLoan     = 0.5 × balance
loanAvailableNow  = max(0, min(maxSingleLoan, balance − minReserve))
```

`computeSummary()` also returns `counts`, `perMember` (sorted by invested desc),
`monthly` and `yearly` rollups, and `currency: '৳'`.

### 5.2 Rules — `lib/rules.js`

Rules are **data-driven**. Each row of `rules_votes.csv` carries one vote per member.

1. Votes are normalised (`normKey`: lowercase, fix the `balace`→`balance` typo, strip
   non-alphanumerics) and grouped, keeping the first spelling seen as the display value.
2. Options sort by count descending. Every option on the top count is a *winner*.
3. A non-empty row in `rules_overrides.csv` for that `rule_key` **always wins** over the
   tally (`source: 'admin'`).
4. Otherwise one winner → `source: 'vote'`; several winners → the values are joined with
   `' / '` and `tie: true`.

`computeRules()` returns
`[{ key, label, options:[{value,count,voters}], winners, tie, value, source }]`.

`scripts/seed-rules.js` (`npm run seed`) rebuilds `rules_votes.csv` from `rules.xlsx` by
unzipping it and parsing the raw sheet XML — no spreadsheet dependency.

---

## 6. HTTP API

All endpoints are under `/api`. "Auth" means the `x-user` header must resolve to a row in
`login.csv`; "Admin" additionally requires `is_admin=1`.

### Auth

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/login` | — | Email + password → `{ user, token }`. A member with no password sets it here. |
| POST | `/api/check-email` | — | Does this email exist, and is it a first login? |
| POST | `/api/forgot` | — | Records a `reset_request` timestamp. Never proposes a password. |

### Fund (read-only)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/summary` | — | `computeSummary()` |
| GET | `/api/rules` | — | `computeRules()` |
| GET | `/api/investments` | — | All rows |
| GET | `/api/loans` | — | All rows |
| GET | `/api/donations` | — | All rows |
| GET | `/api/members` | — | Non-admin member names |
| GET | `/api/people` | — | All login names, for `@mention` autocomplete |

### Community

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/posts` | — | Posts, newest first |
| POST | `/api/posts` | ✓ | Create a post |
| POST | `/api/posts/photo` | ✓ | Create a post with an image (multipart) |
| GET | `/api/photos` | — | Memories, newest first, skipping rows whose file is gone |
| POST | `/api/photos` | ✓ | Upload a memory photo (multipart, images only, 8 MB) |

### Chat

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/chat` | — | Full thread oldest-first; `?since=<id>` for the tail |
| GET | `/api/chat/live` | optional | The poll endpoint — see below |
| POST | `/api/chat` | ✓ | Send text; `{ text, reply_to }` |
| POST | `/api/chat/media` | ✓ | Send an attachment + optional caption (multipart, 30 MB) |
| PATCH | `/api/chat/:id` | ✓ | Edit **your own** message text; stamps `edited_at` |
| DELETE | `/api/chat/:id` | ✓ | Delete your own message (admin: anyone's) → tombstone |
| POST | `/api/chat/:id/react` | ✓ | Toggle one of the 8 allowed emoji |
| POST | `/api/chat/typing` | ✓ | "I'm typing" — in memory, 6 s TTL |
| POST | `/api/chat/seen` | ✓ | Move this member's read marker to `{ id }` |
| GET | `/api/link-preview?url=` | ✓ | Server-side Open Graph scrape |

**`GET /api/chat/live?since=<id>&rev=<hash>`** returns

```json
{
  "rev": "1660769447",
  "full": null,
  "messages": [ /* messages newer than `since` */ ],
  "typing": ["Yen"],
  "receipts": { "Yen": 42, "Riyad": 39 }
}
```

`rev` is a fingerprint of every mutable field (`id`, `reactions`, `deleted`,
`edited_at`) across the thread. A `since=` cursor can never reveal a reaction, edit or
delete applied to an *older* message, so when the caller's `rev` doesn't match, the
server returns the **whole thread** in `full` and leaves `messages` empty. The
fingerprint is derived from the data rather than a counter, so it survives a restart and
is identical across serverless instances.

Typing state is deliberately in memory: it expires in seconds, so persisting it would
cost a write per keystroke and buy nothing. Read receipts *are* persisted
(`chat_state.csv`), and `POST /api/chat/seen` only writes when the marker actually moves.

### Push

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/push/key` | — | VAPID public key |
| POST | `/api/push/subscribe` | ✓ or `oldEndpoint` | Register/renew a device |
| POST | `/api/push/unsubscribe` | — | Drop a device by endpoint |

### Admin

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/admin/investment` \| `/loan` \| `/donation` | Add a ledger row |
| DELETE | `/api/admin/investment/:id` \| `/loan/:id` \| `/donation/:id` | Delete a ledger row |
| DELETE | `/api/admin/chat` \| `/posts` \| `/photos` | Clear a collection and its media (chat also resets read markers) |
| POST | `/api/admin/rule-override` | Set, or clear with an empty value, a rule winner |
| GET | `/api/admin/members` | Members with password status and reset requests |
| POST | `/api/admin/member-email` | Change a member's login email |
| POST | `/api/admin/reset-password` | **Blank** a password — never set one |
| GET | `/api/admin/pending-passwords` | Who has asked for a reset |
| GET | `/api/admin/push-status` | Devices, data dir, persistence, key source |
| POST | `/api/admin/push-test` | Send a test notification |

### Non-`/api` routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/uploads/:file` | Stream an upload. `acceptRanges` is required for `<video>`/`<audio>` seeking and for iOS Safari to play at all. |
| GET | `/download/:file?name=` | Force a download with the original filename via `Content-Disposition`. |

---

## 7. Frontend architecture

### 7.1 Load order (`index.html`)

`api.js → icons.js → nav.js → dashboard.js → rules.js → community.js → chatlive.js →
admin.js → app.js`

Each file defines one global IIFE object (`Session`/`api`, `ICON`, `Nav`, `Dashboard`,
`Rules`, `Community`, `ChatLive`, `Admin`). There is no module system.

### 7.2 Boot sequence (`app.js`)

1. Guard: no `Session.user` → redirect to `login.html`.
2. `Theme.init()`, header chip, avatar, user menu.
3. Bind the Chat / Memories / Posts segmented control.
4. `Nav.build(isAdmin)`, `Nav.initGestures()`.
5. `Community.bind()` — attaches every chat listener.
6. `await Dashboard.load()` → `Rules.load()` → `Community.load()` → `Admin.load()` if admin.
7. `ChatLive.init()` **last**, so the first poll starts from a known message id.

A 401/403 anywhere clears the session and returns to the login page.

### 7.3 Navigation (`nav.js`)

```
FUND      = overview, invest, loans, donations, rules, admin(adminOnly)
COMMUNITY = { key: 'community', label: 'Corner', icon: 'flower' }
```

- **Desktop (>720px):** two-column grid — fund sections scroll on the left, the Corner
  panel is sticky on the right. A chip nav jumps between fund sections.
- **Phone (≤720px):** one section at a time, bottom nav, left/right swipe and a "next"
  FAB. Corner comes **first**.
- Emits `window` event `nav:change` with `{ detail: { key } }`.
- Exports `build`, `go`, `initGestures`, `active`, `isPhone`.

### 7.4 The chat (`community.js` + `chatlive.js`)

`community.js` owns rendering and every user action; `chatlive.js` owns the network loop
and the mobile dock. They meet at this interface:

```js
Community.applyIncoming(list)  // merge new messages, return the genuinely new ones
Community.replaceAll(list)     // swap in the whole thread (stale `rev`), return the new ones
Community.setTyping(names)
Community.setReceipts(map)
Community.lastId()
Community.scrollToBottom()
Community.mentionsMe(msg)
```

**Polling.** `chatlive.js` calls `/api/chat/live` every **5 s** in the foreground and
**20 s** when the tab is hidden, carrying `since` and `rev`.

**Rendering.** `renderChat()` repaints the whole thread from the `chat` array on every
change. It is idempotent and must stay cheap:

- Scroll is only pinned to the bottom when the reader was already there (`atBottom()`).
- Day separators (`Today` / `Yesterday` / weekday / date) are inserted between messages.
- Search matches are wrapped in `<mark>` by walking **text nodes after** render
  (`highlightMatches`), never by string surgery on HTML — that keeps links intact and
  makes injection impossible.
- Link previews are cached per URL for the life of the page (`previewCache`). Without
  that cache the 5 s repaint would re-fetch every card, which is what used to make
  previews flicker in and out. A `partial` response — the server could not read the page
  — is still cached so the card stays put, but is retried up to 3 times, 60 s apart.

**Escaping.** All user text goes through `esc()` first. `linkUrls()` and `linkMentions()`
then operate on **already-escaped** text, so they cannot inject markup. `linkUrls()`
un-escapes `&amp;` / `&quot;` / `&#39;` when building the `href`, then re-escapes it.

**Media.** Nothing is transcoded. `canPlay(kind, name)` probes `canPlayType()` for the
file's extension and renders a download card instead of a dead player when the browser
cannot decode it (e.g. a Chrome-recorded `.webm` opened on an iPhone). A runtime `error`
event on a player swaps in the same card. Video and voice notes carry a **1× / 1.5× / 2×**
button that cycles `playbackRate`.

**Gestures (phone).** On a bubble: drag right past 45 px to reply; press and hold for
480 ms for the action menu. Any movement over 8 px cancels the hold, so scrolling never
pops the menu.

**Full screen.** `ChatLive.openDock(full)` moves the real `#pane-chat` element into
`#dock-body` (it is never cloned) and `closeDock()` puts it back where it was.
`.chat-dock.full` makes the sheet the whole screen; the choice is remembered in
`localStorage` under `daf_chat_full`.

### 7.5 Chat feature inventory

| Feature | Where |
| --- | --- |
| Replies with context, tap-to-jump | `bubbleHtml`, `jumpTo` |
| `@mentions` + autocomplete + highlight ring | `linkMentions`, `updateMentions`, `.bubble.hit` |
| Emoji reactions (8, one per person) | `reactionsHtml`, `openMenu`, `POST /chat/:id/react` |
| Edit own message | `startEdit`, `PATCH /chat/:id` |
| Delete own message → tombstone | `deleteMessage`, `DELETE /chat/:id` |
| Copy text | `copyMessage` |
| Search with match count and prev/next | `setSearch`, `stepSearch`, `highlightMatches` |
| Read receipts (✓ / ✓✓) and typing indicator | `ticksHtml`, `setTyping`, `/chat/seen`, `/chat/typing` |
| Day separators | `dayLabel` |
| Photo lightbox | `openLightbox` |
| Voice recording (`MediaRecorder`) | `toggleRecord` |
| Playback speed 1× / 1.5× / 2× | `speedBtn`, `cycleSpeed` |
| Paste or drag-and-drop to attach | `bindDropZone`, `stageFile` |
| Emoji picker | `renderEmojiPicker` |
| Jump-to-latest with unread count | `updateJump` |
| Link previews (Open Graph + YouTube) | `previewCard`, `hydratePreviews` |
| Unread badge, green dot, Web Push | `chatlive.js` |
| Mobile dock + full-screen mode | `openDock`, `setFull` |

### 7.6 Layout invariants (do not remove)

The Corner panel used to push the whole page off the right edge on phones. The cause was
a chat bubble containing an unbreakable URL setting the grid column's min-content width.
Keep all of these:

- `.side-col { min-width: 0 }` and `.layout { grid-template-columns: minmax(0,1fr) minmax(0,380px) }`.
- `min-width: 0; max-width: 100%` on `.social` and `.pane`.
- `overflow-x: hidden` on `.chat-body`, and `overflow-wrap: anywhere; word-break: break-word`
  on `.bubble .txt` / `.chat-link`.
- `html, body, main { overflow-x: clip }` as a backstop. It must be `clip`, not `hidden`
  — `hidden` turns `<body>` into a scroll container and breaks the sticky header/sidebar.

---

## 8. Notifications

- `lib/push.js` loads VAPID keys from `VAPID_PUBLIC`/`VAPID_PRIVATE`, else generates and
  persists `data/vapid.json`. **The keys must stay stable**: a subscription is bound to
  the key it was created with, and a rotated key makes every existing device silently
  undeliverable. The client detects this (`keyMatches()`) and re-subscribes.
- The VAPID subject falls back through `VAPID_SUBJECT` → admin email → first member email
  → `RENDER_EXTERNAL_URL`. Reserved domains (`example.com`, `.local`, …) are rejected
  because Apple returns `403 BadJwtToken` for them.
- `notifyOthers(senderEmail, payload)` is not awaited by the handler — a slow or dead push
  service must never fail the message the user just sent — but it is registered with
  `background()` so the response settles it before the instance can be frozen.
  `404`/`410` responses delete the row.
- `public/sw.js` is what actually shows the notification. It is the only path iOS
  accepts, and the only one that works with the app closed. On iOS the app must be added
  to the Home Screen before notifications exist at all — `chatlive.js` says so explicitly
  rather than failing silently.

---

## 9. Auth and privacy rules

Auth is intentionally minimal: the login token **is the user's email**, stored in
`localStorage` and sent as the `x-user` header; the server looks it up in `login.csv` and
trusts it. This is a deliberate trade for four friends. **Do not replace it with sessions,
JWTs or hashing** unless explicitly asked.

Non-negotiable rules:

- **A password belongs to its owner alone.** Never add a route or UI that returns a
  password, or that accepts one on someone else's behalf. The admin's only power is to
  **blank** a password; the member then sets a new one at next login.
- "Forgot password" records a `reset_request` timestamp. It never proposes a password.
- Never write real credentials into `README.md`, `CLAUDE.md`, `SPEC.md`, commit messages
  or any other tracked file. Look them up in `login.csv`.
- A member can delete **their own** chat messages only. The admin may delete any, and may
  clear whole collections. Both are enforced server-side.

Where security *is* enforced properly:

- `/api/link-preview` validates the URL and resolves DNS, rejecting private and
  link-local addresses (SSRF guard), caps the response size and times out.
- `/download/:file` and upload deletion use `path.basename()` so nothing can escape
  `UPLOADS`.
- All rendered user content is escaped (§7.4).

---

## 10. Running and deploying

```bash
npm install
npm start          # http://localhost:3000
npm run seed       # rebuild data/rules_votes.csv from rules.xlsx
```

| Target | Entry | Data |
| --- | --- | --- |
| Local | `node server.js` | `<repo>/data` |
| Render | `Procfile` → `web: node server.js` | Persistent disk at `/var/data` |
| PM2 | `ecosystem.config.js` (sets `DATA_DIR`, `PORT`) | `$DATA_DIR` |
| Vercel | `vercel.json` routes everything to `api/index.js` | Blob + Google Sheets (the filesystem is read-only and ephemeral) |

On Vercel the bundled `data/` folder is **not** writable and every instance is separate,
so the Blob and Sheets backends of §4.4 are required for anything to persist.

---

## 11. Conventions for contributors and agents

- Comments explain **why**, not what. One line where one line will do.
- Keep money math in `lib/fund.js`, rule math in `lib/rules.js`, paths in `lib/paths.js`.
- Adding a chat field: extend `COLS.chat`, include it in `shapeMessage()`, add it to
  `chatRevision()` if it can change in place, and update the seed header in
  `data/chat.csv`. Old rows migrate themselves via `migrateChat()`.
- Anything that renders a message must handle `deleted === '1'` (a tombstone with no
  text, media or reactions).
- Anything that touches an upload must accept both a bare filename and an `https://` URL.
- New chat UI belongs in `community.js`; new network/presence behaviour in `chatlive.js`.
- Prefer extending `renderChat()` over introducing incremental DOM patching — the full
  repaint is what keeps reactions, edits and deletes consistent.
