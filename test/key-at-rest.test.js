/**
 * crypto-04 — signing key encryption at rest.
 *
 * Proves that with a keyPassphrase configured, the Ed25519 signing private key is
 * AES-256-GCM sealed and NEVER appears in clear on disk — scanned the same way the
 * YOINK test scans a tarball (dump the real PGlite data dir, look for PEM markers) —
 * while signing (YOINK) still works, wrong/missing passphrases fail loudly, and an
 * existing plaintext key migrates to sealed without changing identity.
 *
 * Sequential by necessity (module-level _db). Run: node --test test/key-at-rest.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const PASS = 'correct-horse-battery-staple';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-keyrest-test-'));
}
function freshBrain() {
  delete require.cache[require.resolve('../src/index.js')];
  return require('../src/index.js');
}

// Read the raw stored signing_keypair_v1 record (as the DB holds it).
async function storedKeyRecord(brain) {
  const r = await brain._internal.query("SELECT value FROM brain_meta WHERE key = 'signing_keypair_v1'");
  return r.rows[0] ? JSON.parse(r.rows[0].value) : null;
}

// Dump the live PGlite data dir (gzip) and return its decompressed bytes as a
// binary string — the on-disk truth, same technique yoink.test uses on tarballs.
async function dumpBytes(db) {
  const file = await db.dumpDataDir('gzip');
  const gz = Buffer.from(await file.arrayBuffer());
  return zlib.gunzipSync(gz).toString('binary');
}

// ── the sealing primitive ──────────────────────────────────────────────────

test('seal/open round-trips a PEM and rejects a wrong passphrase', () => {
  const brain = freshBrain();
  const pem = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIabc\n-----END PRIVATE KEY-----\n';
  const env = brain._internal.sealPrivatePem(pem, PASS);
  assert.equal(env.alg, 'aes-256-gcm');
  assert.equal(env.kdf, 'pbkdf2');
  assert.equal(env.iter, 600000);
  // The envelope must not contain the plaintext PEM anywhere.
  assert.ok(!JSON.stringify(env).includes('BEGIN PRIVATE KEY'), 'sealed envelope must not carry the PEM');
  assert.equal(brain._internal.openPrivatePem(env, PASS), pem, 'correct passphrase recovers the PEM');
  assert.throws(() => brain._internal.openPrivatePem(env, 'wrong-pass'), /decryption failed/i);
  // Two seals of the same PEM must use a FRESH iv AND salt — assert both directly
  // (a stable-ct check alone can't detect a hardcoded IV, since a fresh salt already
  // changes the ciphertext; GCM nonce reuse is the catastrophic failure to guard).
  const env2 = brain._internal.sealPrivatePem(pem, PASS);
  assert.notEqual(env.iv, env2.iv, 'each seal uses a fresh IV (GCM nonce must never repeat)');
  assert.notEqual(env.salt, env2.salt, 'each seal uses a fresh salt');
  assert.notEqual(env.ct, env2.ct, 'ciphertext differs per seal');
});

test('open rejects an unknown envelope version/algorithm (fail closed, no downgrade)', () => {
  const brain = freshBrain();
  const pem = '-----BEGIN PRIVATE KEY-----\nMC4=\n-----END PRIVATE KEY-----\n';
  const env = brain._internal.sealPrivatePem(pem, PASS);
  assert.throws(() => brain._internal.openPrivatePem({ ...env, v: 2 }, PASS), /unsupported version or algorithm/i);
  assert.throws(() => brain._internal.openPrivatePem({ ...env, alg: 'aes-128-gcm' }, PASS), /unsupported version or algorithm/i);
});

test('a single flipped ciphertext byte fails the auth tag (tamper detection)', () => {
  const brain = freshBrain();
  const pem = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIabc\n-----END PRIVATE KEY-----\n';
  const env = brain._internal.sealPrivatePem(pem, PASS);
  const ctBuf = Buffer.from(env.ct, 'base64');
  ctBuf[0] ^= 0x01; // flip one bit
  const tampered = { ...env, ct: ctBuf.toString('base64') };
  assert.throws(() => brain._internal.openPrivatePem(tampered, PASS), /decryption failed/i);
});

// ── default (no passphrase) stays plaintext, unchanged ──────────────────────

test('no keyPassphrase → legacy plaintext key (unchanged behavior)', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.exportBrain(); // triggers key generation + signing
    assert.equal(await brain.signingKeyProtection(), 'plaintext');
    const rec = await storedKeyRecord(brain);
    assert.ok(rec.private_pem && rec.private_pem.includes('BEGIN PRIVATE KEY'), 'plaintext PEM stored as before');
    assert.ok(!rec.enc, 'no sealed envelope when no passphrase');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── with a passphrase, the key is sealed at rest ────────────────────────────

test('keyPassphrase → private key sealed; PEM never on disk; signing still works', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  try {
    const db = await brain.init(dir, { keyPassphrase: PASS });
    await brain.setMemory('note.md', 'hello', 'test', 'instance');
    const exported = await brain.exportBrain(); // signs with the sealed key

    // 1. status + stored record
    assert.equal(await brain.signingKeyProtection(), 'encrypted');
    const rec = await storedKeyRecord(brain);
    assert.ok(rec.enc, 'sealed envelope present');
    assert.ok(!rec.private_pem, 'no plaintext private_pem field');
    assert.ok(rec.public_b64, 'public key still stored in clear (it is public)');

    // 2. THE at-rest proof: scan the raw data-dir bytes for PEM markers.
    const bytes = await dumpBytes(db);
    assert.ok(!bytes.includes('BEGIN PRIVATE KEY'), 'no PEM private-key marker anywhere on disk');
    assert.ok(!bytes.includes('private_pem'), 'no private_pem field name on disk');

    // 3. signing actually worked — round-trip verifies the signature.
    assert.ok(exported.manifest.signature && exported.manifest.signature.signature, 'export is signed');
    const imp = await brain.importBrain({ payload: exported.payload, conflict: 'newer-wins' });
    assert.equal(imp.signature_status, 'verified', 'sealed key produced a valid signature');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot tarball of a sealed brain holds no plaintext signing key', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  try {
    await brain.init(dir, { keyPassphrase: PASS });
    await brain.exportBrain(); // generate + seal the key
    await brain.snapshot('crypto-04 at-rest test');
    const snapDir = path.join(dir, 'snapshots');
    const tgz = fs.readdirSync(snapDir).find((f) => f.endsWith('.tar.gz'));
    assert.ok(tgz, 'a snapshot tarball was written');
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(snapDir, tgz))).toString('binary');
    assert.ok(!raw.includes('BEGIN PRIVATE KEY'), 'snapshot tarball must not hold the plaintext key');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── reopen behavior: right pass reads it, wrong/missing fails LOUDLY ─────────

test('reopen with the same passphrase reads the key; identity is stable', async () => {
  const dir = tmpDir();
  let pub1;
  try {
    let brain = freshBrain();
    await brain.init(dir, { keyPassphrase: PASS });
    pub1 = (await brain._internal.getSigningKey()).publicKeyB64;
    await brain.close();

    brain = freshBrain();
    await brain.init(dir, { keyPassphrase: PASS });
    const pub2 = (await brain._internal.getSigningKey()).publicKeyB64;
    assert.equal(pub2, pub1, 'same key recovered across reopen');
    await brain.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reopen WITHOUT the passphrase fails loudly — never silently plaintext', async () => {
  const dir = tmpDir();
  try {
    let brain = freshBrain();
    await brain.init(dir, { keyPassphrase: PASS });
    await brain.exportBrain(); // seal the key
    await brain.close();

    brain = freshBrain();
    await brain.init(dir); // no passphrase
    // read-only status still works (doesn't touch key material)
    assert.equal(await brain.signingKeyProtection(), 'encrypted');
    // but anything needing the key must refuse, not fall back to a broken/empty key
    await assert.rejects(() => brain._internal.getSigningKey(), /no keyPassphrase is configured/i);
    await assert.rejects(() => brain.exportBrain(), /keyPassphrase/i);
    await brain.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reopen with the WRONG passphrase is rejected (GCM auth-tag)', async () => {
  const dir = tmpDir();
  try {
    let brain = freshBrain();
    await brain.init(dir, { keyPassphrase: PASS });
    await brain.exportBrain();
    await brain.close();

    brain = freshBrain();
    await brain.init(dir, { keyPassphrase: 'the-wrong-passphrase' });
    await assert.rejects(() => brain._internal.getSigningKey(), /decryption failed/i);
    await brain.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── migration: an existing plaintext key seals on first passphrase use ───────

test('plaintext key migrates to sealed on first passphrase use — same identity', async () => {
  const dir = tmpDir();
  let pubBefore;
  try {
    // Phase 1: create a legacy plaintext key.
    let brain = freshBrain();
    let db = await brain.init(dir);
    await brain.exportBrain();
    assert.equal(await brain.signingKeyProtection(), 'plaintext');
    pubBefore = (await brain._internal.getSigningKey()).publicKeyB64;
    let bytes = await dumpBytes(db);
    assert.ok(bytes.includes('BEGIN PRIVATE KEY'), 'sanity: plaintext key IS on disk before migration');
    await brain.close();

    // Phase 2: reopen WITH a passphrase → first use migrates it in place.
    brain = freshBrain();
    db = await brain.init(dir, { keyPassphrase: PASS });
    const pubAfter = (await brain._internal.getSigningKey()).publicKeyB64;
    assert.equal(pubAfter, pubBefore, 'migration preserves the signing identity (public key unchanged)');
    assert.equal(await brain.signingKeyProtection(), 'encrypted', 'now sealed');

    // The ACTIVE record is sealed — this is the guaranteed part. (The prior
    // plaintext may still linger in WAL/backups until churn; migration is a
    // best-effort upgrade, NOT a scrub — see the crypto-04 note. Airtight
    // zero-plaintext is the born-sealed path, proven in the sealed-at-rest test.)
    const rec = await storedKeyRecord(brain);
    assert.ok(rec.enc && rec.migrated_at, 'record shows a sealed, migrated key');
    assert.ok(!rec.private_pem, 'plaintext PEM field removed from the active record');

    // still signs after migration
    const exported = await brain.exportBrain();
    const imp = await brain.importBrain({ payload: exported.payload, conflict: 'newer-wins' });
    assert.equal(imp.signature_status, 'verified', 'migrated key still signs validly');
    await brain.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── fork must also seal (regression: fork once wrote plaintext) ──────────────

// Recursively read every file under dir and return the concatenated bytes as a
// binary string — used to prove a PEM marker appears nowhere in a PGlite dir.
function scanDirBytes(dir) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out += scanDirBytes(p);
    else out += fs.readFileSync(p).toString('binary');
  }
  return out;
}

test('fork of a sealed brain seals the fork key too — no plaintext in forks/', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  try {
    await brain.init(dir, { keyPassphrase: PASS });
    await brain.setMemory('m.md', 'forkme', 'test', 'instance');
    const snap = await brain.snapshot('pre-fork');
    const res = await brain.rollback(snap.snapshot_id, 'fork');
    const forkBrainDir = path.join(res.fork_path, 'brain');
    assert.ok(fs.existsSync(forkBrainDir), 'fork materialized');
    const bytes = scanDirBytes(forkBrainDir);
    assert.ok(!bytes.includes('BEGIN PRIVATE KEY'), 'fork must not write its signing key in plaintext when a passphrase is configured');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── integrity: a swapped/corrupt public key is caught on open ────────────────

test('a private/public mismatch in the stored record is rejected on open', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  try {
    await brain.init(dir, { keyPassphrase: PASS });
    await brain._internal.getSigningKey(); // generate + cache
    await brain.close();

    // Reopen and corrupt the advertised public key to a different valid value.
    const brain2 = freshBrain();
    await brain2.init(dir, { keyPassphrase: PASS });
    const rec = await storedKeyRecord(brain2);
    const otherPub = Buffer.alloc(32, 7).toString('base64'); // wrong-but-well-formed
    rec.public_b64 = otherPub;
    await brain2._internal.query("UPDATE brain_meta SET value = $1 WHERE key = 'signing_keypair_v1'", [JSON.stringify(rec)]);
    await brain2.close();

    const brain3 = freshBrain();
    await brain3.init(dir, { keyPassphrase: PASS });
    await assert.rejects(() => brain3._internal.getSigningKey(), /integrity check failed/i);
    await brain3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── env var is honored ──────────────────────────────────────────────────────

test('ELIFANT_KEY_PASSPHRASE env var seals the key when no option is passed', async () => {
  const dir = tmpDir();
  const prev = process.env.ELIFANT_KEY_PASSPHRASE;
  process.env.ELIFANT_KEY_PASSPHRASE = PASS;
  try {
    const brain = freshBrain();
    await brain.init(dir); // no explicit option — env should apply
    await brain.exportBrain();
    assert.equal(await brain.signingKeyProtection(), 'encrypted');
    await brain.close();
  } finally {
    if (prev === undefined) delete process.env.ELIFANT_KEY_PASSPHRASE;
    else process.env.ELIFANT_KEY_PASSPHRASE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init rejects an empty-string or non-string keyPassphrase (no silent downgrade)', async () => {
  const brain = freshBrain();
  const dir = tmpDir();
  try {
    await assert.rejects(() => brain.init(dir, { keyPassphrase: '' }), /non-empty string/i);
    await assert.rejects(() => brain.init(dir, { keyPassphrase: 12345 }), /non-empty string/i);
    await assert.rejects(() => brain.init(dir, { keyPassphrase: null }), /non-empty string/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
