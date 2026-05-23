/**
 * Smoke tests for @mediagato/brain.
 *
 * Each test gets its own temp directory so PGlite instances don't collide.
 * Run with: node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
}

test('init creates brain/ subdir and PGlite db', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  assert.ok(fs.existsSync(path.join(dir, 'brain')), 'brain subdir should exist');
  assert.equal(brain.dbPath(), path.join(dir, 'brain'));
  await brain.close();
});

test('state round-trip: set, get, getAll, delete', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setState('director', 'qwen2.5:7b', 'test');
  const got = await brain.getState('director');
  assert.equal(got.value, 'qwen2.5:7b');
  assert.equal(got.layer, 'instance');
  assert.ok(got.updated_at, 'updated_at should be set');

  await brain.setState('current_subject', 'biology', 'test');
  const all = await brain.getAllState();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(r => r.key).sort(), ['current_subject', 'director']);

  await brain.deleteState('director');
  const after = await brain.getState('director');
  assert.equal(after, null);

  await brain.close();
});

test('memory delete', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('to_delete.md', '# Bye', 'test');
  assert.ok(await brain.getMemory('to_delete.md'));
  await brain.deleteMemory('to_delete.md');
  assert.equal(await brain.getMemory('to_delete.md'), null);
  // Deleting something that doesn't exist is a no-op (no throw)
  await brain.deleteMemory('never_existed.md');
  await brain.close();
});

test('memory round-trip: set, get, getAll', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setMemory('lesson_plan_template.md', '# Lesson Plan\n- Objective\n- Materials', 'test');
  const got = await brain.getMemory('lesson_plan_template.md');
  assert.match(got.content, /Objective/);
  assert.equal(got.layer, 'instance');

  await brain.setMemory('rubric.md', '# Rubric', 'test', 'pattern');
  const all = await brain.getAllMemories();
  assert.equal(all.length, 2);
  const rubric = all.find(m => m.filename === 'rubric.md');
  assert.equal(rubric.layer, 'pattern');

  await brain.close();
});

test('seedFromSpore writes pattern-layer rows, idempotent', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const spore = {
    state: [
      { key: 'profession', value: 'teacher' },
      { key: 'subject_default', value: 'biology' },
    ],
    memories: [
      { filename: 'lesson_plan.md', content: '# Lesson Plan template' },
      { filename: 'rubric.md', content: '# Rubric template' },
    ],
    steering: [
      { id: 'teach-tone', name: 'Teaching tone', content: 'Use plain language.' },
    ],
  };

  const first = await brain.seedFromSpore(spore);
  assert.equal(first, 5, 'should seed 5 items');

  const seededAt = await brain.isSeeded();
  assert.ok(seededAt, 'isSeeded should return a timestamp');

  // Pattern-layer flag check
  const profession = await brain.getState('profession');
  assert.equal(profession.layer, 'pattern');
  const lessonPlan = await brain.getMemory('lesson_plan.md');
  assert.equal(lessonPlan.layer, 'pattern');

  // Re-seed should not overwrite (ON CONFLICT DO NOTHING)
  await brain.seedFromSpore({
    state: [{ key: 'profession', value: 'lawyer' }],
  });
  const stillTeacher = await brain.getState('profession');
  assert.equal(stillTeacher.value, 'teacher', 're-seed must not overwrite');

  // User-set instance data on top of pattern: setState upserts and changes layer to default 'instance'
  // (current behavior from local-brain.js: setState does not preserve layer)
  await brain.setState('profession', 'teacher_ap_bio', 'user');
  const updated = await brain.getState('profession');
  assert.equal(updated.value, 'teacher_ap_bio');

  await brain.close();
});

test('isSeeded returns null on fresh brain', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const seeded = await brain.isSeeded();
  assert.equal(seeded, null);
  await brain.close();
});

test('getName defaults to Bob; setName sticks', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  assert.equal(await brain.getName(), 'Bob');
  await brain.setName('Mags');
  assert.equal(await brain.getName(), 'Mags');
  await brain.close();
});

test('functions throw before init', async () => {
  // re-require to get a clean module-level state
  delete require.cache[require.resolve('../src/index.js')];
  const fresh = require('../src/index.js');
  await assert.rejects(() => fresh.getName(), /not initialized/);
  await assert.rejects(() => fresh.getState('x'), /not initialized/);
});
