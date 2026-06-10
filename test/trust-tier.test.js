/**
 * H1 trust_tier — slice 1 (data model). Every memory/state/steering row carries a
 * trust tier. Native writes default to tier-1 (keyholder-direct); a PIN promotes to
 * tier-1 (decision-a); SUMMON of a foreign soul DEMOTES its rows to tier-3
 * (observed-external) by default, with a tier_policy:'preserve' override for an
 * attended "I trust this keyholder" import (decision-b); a self round-trip preserves.
 * This slice only TAGS + CARRIES tiers — the read/inject path honoring them is slice 2.
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
const tar = require('../src/tar.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tier-')); }

// Export a signed soul from a throwaway (foreign-identity) bowl carrying one memory.
async function exportFrom(name, memName = 'm.md') {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setName(name);
  await brain.setMemory(memName, `hi from ${name}`, 'test', 'instance');
  const exp = await brain.exportBrain();
  await brain.close();
  return exp;
}

test('slice1: a native memory write defaults to tier-1 (keyholder-direct)', async () => {
  await brain.init(tmpDir());
  try {
    await brain.setMemory('a.md', 'mine', 'test', 'instance');
    const m = await brain.getMemory('a.md');
    assert.equal(m.trust_tier, 'tier-1-keyholder-direct');
  } finally { await brain.close(); }
});

test('slice1: SUMMON of a foreign soul DEMOTES its rows to tier-3 by default (decision-b)', async () => {
  const exp = await exportFrom('Friend');
  await brain.init(tmpDir());
  try {
    const res = await brain.importBrain({ payload: exp.payload });
    assert.equal(res.sender_trust, 'first-contact');
    const m = await brain.getMemory('m.md');
    assert.equal(m.trust_tier, 'tier-3-observed-external', 'a foreign keyholder-direct claim is observed-external from my bowl');
  } finally { await brain.close(); }
});

test('slice1: tier_policy:preserve keeps the foreign tiers (the "I trust this keyholder" import)', async () => {
  const exp = await exportFrom('Trusted');
  await brain.init(tmpDir());
  try {
    await brain.importBrain({ payload: exp.payload, tier_policy: 'preserve' });
    const m = await brain.getMemory('m.md');
    assert.equal(m.trust_tier, 'tier-1-keyholder-direct', 'preserve keeps the sender tier');
  } finally { await brain.close(); }
});

test('slice1: a self round-trip PRESERVES tiers (your own export coming home)', async () => {
  await brain.init(tmpDir());
  try {
    await brain.setMemory('self.md', 'mine', 'test', 'instance');
    const exp = await brain.exportBrain();
    const res = await brain.importBrain({ payload: exp.payload }); // same bowl → self
    assert.equal(res.sender_trust, 'self');
    const m = await brain.getMemory('self.md');
    assert.equal(m.trust_tier, 'tier-1-keyholder-direct');
  } finally { await brain.close(); }
});

test('slice1: pin promotes a demoted memory back to tier-1 (decision-a)', async () => {
  const exp = await exportFrom('Acquaintance');
  await brain.init(tmpDir());
  try {
    await brain.importBrain({ payload: exp.payload }); // m.md lands tier-3
    let m = await brain.getMemory('m.md');
    assert.equal(m.trust_tier, 'tier-3-observed-external');
    await brain.setMemoryPin('m.md', true);
    m = await brain.getMemory('m.md');
    assert.equal(m.trust_tier, 'tier-1-keyholder-direct', 'a pin is the keyholder vouching → tier-1');
  } finally { await brain.close(); }
});

test('slice1: trust_tier travels on export (a demoted memory re-exports as tier-3)', async () => {
  const exp = await exportFrom('Origin');
  await brain.init(tmpDir());
  try {
    await brain.importBrain({ payload: exp.payload }); // m.md → tier-3 locally
    const reexport = await brain.exportBrain();
    const files = tar.unpack(reexport.payload);
    const memFile = files.find((f) => f.name === 'memories.jsonl');
    const lines = memFile.content.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    const m = lines.find((r) => r.filename === 'm.md');
    assert.equal(m.trust_tier, 'tier-3-observed-external', 'the tier is serialized and travels');
  } finally { await brain.close(); }
});
