/**
 * paths.js — where the app's live data actually lives.
 *
 * The repo's own `data/` folder is only a SEED: it ships with the code, so every deploy
 * replaces it. Anything written at runtime (chat, ledgers, passwords, uploads, push
 * subscriptions, VAPID keys) has to live somewhere the host keeps between deploys —
 * on Render that's a mounted persistent disk.
 *
 * Resolution order:
 *   1. $DATA_DIR                      — explicit, always wins.
 *   2. /data or /var/data             — a mounted disk, if one is there and writable.
 *   3. <repo>/data                    — local development.
 *
 * On boot we copy any seed file that's missing from the live folder, so a fresh disk
 * starts with the committed logins and rule votes instead of an empty app. Files that
 * already exist are NEVER touched — that's the whole point.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEED = path.join(ROOT, 'data');

/** Is this an existing directory we can actually write to? */
function writableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return { dir: path.resolve(process.env.DATA_DIR), source: 'env' };
  // Common Render mount points. Only adopt one if it's really there and writable,
  // so a local machine that happens to have /data doesn't get hijacked by a read-only dir.
  for (const mount of ['/data', '/var/data']) {
    if (writableDir(mount)) return { dir: mount, source: 'mount' };
  }
  return { dir: SEED, source: 'bundled' };
}

const { dir: DATA, source: SOURCE } = resolveDataDir();
const UPLOADS = path.join(DATA, 'uploads');
const IS_SEED = path.resolve(DATA) === path.resolve(SEED);

/**
 * Will this data outlive a deploy? 'bundled' means we're writing into the folder that
 * ships with the code, which the host replaces wholesale every time — the one case
 * where everything silently resets.
 */
const PERSISTENT = SOURCE !== 'bundled';

/** Absolute path of a data CSV by bare name: file('login') → <DATA>/login.csv */
const file = (name) => path.join(DATA, `${name}.csv`);

/**
 * Fill a fresh disk from the seed. Copies only what's missing — an existing file is
 * always left alone, because it is the real, newer data.
 */
function bootstrap() {
  fs.mkdirSync(UPLOADS, { recursive: true });
  if (IS_SEED) return { dir: DATA, seeded: [] };

  const seeded = [];
  let entries = [];
  try { entries = fs.readdirSync(SEED, { withFileTypes: true }); } catch { /* no seed folder */ }

  for (const entry of entries) {
    // uploads/ is user content, not seed material — the .gitkeep in it is noise on a disk.
    if (entry.isDirectory() || entry.name.startsWith('.')) continue;
    const target = path.join(DATA, entry.name);
    if (fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(path.join(SEED, entry.name), target);
      seeded.push(entry.name);
    } catch (err) {
      console.error(`Could not seed ${entry.name}:`, err.message);
    }
  }
  return { dir: DATA, seeded };
}

module.exports = { DATA, UPLOADS, SEED, IS_SEED, SOURCE, PERSISTENT, file, bootstrap };
