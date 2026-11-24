// Streams a zip of documents to the browser, quickly.
//
// Fetching files one at a time made zips slow: each Drive read takes about a
// second, so 20 documents took 20+ seconds. Files are now fetched several at
// once (in a moving window, so memory stays bounded) and written into the zip
// in their original order. Files that are already compressed (PDFs, photos,
// Office files) are stored as they are — compressing them again costs CPU and
// saves almost nothing.
const archiver = require('archiver');

const ALREADY_COMPRESSED = /\.(pdf|jpe?g|png|gif|webp|heic|heif|avif|zip|rar|7z|gz|docx|xlsx|pptx|mp4|mov|m4a|mp3)$/i;
const CONCURRENCY = 6;

// Pipes a new zip into res. onError logs and ends the response.
function createZip(res, label) {
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    console.error(`${label} zip error:`, err.message);
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });
  archive.pipe(res);
  return archive;
}

// items: anything; load(item) → { buffer, name } (or null to skip). A file
// that fails to load is skipped (onSkip), never failing the whole zip.
// Same names get " (2)", " (3)"… so nothing is overwritten inside the zip.
async function appendFiles(archive, items, load, { concurrency = CONCURRENCY, onSkip } = {}) {
  const pending = new Array(items.length);
  const start = (i) => {
    pending[i] = Promise.resolve()
      .then(() => load(items[i]))
      .catch((err) => { onSkip?.(items[i], err); return null; });
  };
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) start(i);

  const taken = new Set();
  let added = 0;
  for (let i = 0; i < items.length; i += 1) {
    const entry = await pending[i];
    pending[i] = null; // let the buffer go once it's in the zip
    if (i + concurrency < items.length) start(i + concurrency);
    if (!entry || !entry.buffer) continue;
    let name = entry.name;
    for (let n = 2; taken.has(name); n += 1) name = entry.name.replace(/(\.[^./]+)?$/, ` (${n})$1`);
    taken.add(name);
    archive.append(entry.buffer, { name, store: ALREADY_COMPRESSED.test(name) });
    added += 1;
  }
  return added;
}

module.exports = { createZip, appendFiles };
