/**
 * Tests for the minimal USTAR reader/writer (src/tar.js).
 *
 * Focus: unpack() must never hang or over-read on a hostile/malformed archive.
 * Regression guard for audit-2026-06-10 finding tar-01 — a negative octal size
 * field made the unpack loop net zero forward progress, an infinite loop that
 * pegged the event loop and DoSed the whole daemon from a ~16-byte input.
 *
 * Run with: node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const tar = require('../src/tar.js');

const BLOCK = 512;

// Build a single USTAR header block with a chosen (raw) size field. The size
// field is written verbatim so tests can inject hostile octal text.
function headerWithSize(name, sizeField) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'ascii');     // name → header[0] != 0 (not end-of-archive)
  h.write(sizeField, 124, 12, 'ascii'); // size field [124,136)
  h.writeUInt8(0x30, 156);            // typeflag '0' = regular file
  return h;
}

test('unpack rejects a NEGATIVE size field instead of hanging (tar-01 DoS regression)', () => {
  // '-1000' octal = -512; pre-fix this netted zero offset advance per iteration
  // → infinite loop. The fix must throw quickly. If this test ever hangs, the
  // guard regressed.
  const buf = Buffer.concat([headerWithSize('memories.jsonl', '-1000'), Buffer.alloc(BLOCK * 2)]);
  assert.throws(() => tar.unpack(buf), /invalid size/);
});

test('unpack rejects a size that runs past the archive bounds', () => {
  // Large positive size with no content following → exceeds the buffer.
  const buf = Buffer.concat([headerWithSize('memories.jsonl', '77777777777'), Buffer.alloc(BLOCK)]);
  assert.throws(() => tar.unpack(buf), /exceeds archive bounds|invalid size/);
});

test('unpack rejects a non-octal garbage size field', () => {
  const buf = Buffer.concat([headerWithSize('x', 'zzzz'), Buffer.alloc(BLOCK * 2)]);
  assert.throws(() => tar.unpack(buf), /invalid size/);
});

test('pack/unpack round-trip preserves files (fix does not break valid archives)', () => {
  const packed = tar.pack([
    { name: 'a.txt', content: 'hello' },
    { name: 'b.json', content: Buffer.from('{"x":1}') },
  ]);
  const out = tar.unpack(packed);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'a.txt');
  assert.equal(out[0].content.toString(), 'hello');
  assert.equal(out[1].name, 'b.json');
  assert.equal(out[1].content.toString(), '{"x":1}');
});

test('unpack returns [] for an end-of-archive (all-zero) buffer', () => {
  assert.deepEqual(tar.unpack(Buffer.alloc(BLOCK * 2)), []);
});

test('pack/unpack round-trip handles a zero-length file', () => {
  const packed = tar.pack([{ name: 'empty.txt', content: '' }]);
  const out = tar.unpack(packed);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'empty.txt');
  assert.equal(out[0].content.length, 0);
});
