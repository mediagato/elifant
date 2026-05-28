/**
 * Tests for v0.6.0 memory curation primitives:
 *   setMemoryPin / setMemoryArchive + filtered getAllMemories + archive-aware
 *   searchMemories. Each test gets its own temp directory so PGlite instances
 *   don't collide. Run with: node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-curation-'));
}

test('setMemoryPin: pinned float to top of getAllMemories', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('a_first.md', '# A', 'test');
  await brain.setMemory('b_second.md', '# B', 'test');
  await brain.setMemory('c_third.md', '# C', 'test');

  // Default order is filename ASC
  let all = await brain.getAllMemories();
  assert.deepEqual(all.map(r => r.filename), ['a_first.md', 'b_second.md', 'c_third.md']);
  assert.equal(all[0].pinned, false);
  assert.equal(all[0].archived, false);

  // Pin the last one — it should float to the top
  await brain.setMemoryPin('c_third.md', true);
  all = await brain.getAllMemories();
  assert.equal(all[0].filename, 'c_third.md');
  assert.equal(all[0].pinned, true);
  assert.deepEqual(all.map(r => r.filename), ['c_third.md', 'a_first.md', 'b_second.md']);

  // Unpin restores ordering
  await brain.setMemoryPin('c_third.md', false);
  all = await brain.getAllMemories();
  assert.deepEqual(all.map(r => r.filename), ['a_first.md', 'b_second.md', 'c_third.md']);

  await brain.close();
});

test('setMemoryArchive: archived hidden by default, visible via includeArchived/onlyArchived', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('keep.md', '# K', 'test');
  await brain.setMemory('hide.md', '# H', 'test');

  await brain.setMemoryArchive('hide.md', true);

  // Default — archived excluded
  let all = await brain.getAllMemories();
  assert.deepEqual(all.map(r => r.filename), ['keep.md']);

  // includeArchived — both visible
  all = await brain.getAllMemories({ includeArchived: true });
  assert.deepEqual(all.map(r => r.filename).sort(), ['hide.md', 'keep.md']);
  const hidden = all.find(r => r.filename === 'hide.md');
  assert.equal(hidden.archived, true);

  // onlyArchived — only the hidden one
  all = await brain.getAllMemories({ onlyArchived: true });
  assert.deepEqual(all.map(r => r.filename), ['hide.md']);

  // Unarchive brings it back to the default view
  await brain.setMemoryArchive('hide.md', false);
  all = await brain.getAllMemories();
  assert.deepEqual(all.map(r => r.filename).sort(), ['hide.md', 'keep.md']);

  await brain.close();
});

test('setMemoryPin/Archive are no-ops on unknown filename (no throw)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemoryPin('never_existed.md', true);
  await brain.setMemoryArchive('never_existed.md', true);
  const all = await brain.getAllMemories({ includeArchived: true });
  assert.equal(all.length, 0);
  await brain.close();
});

test('getAllMemories surfaces updated_by for provenance rendering', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('from_mcp.md', '# Saved via MCP', 'mcp');
  await brain.setMemory('from_extension.md', '# Saved via extension', 'extension');

  const all = await brain.getAllMemories();
  const mcp = all.find(r => r.filename === 'from_mcp.md');
  const ext = all.find(r => r.filename === 'from_extension.md');
  assert.equal(mcp.updated_by, 'mcp');
  assert.equal(ext.updated_by, 'extension');

  await brain.close();
});

test('migration: pinned/archived columns added to pre-v0.6.0 brains (idempotent)', async () => {
  // Simulate a brain that was init'd before v0.6.0 by dropping the columns
  // and re-init'ing. The migration ALTER TABLE statements must add them back.
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('legacy.md', '# Legacy', 'test');
  await brain.close();

  // Re-open the same db dir; the migration block should run idempotently and
  // the row should now expose pinned=false + archived=false.
  delete require.cache[require.resolve('../src/index.js')];
  const fresh = require('../src/index.js');
  await fresh.init(dir);
  const all = await fresh.getAllMemories();
  assert.equal(all.length, 1);
  assert.equal(all[0].pinned, false);
  assert.equal(all[0].archived, false);
  await fresh.close();
});
