const { put, del } = require('@vercel/blob');

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

async function remove(url) {
  if (configured() && /^https:\/\//i.test(String(url || ''))) await del(url);
}

module.exports = { configured, upload, remove };