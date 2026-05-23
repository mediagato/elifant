#!/bin/bash
# Install package dependencies for Claude Code cloud sessions
# (including /ultrareview cloud reviews).
#
# Local Claude Code sessions skip this — local dev manages deps manually.
# Detection: CLAUDE_CODE_REMOTE=true is set in cloud sandboxes only.
#
# Idempotent: npm ci uses package-lock.json and is safe to re-run.
# Total runtime budget per the docs is ~5 minutes; npm ci on the brain
# (single dependency: @electric-sql/pglite) is well under that.
#
# Exit 0 on success or skip; non-zero would block the session from starting.

set -e

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
    # Local session — no-op. Skip so this doesn't fire on every laptop session.
    exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
echo "[install_pkgs] running npm ci in cloud sandbox..."
npm ci
echo "[install_pkgs] dependencies installed."
exit 0
