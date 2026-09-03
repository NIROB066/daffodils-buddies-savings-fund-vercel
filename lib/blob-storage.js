const { put, del } = require('@vercel/blob');
const { generateClientTokenFromReadWriteToken } = require('@vercel/blob/client');

function configured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function upload(buffer, name, mimeType) {
  if (!configured()) throw new Error('Vercel Blob is not configured.');
  return put(`uploads/${name}`, buffer, {
    access: 'public',
    contentType: mimeType,
    addRandomSuffix: false,
  });
}

/**
 * Mint a short-lived client token scoped to one pathname, content type and size.
 * The browser uses it to PUT the file *directly* into the Blob store — the only
 * way to move more than Vercel's 4.5 MB serverless-function body cap (e.g. the
 * few-MB video clips that die with "request error" through the server route).
 */
async function clientToken(pathname, { contentType, maxSizeBytes, validUntilMs = 15 * 60 * 1000 } = {}) {
  if (!configured()) throw new Error('Vercel Blob is not configured.');
  return generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN,
    pathname,
    allowedContentTypes: [contentType],
    maximumSizeInBytes: maxSizeBytes,
    validUntil: Date.now() + validUntilMs,
  });
}

async function remove(url) {
  if (configured() && /^https:\/\//i.test(String(url || ''))) await del(url);
}

module.exports = { configured, upload, clientToken, remove };