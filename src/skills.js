'use strict';
// @mediagato/elifant :: the polyglot-skills layer (v0.10.0).
//
// "Native everywhere, proprietary nowhere." The substrate ships no walled skill
// format; it is fluent in every vendor's, because it knows where each host keeps
// them. This module folds the two read-side verbs over a host-map registry:
//
//   loadSkillRegistry(opts) -> the per-host location + format map
//   scanSkills(opts)        -> READ: inventory every skill on a machine
//   carrySkill(opts)        -> CARRY: translate a skill into another host's dialect
//
// The "use" verb has no code here: once a carried skill sits in a host's slot,
// that host runs it natively. We borrow the runtime, then own it.
//
// The map's canonical, community-maintainable home is the elifantic spec
// (spec/skills-registry.json, MIT). This kernel VENDORS a snapshot
// (./skills-registry.json) so a core substrate capability never depends on
// fetching cloud infra — ours or a vendor's — at runtime. A caller-supplied map
// always wins over the snapshot.
//
// Pure Node stdlib (fs/path/os). No deps, no cloud.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VENDORED_REGISTRY = path.join(__dirname, 'skills-registry.json');

// ── helpers ─────────────────────────────────────────────────────────────────

function _read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function _isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function _isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Expand a registry path: `~` -> home, normalize separators for this OS.
function _expand(p, home) {
  return p.replace(/^~/, home).split(/[\\/]/).join(path.sep);
}

