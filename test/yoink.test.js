/**
 * YOINK / SUMMON round-trip tests (v0.2.0).
 *
 * Each test creates a tmpDir + brain instance, exercises export/import, and
 * closes the brain so subsequent tests get fresh state. Module-level _db state
 * inside @mediagato/brain forces sequential testing — that's fine for now.
 *
 * Run with: node --test test/yoink.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tar = require('../src/tar.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-yoink-test-'));
}

/** Re-import @mediagato/brain with fresh module-level state. */
function freshBrain() {
  delete require.cache[require.resolve('../src/index.js')];
  return require('../src/index.js');
}

test('tar pack/unpack round-trips small files', () => {
  const files = [
    { name: 'a.txt', content: 'hello' },
    { name: 'b.json', content: JSON.stringify({ x: 1, y: 'two' }) },
    { name: 'c.bin', content: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) },
  ];
  const buf = tar.pack(files);
  // tar archives end with two empty 512-byte blocks
  assert.ok(buf.length % 512 === 0, 'tar output should be 512-byte aligned');
  assert.ok(buf.length >= 4 * 512, 'tar should have at least one header block + payload + 2 empty');

  const back = tar.unpack(buf);
  assert.equal(back.length, 3);
  assert.equal(back[0].name, 'a.txt');
  assert.equal(back[0].content.toString('utf8'), 'hello');
  assert.equal(back[1].name, 'b.json');
  assert.deepEqual(JSON.parse(back[1].content.toString('utf8')), { x: 1, y: 'two' });
  assert.equal(back[2].name, 'c.bin');
  assert.deepEqual([...back[2].content], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('tar handles content that is not 512-aligned', () => {
  const odd = 'x'.repeat(513);  // forces one block of padding
  const buf = tar.pack([{ name: 'odd.txt', content: odd }]);
  const back = tar.unpack(buf);
  assert.equal(back[0].content.toString('utf8'), odd);
});

test('exportBrain returns manifest + tar payload', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setName('TestBob');
  await brain.setState('director', 'qwen2.5:7b', 'test');
  await brain.setMemory('hello.md', '# Hello world', 'test');

  const result = await brain.exportBrain();
  assert.ok(result.manifest);
  assert.equal(result.manifest.schema, 'elifantic-soul-v0.2');
  assert.equal(result.manifest.display_name, 'TestBob');
  assert.ok(result.manifest.substrate_identity, 'substrate_identity should be auto-generated');
  assert.equal(result.manifest.table_counts.state, 1);
  assert.equal(result.manifest.table_counts.memories, 1);
  assert.ok(Buffer.isBuffer(result.payload));
  assert.equal(result.bytes, result.payload.length);

  // Tar should contain the expected files
  const files = tar.unpack(result.payload);
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, [
    'brain_meta.json',
    'memories.jsonl',
    'review_lessons.jsonl',
    'soul-manifest.json',
    'state.jsonl',
    'steering.jsonl',
  ]);

  await brain.close();
});

test('YOINK/SUMMON round-trip: export from A, import into fresh B', async () => {
  const brainA = freshBrain();
  const dirA = tmpDir();
  await brainA.init(dirA);

  await brainA.setName('Alice');
  await brainA.setState('director', 'qwen2.5:7b', 'test');
  await brainA.setState('subject', 'biology', 'test');
  await brainA.setMemory('lesson1.md', '# Lesson 1\nAbout cells.', 'test');
  await brainA.setMemory('lesson2.md', '# Lesson 2\nAbout mitosis.', 'test');
  await brainA.seedFromSpore({
    steering: [{ id: 'tone-formal', name: 'Formal tone', content: 'Use plain language.' }],
  });

  const exported = await brainA.exportBrain();
  await brainA.close();

  // Fresh brain B: import the tarball and verify everything came across.
  const brainB = freshBrain();
  const dirB = tmpDir();
  await brainB.init(dirB);

  const result = await brainB.importBrain({ payload: exported.payload });
  assert.equal(result.imported.state, 2);
  assert.equal(result.imported.memories, 2);
  assert.equal(result.imported.steering, 1);
  assert.equal(result.conflicts, 0, 'fresh brain should have no conflicts');

  // Verify content
  const director = await brainB.getState('director');
  assert.equal(director.value, 'qwen2.5:7b');
  const lesson1 = await brainB.getMemory('lesson1.md');
  assert.match(lesson1.content, /About cells/);
  assert.equal(await brainB.getName(), 'Alice', 'display_name should round-trip via brain_meta');

  await brainB.close();
});

test('conflict policy: skip leaves existing rows alone', async () => {
  const brainA = freshBrain();
  const dirA = tmpDir();
  await brainA.init(dirA);
  await brainA.setState('shared_key', 'value-from-A', 'A');
  const exported = await brainA.exportBrain();
  await brainA.close();

  const brainB = freshBrain();
  const dirB = tmpDir();
  await brainB.init(dirB);
  await brainB.setState('shared_key', 'value-from-B', 'B');

  const result = await brainB.importBrain({ payload: exported.payload, conflict: 'skip' });
  assert.equal(result.conflicts, 1);
  assert.equal(result.imported.state, 0);
  assert.equal(result.skipped, 1);
  const value = await brainB.getState('shared_key');
  assert.equal(value.value, 'value-from-B', 'B should keep its own value under skip');

  await brainB.close();
});

