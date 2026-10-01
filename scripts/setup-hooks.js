#!/usr/bin/env node
/**
 * Installs the git hooks that keep the live site in sync.
 *
 * Post-commit -> push to origin, so Render auto-deploys without anyone
 * having to remember a "deploy" step.
 *
 * Re-runnable and idempotent. Hooks live in .git/hooks (not committed), so
 * run `npm run setup` once per fresh clone. `npm run ship` does it for you.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GIT_DIR = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
const HOOKS_DIR = path.join(GIT_DIR, 'hooks');
const MARKER = '# neighborly-autopush';

const HOOKS = {
  'post-commit': [
    '#!/bin/sh',
    MARKER,
    '# Auto-push every commit to origin so Render redeploys the live site.',
    '# Disable:  NEIGHBORLY_NO_AUTOPUSH=1 git commit ...   (or delete this file)',
    'if [ -n "$NEIGHBORLY_NO_AUTOPUSH" ]; then exit 0; fi',
    '',
    '# Never push mid rebase / merge / cherry-pick.',
    'git_dir=$(git rev-parse --git-dir)',
    'for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do',
    '  [ -e "$git_dir/$marker" ] && exit 0',
    'done',
    '',
    'branch=$(git rev-parse --abbrev-ref HEAD)',
    '[ "$branch" = "main" ] || exit 0',
    '',
    'echo "neighborly: auto-pushing $branch (set NEIGHBORLY_NO_AUTOPUSH=1 to skip)"',
    'git push origin "HEAD:$branch" || echo "neighborly: auto-push failed - run: git push"',
    'exit 0',
    '',
  ].join('\n'),
};

function main() {
  if (!fs.existsSync(HOOKS_DIR)) {
    console.error(`No git hooks directory at ${HOOKS_DIR}. Is this a git repo?`);
    process.exitCode = 1;
    return;
  }

  for (const [name, body] of Object.entries(HOOKS)) {
    const file = path.join(HOOKS_DIR, name);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing.includes(MARKER) && existing === body) {
      console.log(`= ${name} already up to date`);
      continue;
    }
    if (existing && !existing.includes(MARKER) && fs.statSync(file).size > 0) {
      // Preserve someone else's hook by chaining instead of overwriting.
      const backup = `${file}.neighborly-backup`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      fs.writeFileSync(file, `#!${'\n'}/bin/sh\n${body}\n# --- previous contents (also at ${backup}) ---\n${existing}`, {
        mode: 0o755,
      });
      console.log(`~ ${name} updated (previous hook chained, backup at ${backup})`);
      continue;
    }
    fs.writeFileSync(file, body, { mode: 0o755 });
    console.log(`+ ${name} installed`);
  }

  console.log('');
  console.log('Auto-deploy pipeline ready:  git commit  ->  push  ->  Render redeploys.');
}

main();