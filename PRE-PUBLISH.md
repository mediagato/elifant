---
name: elifant-pre-publish-flags
type: internal
status: active
summary: Leak-risk flag record for the elifant kernel — reviewed 2026-07-02. NOT for public flatten (strip before any public mirror / npm-adjacent doc set). No content scrubbed this round; this is the watch-list for the eventual pre-reveal scrub.
updated: 2026-07-02
---

# Pre-publish flags — elifant kernel

**Reviewed 2026-07-02 (claude-carbug).** Round goal was to FLAG, not scrub — nothing
below was removed. This file is `type: internal`; `check-frontmatter.ps1 -Public` should
drop it, and it is outside the npm `files` whitelist (`src/`, `README.md`, `LICENSE`) so it
never ships to npm. Keep it out of any public repo-flatten.

## Verdict: the shipping npm tarball is CLEAN

The published tarball is 8 files — `LICENSE`, `README.md`, `package.json`, `src/index.js`,
`src/index.d.ts`, `src/skills.js`, `src/skills-registry.json`, `src/tar.js`. Verified clean
three ways on 2026-07-02:

- **grep sweep** (LAN IPs, offsite IPs, fleet hostnames, the internal GitLab hostname,
  secret patterns, family/person names, internal paths, internal codenames): **0 real
  hits**. The
  only pattern matches were false positives — `holly` inside "w**holly**" (index.js:1855),
  `sk-full` inside "di**sk-full**" (index.js:2275) — and the intentional, doctrine-allowed
  author line `Steve Kingsley <steve@mediagato.com>` (package.json:23).
- **audit-substrate guard** (`audit-substrate.ps1 -Strict -Repo elifant`): **0 hits, 0
  critical**. The kernel already has an entry in `tools/audit-substrate-config.json`.
- **full deep-read** of all 5 shipping source files (index.js read in full, ~2753 lines):
  no personal/family/client data, no infra, no secrets, no internal codenames, no internal
  absolute paths. The producer `host` field is redacted-by-default (index.js:~1329) and
  test keypairs are generated ephemerally (`generateKeyPairSync`) — no key material is a
  literal in source. `test/yoink.test.js:297-298` `BEGIN PRIVATE KEY` is a **guardrail
  assertion** that the signing key must NOT leak into a tarball — the opposite of a leak.

## Flags (things to handle BEFORE any public reveal)

### FLAG-1 — `WATERING-HOLE-DESIGN.md` is loose in the repo and guard-blind — LOW/MEDIUM
Untracked (~12.8KB, dated 2026-06-24) design RFC for the sync relay. Not committed, so a
normal push won't include it — but a careless `git add -A` before a public flatten would,
and the audit-substrate guard only scans tracked files, so it does **not** cover this file.
Its leak content is mild (no IPs, no secrets, no family names): repo-relative paths
`brain/app.py` and `Secrets/brain-sync.js`, and the planned relay hostname
`watering.mrmags.org` (not yet live). **Action at publish:** keep it untracked, move it to
an internal-only docs location, or `.gitignore` it — never let it into a public flatten.

### FLAG-2 — RESOLVED 2026-07-02: crypto-04 signing-key-at-rest closed (opt-in encrypt-at-rest)
Was: shipping comments documented the Ed25519 signing key stored plaintext at rest (a
still-open weakness, crypto-04). **Fixed in 0.20.0:** when a keyholder passphrase is
configured (`init(dir, {keyPassphrase})` or `ELIFANT_KEY_PASSPHRASE`), the private key is
AES-256-GCM sealed under a PBKDF2-600k KEK and never written in clear (born-sealed brains
are airtight — proven by a dump-scan test; fork + migration paths seal too; wrong/missing
passphrase fails loud; private↔public integrity checked on open). Default (no passphrase)
stays plaintext for backward-compat, now honestly reported by `signingKeyProtection()` +
HEALTH rather than only a buried comment. The stale "plaintext at rest" comments were
updated to the truth. Residual (documented, not a leak): migrating an EXISTING plaintext
key can't scrub prior plaintext from WAL/backups — born-sealed is the hard guarantee.
Update `elifantic/spec/audit-2026-06-10-kernel-daemon-security.md` crypto-04 status from
DEFERRED to RESOLVED when convenient.

### FLAG-3 — guard coverage gaps to remember at publish time — INFO
`audit-substrate.ps1` passed clean, but note its scope: it scans **tracked files only**
(FLAG-1's untracked doc is invisible to it) and `test/` is in `allowed_paths_extra`
(exempted). Tests were manually verified clean today, but the guard will not catch a
**future** test fixture that embeds real data, nor any untracked file. **Action:** re-run
the guard before publish AND manually eyeball untracked files + any new test fixtures.

## Not flagged (confirmed fine)
- `package.json:23` author line — Steve Kingsley / MEDiAGATO, doctrine-allowed.
- `.gitignore` correctly excludes `brain/`, `.env`, `.env.*` — no brain DB or env leak.
- `.claude/settings.json` (tracked) — only a SessionStart hook running `install_pkgs.sh`
  (`npm ci` in cloud sandboxes); no token, IP, or secret.
- Internal audit tags in source (`audit-2026-06-10`, `bug_009`, `crypto-01`, `tar-01`) —
  reveal only that the project runs security audits; harmless.
- README is thin (frontmatter-only, 542B) — a docs-quality issue, NOT a leak; out of scope
  for this round.
