/**
 * ecosystem.config.js — pm2 process definition for self-hosting (Cloudflare Tunnel).
 *
 * DATA_DIR keeps the live CSVs and uploads OUTSIDE the repo, so a stray `git checkout`
 * or `git clean` can never take real records with it. lib/paths.js copies any seed file
 * that's missing from that folder on boot, and never overwrites one that's already there.
 *
 * Start with:  pm2 start ecosystem.config.js
 * (Render doesn't use this file — it runs `npm start` with DATA_DIR set in its own env.)
 */
module.exports = {
  apps: [
    {
      name: 'daffodils',
      script: 'server.js',
      // The pm2 Windows service starts in System32; without this the app would look
      // for public/ and data/ in the wrong place.
      cwd: __dirname,
      env: {
        DATA_DIR: process.env.DATA_DIR || 'P:\\daffodils-data',
        PORT: process.env.PORT || 3000,
      },
    },
  ],
};
