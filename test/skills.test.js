'use strict';
// Regression guards for the polyglot-skills layer (v0.10.0). Hermetic: every
// test plants a fake $HOME / project tree in a tmp dir and overrides `home`, so
// it exercises the vendored registry snapshot end-to-end without reading the
// real machine. Run: node --test test/skills.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { skills } = require('../src/index.js');
const { loadSkillRegistry, scanSkills, carrySkill, VENDORED_REGISTRY } = skills;

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elifant-skills-'));
const rmTmp = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ── loadSkillRegistry ─────────────────────────────────────────────────────────

test('loadSkillRegistry: the vendored snapshot is present + shaped', () => {
  const reg = loadSkillRegistry();
  assert.equal(reg.kind, 'elifantic.skills-registry');
  assert.ok(Array.isArray(reg.hosts) && reg.hosts.length > 0, 'no hosts in snapshot');
  assert.ok(reg.hosts.some((h) => h.id === 'claude-skills-user'), 'missing claude-skills-user');
  // every host carries the fields scanSkills relies on
  for (const h of reg.hosts) {
    for (const f of ['id', 'label', 'scope', 'path', 'match', 'format', 'extract']) {
      assert.ok(h[f] !== undefined, `host ${h.id} missing ${f}`);
    }
  }
  assert.ok(fs.existsSync(VENDORED_REGISTRY), 'VENDORED_REGISTRY path does not exist');
});

test('loadSkillRegistry: a caller-supplied registry wins over the snapshot', () => {
  const custom = { version: '9', kind: 'test', hosts: [{ id: 'only-me' }] };
  const reg = loadSkillRegistry({ registry: custom });
  assert.equal(reg.version, '9');
  assert.deepEqual(reg.hosts, [{ id: 'only-me' }]);
});

// ── scanSkills (READ) ─────────────────────────────────────────────────────────

test('scanSkills: finds a planted user skill, a project rule, and MCP servers', () => {
  const home = mkTmp();
  const projParent = mkTmp();
  try {
    // user-scope Claude skill (frontmatter extract)
    write(
      path.join(home, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: a planted skill for the test\n---\n\n# Demo\n\nbody\n',
    );
    // project-scope Cursor rule (frontmatter extract, *.mdc match)
    const proj = path.join(projParent, 'myproj');
    write(
      path.join(proj, '.cursor', 'rules', 'lint.mdc'),
      '---\nname: lint\ndescription: keep it tidy\nalwaysApply: false\n---\n\nrules go here\n',
    );
    // MCP servers (claude-cli-mcp -> ~/.claude.json)
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));

    const res = scanSkills({ home, projectRoots: [projParent] });

    const user = res.hosts.find((h) => h.id === 'claude-skills-user');
    assert.ok(user, 'user skill host not found');
    assert.equal(user.items[0].name, 'demo-skill');
    assert.equal(user.items[0].desc, 'a planted skill for the test');

    const cursor = res.hosts.find((h) => h.id === 'cursor-rules');
    assert.ok(cursor, 'cursor rule host not found');
    assert.equal(cursor.items[0].name, 'lint');

    const mcp = res.mcp.find((m) => m.id === 'claude-cli-mcp');
    assert.ok(mcp, 'mcp surface not found');
    assert.deepEqual(mcp.servers.sort(), ['alpha', 'beta']);

    assert.ok(res.stats.skills >= 2, `expected >=2 skills, got ${res.stats.skills}`);
    assert.equal(res.stats.projectsScanned, 1);
  } finally { rmTmp(home); rmTmp(projParent); }
});

test('scanSkills: empty machine yields empty inventory, never throws', () => {
  const home = mkTmp();
  try {
    const res = scanSkills({ home, projectRoots: [] });
    assert.deepEqual(res.hosts, []);
    assert.deepEqual(res.mcp, []);
    assert.equal(res.stats.skills, 0);
  } finally { rmTmp(home); }
});

test('scanSkills: a frontmatter host with no frontmatter falls back to the H1, does not crash', () => {
  const home = mkTmp();
  try {
    write(path.join(home, '.claude', 'skills', 'bare', 'SKILL.md'), '# Just A Heading\n\nno frontmatter here\n');
    const res = scanSkills({ home });
    const user = res.hosts.find((h) => h.id === 'claude-skills-user');
    assert.ok(user, 'host not found');
    assert.equal(user.items[0].name, 'Just A Heading');
    assert.equal(user.items[0].desc, null);
  } finally { rmTmp(home); }
});

// ── carrySkill (CARRY) ────────────────────────────────────────────────────────

const SKILL = '---\nname: seal\ndescription: sign seal deliver one piece of work\n---\n\n# /seal\n\nthe procedure\n';

test('carrySkill: Claude -> Cursor produces an .mdc with description + body', () => {
  const home = mkTmp();
  try {
    const src = path.join(home, '.claude', 'skills', 'seal', 'SKILL.md');
    write(src, SKILL);
    const out = carrySkill({ source: src, target: 'cursor', home });
    assert.equal(out.name, 'seal');
    assert.equal(out.target, 'cursor');
    assert.ok(out.suggestedPath.endsWith(path.join('.cursor', 'rules', 'seal.mdc')));
    assert.match(out.text, /description: sign seal deliver one piece of work/);
    assert.match(out.text, /the procedure/);
    assert.equal(out.clean, true, 'pure-prose skill should carry clean');
    assert.deepEqual(out.lossy, []);
  } finally { rmTmp(home); }
});

test('carrySkill: a skill with sibling helpers carries LOSSY + names them', () => {
  const home = mkTmp();
  try {
    const dir = path.join(home, '.claude', 'skills', 'handoff');
    write(path.join(dir, 'SKILL.md'), SKILL.replace('seal', 'handoff'));
    write(path.join(dir, 'snapshot.js'), '// helper\n');
    write(path.join(dir, 'validate.js'), '// helper\n');
    const out = carrySkill({ skillsDir: path.join(home, '.claude', 'skills'), name: 'handoff', target: 'agents', home });
    assert.equal(out.clean, false, 'skill with helpers must report lossy');
    assert.deepEqual(out.lossy.sort(), ['snapshot.js', 'validate.js']);
    assert.equal(out.suggestedPath, 'AGENTS.handoff.md');
  } finally { rmTmp(home); }
});

test('carrySkill: Claude round-trip is byte-identical + clean', () => {
  const home = mkTmp();
  try {
    const src = path.join(home, '.claude', 'skills', 'seal', 'SKILL.md');
    write(src, SKILL);
    fs.writeFileSync(path.join(path.dirname(src), 'extra.txt'), 'sibling'); // even WITH a sibling
    const out = carrySkill({ source: src, target: 'claude', home });
    assert.equal(out.text, SKILL, 'round-trip changed the bytes');
    assert.equal(out.clean, true, 'identity carry is always clean');
    assert.deepEqual(out.lossy, []);
  } finally { rmTmp(home); }
});

test('carrySkill: bad target + missing source throw', () => {
  const home = mkTmp();
  try {
    const src = path.join(home, '.claude', 'skills', 'seal', 'SKILL.md');
    write(src, SKILL);
    assert.throws(() => carrySkill({ source: src, target: 'notahost', home }), /unknown carry target/);
    assert.throws(() => carrySkill({ target: 'cursor', home }), /either \{ source \} or \{ name \}/);
    assert.throws(() => carrySkill({ source: path.join(home, 'nope', 'SKILL.md'), target: 'cursor', home }), /no skill SKILL\.md/);
  } finally { rmTmp(home); }
});
