#!/usr/bin/env node
// scripts/check-readme-version.js
//
// package.json `version` is the single source of truth. README.md carries its
// own `version:` in the frontmatter (npm renders the README as the package's
// public front page, and that field has drifted stale by hand twice --
// 753bbc5 caught it two releases late). This script fails CI when the two
// disagree instead of relying on someone noticing before a publish.
//
// Usage:
//   node scripts/check-readme-version.js

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkgFile = path.join(repoRoot, 'package.json');
const readmeFile = path.join(repoRoot, 'README.md');

const pkgVersion = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;

const readme = fs.readFileSync(readmeFile, 'utf8');
const lines = readme.split('\n').map((l) => l.replace(/\r$/, ''));
if (lines[0].trim() !== '---') {
  console.error('[check-readme-version] README.md has no leading frontmatter block');
  process.exit(2);
}
const end = lines.indexOf('---', 1);
if (end < 0) {
  console.error('[check-readme-version] README.md frontmatter is unterminated');
  process.exit(2);
}
const fmMatch = lines.slice(1, end).find((l) => l.startsWith('version:'));
if (!fmMatch) {
  console.error('[check-readme-version] README.md frontmatter has no version: field');
  process.exit(2);
}
const readmeVersion = fmMatch.slice('version:'.length).trim();

if (readmeVersion !== pkgVersion) {
  console.error(
    `[check-readme-version] DRIFT: package.json=${pkgVersion} README.md=${readmeVersion}`
  );
  console.error('[check-readme-version] update the README frontmatter version: field to match package.json');
  process.exit(1);
}

console.log(`[check-readme-version] OK: README.md matches package.json (${pkgVersion})`);
