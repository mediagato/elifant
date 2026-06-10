/**
 * crypto-01 — keyholder key pinning (TOFU trust anchor).
 *
 * A 'verified' signature only proves the soul is internally self-consistent and
 * signed by SOMEBODY — the verify key comes from the manifest itself, so an
 * attacker self-signs a poisoned soul and gets 'verified' (audit-2026-06-10
 * crypto-01). importBrain now pins the public key first seen for each foreign
 * substrate_identity and rejects a later soul that claims the same identity with
 * a different key.
 *
 * Run with: node --test test/
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-kh-')); }

// Export a signed soul from a throwaway bowl. Returns the payload plus the
// sender's identity + public key (read straight off the signed manifest).
async function exportFrom(name) {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setName(name);
  await brain.setMemory('m.md', `hi from ${name}`, 'test', 'instance');
  const exp = await brain.exportBrain();
  await brain.close();
  return {
    payload: exp.payload,
    identity: exp.manifest.substrate_identity,
    key: exp.manifest.signature.keyholder_public_key,
  };
}

const BOGUS_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

test('crypto-01: a self round-trip is trusted (sender_trust=self)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('a.md', 'a', 'test', 'instance');
    const exp = await brain.exportBrain();
    const res = await brain.importBrain({ payload: exp.payload });
    assert.equal(res.signature_status, 'verified');
    assert.equal(res.sender_trust, 'self');
  } finally { await brain.close(); }
});

test('crypto-01: first contact from a foreign bowl is accepted, flagged, and pinned', async () => {
  const sender = await exportFrom('Sender');
  const dir = tmpDir();
  await brain.init(dir);
  try {
    const res = await brain.importBrain({ payload: sender.payload });
    assert.equal(res.signature_status, 'verified');
    assert.equal(res.sender_trust, 'first-contact');
    const khs = await brain.listKeyholders();
    assert.equal(khs.length, 1);
    assert.equal(khs[0].substrate_identity, sender.identity);
    assert.equal(khs[0].public_key, sender.key);
    assert.equal(Boolean(khs[0].trusted), false, 'first contact is recorded but not yet blessed');
  } finally { await brain.close(); }
});

test('crypto-01: trust_sender blesses the sender (trusted-now), and a re-import is trusted', async () => {
  const sender = await exportFrom('Friend');
  const dir = tmpDir();
  await brain.init(dir);
  try {
    const r1 = await brain.importBrain({ payload: sender.payload, trust_sender: true });
    assert.equal(r1.sender_trust, 'trusted-now');
    // 0.14.0: re-importing the EXACT same soul is now an exact-reconsume replay, so the
    // deliberate re-import opts in with allow_replay; the trust resolution still says 'trusted'.
    const r2 = await brain.importBrain({ payload: sender.payload, allow_replay: true });
    assert.equal(r2.sender_trust, 'trusted');
  } finally { await brain.close(); }
});

test('crypto-01: a DIFFERENT key for a pinned identity is rejected as impersonation', async () => {
  const sender = await exportFrom('RealFriend');
  const dir = tmpDir();
  await brain.init(dir);
  try {
    // Pin a DIFFERENT key for this identity (as if blessed out-of-band), so the
    // incoming soul — signed with the real, different key — is a key mismatch.
    await brain.pinKeyholder(sender.identity, BOGUS_KEY, { trusted: true });
    await assert.rejects(
      brain.importBrain({ payload: sender.payload }),
      /different signing key|impersonation/i,
      'a key mismatch for a pinned identity must be rejected'
    );
  } finally { await brain.close(); }
});

test('crypto-01: accept_key_change accepts a deliberate rotation and re-pins', async () => {
  const sender = await exportFrom('Rotator');
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.pinKeyholder(sender.identity, BOGUS_KEY, { trusted: true });
    const res = await brain.importBrain({ payload: sender.payload, accept_key_change: true });
    assert.equal(res.sender_trust, 'key-rotated');
    const khs = await brain.listKeyholders();
    assert.equal(khs[0].public_key, sender.key, 'pinned key is updated to the new one');
  } finally { await brain.close(); }
});

test('crypto-01: setKeyholderTrust / forgetKeyholder manage trust state', async () => {
  const sender = await exportFrom('Managed');
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.importBrain({ payload: sender.payload }); // first-contact, untrusted
    await brain.setKeyholderTrust(sender.identity, true);
    let khs = await brain.listKeyholders();
    assert.equal(Boolean(khs[0].trusted), true);

    await brain.forgetKeyholder(sender.identity);
    khs = await brain.listKeyholders();
    assert.equal(khs.length, 0, 'forgetting un-pins the keyholder');

    // After forgetting, the same sender is first-contact again.
    const res = await brain.importBrain({ payload: sender.payload });
    assert.equal(res.sender_trust, 'first-contact');
  } finally { await brain.close(); }
});