test('conflict policy: overwrite replaces existing rows', async () => {
  const brainA = freshBrain();
  const dirA = tmpDir();
  await brainA.init(dirA);
  await brainA.setState('shared_key', 'value-from-A', 'A');
  const exported = await brainA.exportBrain();
  await brainA.close();

  const brainB = freshBrain();
  const dirB = tmpDir();
  await brainB.init(dirB);
  await brainB.setState('shared_key', 'value-from-B', 'B');

  const result = await brainB.importBrain({ payload: exported.payload, conflict: 'overwrite' });
  assert.equal(result.imported.state, 1);
  const value = await brainB.getState('shared_key');
  assert.equal(value.value, 'value-from-A', 'A should overwrite under overwrite policy');

  await brainB.close();
});

test('conflict policy: newer-wins picks whichever updated_at is newer', async () => {
  // Set up A with an older timestamp; B with a newer timestamp on same key.
  const brainA = freshBrain();
  const dirA = tmpDir();
  await brainA.init(dirA);
  await brainA.setState('shared_key', 'value-from-A', 'A');
  // wait so A's updated_at is genuinely older
  await new Promise((r) => setTimeout(r, 20));
  const exported = await brainA.exportBrain();
  await brainA.close();

  await new Promise((r) => setTimeout(r, 20));

  const brainB = freshBrain();
  const dirB = tmpDir();
  await brainB.init(dirB);
  await brainB.setState('shared_key', 'value-from-B-NEWER', 'B');

  const result = await brainB.importBrain({ payload: exported.payload, conflict: 'newer-wins' });
  // B's row is newer than A's, so A loses
  assert.equal(result.skipped, 1, 'A row should be skipped because B is newer');
  const value = await brainB.getState('shared_key');
  assert.equal(value.value, 'value-from-B-NEWER');

  await brainB.close();
});

test('substrate_identity is never overwritten on import', async () => {
  const brainA = freshBrain();
  const dirA = tmpDir();
  await brainA.init(dirA);
  // force substrate_identity generation via export
  const exported = await brainA.exportBrain();
  const aIdentity = exported.manifest.substrate_identity;
  await brainA.close();

  const brainB = freshBrain();
  const dirB = tmpDir();
  await brainB.init(dirB);
  const bExportBefore = await brainB.exportBrain();
  const bIdentity = bExportBefore.manifest.substrate_identity;
  assert.notEqual(aIdentity, bIdentity, 'two fresh bowls should have different identities');

  await brainB.importBrain({ payload: exported.payload });

  const bExportAfter = await brainB.exportBrain();
  assert.equal(bExportAfter.manifest.substrate_identity, bIdentity,
    'B should keep its own substrate_identity even after importing A');

  await brainB.close();
});

test('layer filter: instance-only export drops pattern rows', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setState('user_pref', 'dark', 'user');                 // instance
  await brain.seedFromSpore({ state: [{ key: 'spore_pref', value: 'default' }] });  // pattern

  const fullExport = await brain.exportBrain();
  assert.equal(fullExport.manifest.table_counts.state, 2, 'default exports all layers');

  const instanceOnly = await brain.exportBrain({ include: { layers: ['instance'] } });
  assert.equal(instanceOnly.manifest.table_counts.state, 1, 'layer filter should drop pattern rows');

  await brain.close();
});

test('importBrain rejects malformed archives', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  await brain.init(dir);

  await assert.rejects(
    () => brain.importBrain({ payload: Buffer.from('not a tar') }),
    /soul-manifest/
  );

  // Tar that doesn't have a soul-manifest.json
  const fakeArchive = tar.pack([{ name: 'state.jsonl', content: '{}\n' }]);
  await assert.rejects(
    () => brain.importBrain({ payload: fakeArchive }),
    /soul-manifest/
  );

  await brain.close();
});

test('exportBrain rejects encrypt option until encrypted-export lands', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  await brain.init(dir);

  await assert.rejects(
    () => brain.exportBrain({ encrypt: { method: 'aes-256-gcm' } }),
    /encrypted export/
  );

  await brain.close();
});

// ─── v0.3.0-dev.3 regression tests for ultrareview findings ─────────────