// Pull a {name, description} out of a matched file per the host's extract rule.
function _frontmatter(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : '';
  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1];
  const desc = (fm.match(/^description:\s*["']?(.+?)["']?\s*$/m) || [])[1];
  return { name: name && name.trim(), desc: desc && desc.trim() };
}
function _h1(txt) {
  const m = txt.match(/^#\s+(.+)$/m);
  return { name: m ? m[1].trim() : null, desc: null };
}
function _describe(host, file) {
  const txt = _read(file);
  if (host.extract === 'frontmatter') {
    if (txt.startsWith('---')) { const r = _frontmatter(txt); if (r.name) return r; }
    return _h1(txt); // a frontmatter host whose file has none — fall back to the H1
  }
  if (host.extract === 'h1') return _h1(txt);
  return { name: path.basename(file), desc: null }; // 'filename'
}

// Resolve a host's concrete location relative to a base dir (home for user
// scope, a project root for project scope). `~`-rooted/absolute paths are used
// as-is; relative paths join onto the base. Don't double-join the home dir.
function _locate(host, baseDir, home) {
  const expanded = host.path === '.' ? '' : _expand(host.path, home);
  return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded || '.');
}

// ── loadSkillRegistry ─────────────────────────────────────────────────────────

/**
 * Resolve the host-map registry. Precedence:
 *   1. opts.registry      — a registry object supplied by the caller (wins)
 *   2. opts.registryPath  — a path to a registry JSON file
 *   3. the vendored snapshot (./skills-registry.json)
 *
 * @param {{registry?: object, registryPath?: string}} [opts]
 * @returns {object} the registry { version, hosts[], mcp[], ... }
 */
function loadSkillRegistry(opts = {}) {
  if (opts.registry && typeof opts.registry === 'object') return opts.registry;
  const src = opts.registryPath || VENDORED_REGISTRY;
  const raw = _read(src);
  if (!raw) throw new Error(`skills registry not readable: ${src}`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`skills registry is not valid JSON (${src}): ${e.message}`);
  }
}

// ── scanSkills (the READ verb) ────────────────────────────────────────────────

/**
 * Inventory every skill on this machine across every host in the registry.
 * Sovereign: pure filesystem reads, zero network.
 *
 * `projectRoots` is LOCAL config (which dirs on this box are project roots),
 * never part of the shared map — supply it here. Each given root is scanned one
 * level deep for project-scope hosts; user-scope hosts resolve under `home`.
 *
 * @param {{
 *   registry?: object, registryPath?: string,
 *   projectRoots?: string[],   // local: dirs whose immediate children are projects
 *   home?: string              // override $HOME (testing)
 * }} [opts]
 * @returns {{
 *   hosts: {id:string,label:string,format:string,items:{name:string,desc:?string,path:string}[]}[],
 *   mcp:   {id:string,label:string,servers:string[]}[],
 *   stats: {skills:number, hostsHit:number, projectsScanned:number}
 * }}
 */
function scanSkills(opts = {}) {
  const reg = loadSkillRegistry(opts);
  const home = opts.home || os.homedir();

  // Expand the local project_roots into concrete project dirs (one level deep).
  const projects = [];
  for (const r of opts.projectRoots || []) {
    const rp = _expand(r, home);
    if (_isDir(rp)) {
      for (const d of fs.readdirSync(rp)) {
        const full = path.join(rp, d);
        if (_isDir(full)) projects.push(full);
      }
    }
  }

  const found = {}; // hostId -> items[]
  const push = (id, item) => { (found[id] || (found[id] = [])).push(item); };

  const matchAt = (host, baseDir) => {
    const loc = _locate(host, baseDir, home);
    if (host.match === 'dir/SKILL.md') {
      if (!_isDir(loc)) return;
      for (const d of fs.readdirSync(loc)) {
        const f = path.join(loc, d, 'SKILL.md');
        if (_isFile(f)) push(host.id, Object.assign(_describe(host, f), { path: f }));
      }
    } else if (host.match.startsWith('*.')) {
      if (!_isDir(loc)) return;
      const ext = host.match.slice(1);
      for (const f of fs.readdirSync(loc)) {
        if (f.endsWith(ext)) {
          const full = path.join(loc, f);
          push(host.id, Object.assign(_describe(host, full), { path: full }));
        }
      }
    } else {
      const f = path.join(loc, host.match);
      if (_isFile(f)) push(host.id, Object.assign(_describe(host, f), { path: f }));
    }
  };

  for (const host of reg.hosts || []) {
    if (host.scope === 'user') matchAt(host, home);
    else for (const proj of projects) matchAt(host, proj);
  }

  // MCP capability surfaces — configs, not skills, but the wire home for power.
  const mcp = [];
  for (const m of reg.mcp || []) {
    const raw = m.paths ? m.paths[process.platform] : m.path;
    if (!raw) continue;
    const p = _expand(raw, home);
    if (!_isFile(p)) continue;
    try {
      const cfg = JSON.parse(_read(p));
      const servers = Object.keys(cfg[m.key] || {});
      if (servers.length) mcp.push({ id: m.id, label: m.label, servers });
    } catch { /* unreadable/!json config — skip, never throw */ }
  }

  const hosts = (reg.hosts || [])
    .map((h) => ({ id: h.id, label: h.label, format: h.format, items: found[h.id] || [] }))
    .filter((h) => h.items.length);

  const skills = hosts.reduce((n, h) => n + h.items.length, 0);
  return {
    hosts,
    mcp,
    stats: { skills, hostsHit: hosts.length, projectsScanned: projects.length },
  };
}

// ── carrySkill (the CARRY verb) ───────────────────────────────────────────────

const _CARRY_TARGETS = ['cursor', 'agents', 'claude'];

/**
 * Translate a skill from Claude's SKILL.md dialect into another host's. Honest +
 * best-effort: it returns the translated text and NAMES what can't survive the
 * trip (bundled scripts a flat rules file can't hold). It does NOT write to disk
 * — the caller owns placement (library-clean; the kernel imposes no `out/`).
 *
 * Provide the source either directly (`source`: path to a SKILL.md) or by name
 * (`skillsDir` + `name`, defaulting skillsDir to ~/.claude/skills).
 *
 * @param {{
 *   source?: string,           // path to a Claude SKILL.md
 *   skillsDir?: string,        // dir holding <name>/SKILL.md (default ~/.claude/skills)
 *   name?: string,             // skill dir name (with skillsDir)
 *   target: 'cursor'|'agents'|'claude',
 *   home?: string
 * }} opts
 * @returns {{
 *   name:string, target:string,
 *   suggestedPath:string,      // relative path a caller MAY write to
 *   text:string,
 *   lossy:string[],            // sibling files that don't survive the trip
 *   clean:boolean              // true = pure prose, nothing lost
 * }}
 */
function carrySkill(opts = {}) {
  const target = opts.target;
  if (!_CARRY_TARGETS.includes(target)) {
    throw new Error(`unknown carry target '${target}' (${_CARRY_TARGETS.join('|')})`);
  }
  const home = opts.home || os.homedir();

  let srcFile;
  let skillDirName;
  if (opts.source) {
    srcFile = _expand(opts.source, home);
    skillDirName = path.basename(path.dirname(srcFile));
  } else {
    if (!opts.name) throw new Error('carrySkill needs either { source } or { name }');
    const skillsDir = _expand(opts.skillsDir || '~/.claude/skills', home);
    skillDirName = opts.name;
    srcFile = path.join(skillsDir, opts.name, 'SKILL.md');
  }
  if (!_isFile(srcFile)) throw new Error(`no skill SKILL.md at ${srcFile}`);

  const raw = _read(srcFile);
  const fm = (raw.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const name = (fm.match(/^name:\s*(.+)$/m) || [, skillDirName])[1].trim();
  const desc = (fm.match(/^description:\s*["']?([\s\S]+?)["']?\s*$/m) || [, ''])[1]
    .trim().replace(/\s+/g, ' ');

  // Lossiness: sibling files (scripts/resources) a flat target can't carry.
  const srcDir = path.dirname(srcFile);
  let extras = [];
  try { extras = fs.readdirSync(srcDir).filter((f) => f !== 'SKILL.md'); } catch { /* ignore */ }

  let suggestedPath;
  let text;
  if (target === 'cursor') {
    suggestedPath = path.join('.cursor', 'rules', `${name}.mdc`);
    text = `---\ndescription: ${desc}\nglobs:\nalwaysApply: false\n---\n\n# ${name}\n\n` +
      `> Carried from a Claude skill by @mediagato/elifant. Invoke when the task matches the description above.\n\n` +
      `${body}\n`;
  } else if (target === 'agents') {
    suggestedPath = `AGENTS.${name}.md`;
    text = `## ${name}\n\n_Carried from a Claude skill by @mediagato/elifant. Trigger: \`${name}\`._\n\n` +
      `${desc}\n\n${body}\n`;
  } else { // claude — round-trip identity
    suggestedPath = path.join(skillDirName, 'SKILL.md');
    text = raw;
  }

  // A claude round-trip carries everything; a flat target drops sibling helpers.
  const clean = target === 'claude' || extras.length === 0;
  const lossy = target === 'claude' ? [] : extras;
  return { name, target, suggestedPath, text, lossy, clean };
}

module.exports = { loadSkillRegistry, scanSkills, carrySkill, VENDORED_REGISTRY };
