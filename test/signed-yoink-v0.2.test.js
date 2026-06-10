'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index');

async function makeBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-signed-yoink-'));
  await brain.init(dir);
  return dir;
}

test('exportBrain produces signed v0.2 manifest by default', async () => {
  await makeBrain();
  try {
    await brain.setName('test-bowl');
    await brain.setMemory('hello.md', 'world', 'test', 'instance');
    const result = await brain.exportBrain();
    assert.equal(result.manifest.schema, 'elifantic-soul-v0.2');
    assert.ok(result.manifest.signature, 'manifest.signature must be present');
    assert.equal(result.manifest.signature.algorithm, 'ed25519');
    assert.ok(result.manifest.signature.keyholder_public_key, 'public key present');
    assert.ok(result.manifest.signature.signature, 'signature present');
    assert.equal(Buffer.from(result.manifest.signature.keyholder_public_key, 'base64').length, 32);
  } finally {
    await brain.close();
  }
});

test('importBrain verifies signature on same-bowl round-trip', async () => {
  await makeBrain();
  try {
    await brain.setName('roundtrip-bowl');
    await brain.setMemory('lesson.md', 'verify works', 'test', 'instance');
    const exported = await brain.exportBrain();
    await brain.close();
  } finally {}

  // Fresh second brain in a fresh dir
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-importer-'));
  await brain.init(dir2);
  try {
    // Re-export to get a signed payload, then re-import it
    await brain.setMemory('seed.md', 'seed', 'test', 'instance');
    const exp = await brain.exportBrain();
    const imp = await brain.importBrain({ payload: exp.payload, conflict: 'newer-wins' });
    assert.equal(imp.signature_status, 'verified', 'roundtrip should verify cleanly');
  } finally {
    await brain.close();
  }
});

test('importBrain rejects tampered signature when signature_mode=require', async () => {
  await makeBrain();
  try {
    await brain.setMemory('a.md', 'a', 'test', 'instance');
    const exp = await brain.exportBrain();

    // Tamper: extract the tar, modify a .jsonl file, repack — but that would
    // break manifest's table_counts; easier: tamper the manifest's exported_at
    // post-signing. Either move makes the signature mismatch.
    const tar = require('../src/tar');
    const files = tar.unpack(exp.payload);
    const manifestFile = files.find((f) => f.name === 'soul-manifest.json');
    const manifest = JSON.parse(manifestFile.content.toString('utf8'));
    manifest.exported_at = '2020-01-01T00:00:00.000Z';  // tamper
    manifestFile.content = Buffer.from(JSON.stringify(manifest, null, 2));
    const tampered = tar.pack(files);

    await assert.rejects(
      brain.importBrain({ payload: tampered, signature_mode: 'require' }),
      /signature/i,
      'tampered manifest should reject under signature_mode=require'
    );

    // crypto-02 (audit-2026-06-10): the default mode now HARD-FAILS on tampering
    // too (it was advisory before — reported invalid and imported anyway).
    await assert.rejects(
      brain.importBrain({ payload: tampered }),
      /invalid|tampered/i,
      'tampered manifest must hard-fail under the default mode'
    );
  } finally {
    await brain.close();
  }
});

test('importBrain rejects unsigned by default, imports with allow_unsigned', async () => {
  await makeBrain();
  try {
    // Build a legacy v0 manifest manually
    const tar = require('../src/tar');
    const legacyManifest = {
      schema: 'elifantic-soul-v0',
      substrate_identity: '00000000-0000-0000-0000-000000000000',
      display_name: 'legacy',
      brain_version: '0.2.1',
      exported_at: '2026-05-19T12:00:00.000Z',
      table_counts: { state: 0, memories: 0, steering: 0, review_lessons: 0 },
      encryption: null,
      producer: { name: 'legacy', version: '0.2.1', host: 'test' },
      filter: { tables: ['state','memories','steering','review_lessons'], layers: ['any'] },
    };
    const files = [
      { name: 'soul-manifest.json', content: Buffer.from(JSON.stringify(legacyManifest, null, 2)) },
      { name: 'state.jsonl', content: Buffer.from('') },
      { name: 'memories.jsonl', content: Buffer.from('') },
      { name: 'steering.jsonl', content: Buffer.from('') },
      { name: 'review_lessons.jsonl', content: Buffer.from('') },
      { name: 'brain_meta.json', content: Buffer.from('{}') },
    ];
    const payload = tar.pack(files);
    // crypto-02 (audit-2026-06-10): unsigned souls are now REJECTED by default...
    await assert.rejects(
      brain.importBrain({ payload }),
      /unsigned/i,
      'unsigned soul must be rejected by default'
    );

    // ...but the keyholder can import one deliberately with allow_unsigned.
    const result = await brain.importBrain({ payload, allow_unsigned: true });
    assert.equal(result.signature_status, 'unsigned', 'allow_unsigned imports a legacy v0 soul (reported unsigned)');

    // require-mode should also reject legacy (no opt-in under require)
    await assert.rejects(
      brain.importBrain({ payload, signature_mode: 'require' }),
      /unsigned/i,
      'require mode should reject legacy v0'
    );
  } finally {
    await brain.close();
  }
});

test('allow_unsigned does NOT rescue a tampered (invalid) signature', async () => {
  await makeBrain();
  try {
    await brain.setMemory('a.md', 'a', 'test', 'instance');
    const exp = await brain.exportBrain();

    // Tamper the manifest after signing → signature becomes invalid.
    const tar = require('../src/tar');
    const files = tar.unpack(exp.payload);
    const mf = files.find((f) => f.name === 'soul-manifest.json');
    const manifest = JSON.parse(mf.content.toString('utf8'));
    manifest.exported_at = '2020-01-01T00:00:00.000Z';
    mf.content = Buffer.from(JSON.stringify(manifest, null, 2));
    const tampered = tar.pack(files);

    // allow_unsigned is about UNSIGNED souls; it must never bypass tamper detection.
    await assert.rejects(
      brain.importBrain({ payload: tampered, allow_unsigned: true }),
      /invalid|tampered/i,
      'allow_unsigned must not rescue an invalid signature'
    );
  } finally {
    await brain.close();
  }
});