test('bug_009: YOINK export does NOT contain private signing key', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  await brain.init(dir);

  // Trigger lazy signing-key generation by exporting (sign-by-default).
  await brain.setMemory('hello.md', 'world', 'test');
  const exported = await brain.exportBrain();

  // brain_meta.json must not contain the private key
  const entries = tar.unpack(exported.payload);
  const brainMetaEntry = entries.find((e) => e.name === 'brain_meta.json');
  assert.ok(brainMetaEntry, 'sanity: brain_meta.json should be in the tarball');
  const brainMeta = JSON.parse(brainMetaEntry.content.toString('utf8'));
  assert.equal(brainMeta.signing_keypair_v1, undefined,
    'signing_keypair_v1 must NEVER appear in YOINK export brain_meta.json');

  // Defense in depth: scan the entire tarball bytes for PEM markers and the
  // JSON field name that wraps the private key. Anything that leaks the
  // private key would have one of these byte sequences.
  const fullPayload = exported.payload.toString('binary');
  assert.ok(!fullPayload.includes('BEGIN PRIVATE KEY'),
    'PEM "BEGIN PRIVATE KEY" marker must NOT appear anywhere in the tarball');
  assert.ok(!fullPayload.includes('private_pem'),
    'JSON field "private_pem" must NOT appear anywhere in the tarball');

  await brain.close();
});

test('bug_009: SUMMON does not overwrite receiver signing key', async () => {
  // Sender brain
  const sender = freshBrain();
  const senderDir = tmpDir();
  await sender.init(senderDir);
  await sender.setName('Sender');
  await sender.setMemory('a.md', '1', 'test');
  const senderExport = await sender.exportBrain();
  const senderPubKey = senderExport.manifest.signature.keyholder_public_key;
  await sender.close();

  // Receiver brain (distinct instance, fresh dir)
  const receiver = freshBrain();
  const recvDir = tmpDir();
  await receiver.init(recvDir);
  await receiver.setName('Receiver');
  // Trigger receiver's own signing key generation
  const beforeExport = await receiver.exportBrain();
  const recvPubKeyBefore = beforeExport.manifest.signature.keyholder_public_key;

  assert.notEqual(senderPubKey, recvPubKeyBefore,
    'test prerequisite: sender and receiver must have different signing keys');

  // SUMMON the sender's bundle into receiver
  await receiver.importBrain({ payload: senderExport.payload });

  // Re-export from receiver and verify its public key is unchanged
  const afterExport = await receiver.exportBrain();
  const recvPubKeyAfter = afterExport.manifest.signature.keyholder_public_key;
  assert.equal(recvPubKeyAfter, recvPubKeyBefore,
    'Receiver signing key must remain unchanged after SUMMON');

  await receiver.close();
});

test('bug_013: tampered payload bytes cause signature_status=invalid', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setName('TamperBob');
  await brain.setMemory('truth.md', 'I am the original content', 'test');
  const exported = await brain.exportBrain();
  await brain.close();

  // Unpack, modify memories.jsonl content (same byte length so row count
  // is preserved — exactly the attack v0.2's manifest-only signature
  // originally couldn't detect), re-pack.
  const entries = tar.unpack(exported.payload);
  const tampered = entries.map((e) => {
    if (e.name === 'memories.jsonl') {
      const original = e.content.toString('utf8');
      const evil = original.replace(
        'I am the original content',
        'I am replacement content!'  // same length: 25 chars
      );
      assert.equal(evil.length, original.length, 'test setup: tampered bytes must match length');
      return { name: e.name, content: evil };
    }
    return e;
  });
  const tamperedPayload = tar.pack(tampered);

  // signature_mode=require should throw on tampered payload
  const recv1 = freshBrain();
  await recv1.init(tmpDir());
  await assert.rejects(
    () => recv1.importBrain({ payload: tamperedPayload, signature_mode: 'require' }),
    /tampered|hash mismatch/i
  );
  await recv1.close();

  // signature_mode=verify (default) should report invalid but not throw
  const recv2 = freshBrain();
  await recv2.init(tmpDir());
  const result = await recv2.importBrain({ payload: tamperedPayload });
  assert.equal(result.signature_status, 'invalid',
    'tampered payload must downgrade signature_status to invalid');
  await recv2.close();
});

test("bug_008: signature_status='skipped' when sigMode='skip' on a signed manifest", async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setName('SkipTest');
  await brain.setMemory('a.md', '1', 'test');
  const signedExport = await brain.exportBrain();
  assert.ok(signedExport.manifest.signature, 'sanity: manifest must be signed by default');
  await brain.close();

  // signed manifest + sigMode='skip' → status should be 'skipped'
  const recv1 = freshBrain();
  await recv1.init(tmpDir());
  const result1 = await recv1.importBrain({
    payload: signedExport.payload,
    signature_mode: 'skip',
  });
  assert.equal(result1.signature_status, 'skipped',
    "signed manifest + sigMode='skip' must report 'skipped', not 'unsigned'");
  await recv1.close();

  // Unsigned manifest + sigMode='skip' should still be 'unsigned'
  const brain2 = freshBrain();
  await brain2.init(tmpDir());
  const unsignedExport = await brain2.exportBrain({ unsigned: true });
  assert.equal(unsignedExport.manifest.signature, undefined, 'sanity: unsigned export has no signature');
  await brain2.close();

  const recv2 = freshBrain();
  await recv2.init(tmpDir());
  const result2 = await recv2.importBrain({
    payload: unsignedExport.payload,
    signature_mode: 'skip',
  });
  assert.equal(result2.signature_status, 'unsigned',
    "unsigned manifest must report 'unsigned' regardless of sigMode");
  await recv2.close();
});
