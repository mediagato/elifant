/**
 * Minimal USTAR writer/reader.
 *
 * Used by exportBrain()/importBrain() to package the bowl as a portable
 * archive per the Elifantic protocol v0 wire format.
 *
 * Tar is dead simple: 512-byte header per file (POSIX/USTAR layout) followed
 * by file content padded to 512-byte alignment; archive ends with two empty
 * 512-byte blocks. We only handle regular files (typeflag '0'). Filenames are
 * capped at 100 chars (the soul-manifest spec keeps every name well under
 * that — state.jsonl etc).
 *
 * No deps. Substrate kernel stays tight.
 */

const BLOCK = 512;

function _pad(b) {
  const r = b.length % BLOCK;
  if (r === 0) return b;
  return Buffer.concat([b, Buffer.alloc(BLOCK - r)]);
}

function _writeOctal(buf, offset, length, value) {
  const s = value.toString(8).padStart(length - 1, '0') + '\0';
  buf.write(s, offset, length, 'ascii');
}

function _header(name, size) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`tar: filename too long (max 100): ${name}`);
  }
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'ascii');
  _writeOctal(h, 100, 8, 0o644);                              // mode
  _writeOctal(h, 108, 8, 0);                                   // uid
  _writeOctal(h, 116, 8, 0);                                   // gid
  _writeOctal(h, 124, 12, size);                               // size
  _writeOctal(h, 136, 12, Math.floor(Date.now() / 1000));      // mtime
  h.write('        ', 148, 8, 'ascii');                        // checksum placeholder (8 spaces)
  h.writeUInt8(0x30, 156);                                     // typeflag '0' = regular file
  h.write('ustar\0', 257, 6, 'ascii');                         // magic
  h.write('00', 263, 2, 'ascii');                              // version
  // Checksum is the unsigned-byte sum of every byte of the header (treating
  // the checksum field itself as 8 spaces, which we just wrote above).
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  const cs = sum.toString(8).padStart(6, '0') + '\0 ';
  h.write(cs, 148, 8, 'ascii');
  return h;
}

/**
 * Pack a list of files into a tar Buffer.
 * @param {Array<{name: string, content: Buffer|string}>} files
 * @returns {Buffer}
 */
function pack(files) {
  const parts = [];
  for (const f of files) {
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    parts.push(_header(f.name, content.length));
    parts.push(_pad(content));
  }
  parts.push(Buffer.alloc(BLOCK * 2));  // end-of-archive marker
  return Buffer.concat(parts);
}

/**
 * Unpack a tar Buffer into a list of files.
 * @param {Buffer} buf
 * @returns {Array<{name: string, content: Buffer}>}
 */
function unpack(buf) {
  const files = [];
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const header = buf.slice(offset, offset + BLOCK);
    // End-of-archive: a block of all zeros.
    if (header[0] === 0) break;

    const nameRaw = header.slice(0, 100).toString('ascii');
    const name = nameRaw.replace(/\0.*$/, '');
    const sizeRaw = header.slice(124, 136).toString('ascii').replace(/[\0\s]/g, '');
    const size = parseInt(sizeRaw, 8);
    if (Number.isNaN(size)) {
      throw new Error(`tar: invalid size in header for ${name}`);
    }
    const typeflag = String.fromCharCode(header[156] || 0x30);
    offset += BLOCK;

    if (typeflag === '0' || typeflag === '\0') {
      const content = buf.slice(offset, offset + size);
      files.push({ name, content });
    }
    // Skip content + alignment padding.
    offset += size;
    const r = size % BLOCK;
    if (r !== 0) offset += BLOCK - r;
  }
  return files;
}

module.exports = { pack, unpack };
