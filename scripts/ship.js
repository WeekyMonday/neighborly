#!/usr/bin/env node
/**
 * Neighborly "ship" — commit + push in one shot.
 *
 * The live site (Render) is wired to auto-deploy every commit on `main`
 * (see render.yaml -> autoDeployTrigger: commit). So "shipping" is just:
 *
 *     stage  ->  bump PWA cache  ->  commit  ->  push  ->  live
 *
 * Usage:
 *     node scripts/ship.js                 # auto-generated commit message
 *     node scripts/ship.js "Fix login bug" # explicit message
 *     node scripts/ship.js --dry-run       # show what would happen
 *
 * Flags:
 *     NEIGHBORLY_NO_AUTOPUSH=1  skip the post-commit auto-push hook
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SW_FILE = path.join(ROOT, 'FRONTEND', 'www', 'sw.js');
const FRONTEND_DIR = path.join('FRONTEND', 'www');

const dryRun = process.argv.includes('--dry-run');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const message = args.join(' ').trim();

function git(...argv) {
  return execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSafe(...argv) {
  try {
    return { ok: true, out: git(...argv) };
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

function log(line = '') {
  process.stdout.write(line + '\n');
}

function autoMessage() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const files = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (!files.length) return `chore: sync ${branch}`;

  const areas = new Set();
  for (const f of files) {
    if (f.startsWith(FRONTEND_DIR)) areas.add('ui');
    else if (f.startsWith('BACKEND')) areas.add('server');
    else if (f.startsWith('tests')) areas.add('tests');
    else if (/\.(md)$/i.test(f)) areas.add('docs');
    else areas.add('chore');
  }
  const scope = [...areas].sort().join('+');
  const top = files
    .filter((f) => !/package-lock\.json$/.test(f))
    .slice(0, 2)
    .map((f) => f.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''))
    .join(', ');
  const extra = files.length > 2 ? ` (+${files.length - 2} more)` : '';
  return `${scope}: update ${top}${extra}`;
}

/**
 * The service worker precaches CSS/JS/HTML by CACHE_NAME. If we deploy new
 * assets without bumping it, returning users keep seeing the old site. Bump
 * automatically — but only when frontend files actually changed and the
 * author has not already bumped it by hand.
 */
function bumpServiceWorkerCache() {
  const changed = gitSafe('diff', '--cached', '--name-only').out
    .split('\n')
    .filter(Boolean);
  const frontendTouched = changed.some((f) => f.replace(/\\/g, '/').startsWith(FRONTEND_DIR));
  if (!frontendTouched) return null;

  const current = fs.readFileSync(SW_FILE, 'utf8');
  const head = gitSafe('show', 'HEAD:FRONTEND/www/sw.js');
  const match = current.match(/const CACHE_NAME = 'neighborly-v(\d+)'/);
  if (!match) return null;

  const version = Number(match[1]);
  const headMatch = head.ok ? head.out.match(/const CACHE_NAME = 'neighborly-v(\d+)'/) : null;
  if (headMatch && Number(headMatch[1]) === version) return null; // already bumped by hand

  const next = version + 1;
  const updated = current.replace(
    /const CACHE_NAME = 'neighborly-v\d+'/,
    `const CACHE_NAME = 'neighborly-v${next}'`
  );
  if (dryRun) return `neighborly-v${version} -> neighborly-v${next}`;
  fs.writeFileSync(SW_FILE, updated, 'utf8');
  git('add', 'FRONTEND/www/sw.js');
  return `neighborly-v${version} -> neighborly-v${next}`;
}

function main() {
  log('Neighborly ship');
  log('--------------');

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') {
    log(`! You are on "${branch}". Render only auto-deploys "main".`);
    log('  Push to main when ready:  git push origin HEAD:main');
  }

  git('add', '-A');

  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (!staged.length) {
    log('Nothing to ship — working tree is clean.');
    return;
  }
  log(`Staged ${staged.length} file(s):`);
  staged.forEach((f) => log(`  + ${f}`));

  const bump = bumpServiceWorkerCache();
  if (bump) log(`Bumped service worker cache: ${bump}`);

  const commitMessage = message || autoMessage();
  log(`Commit: ${commitMessage}`);

  if (dryRun) {
    log('');
    log('--dry-run: nothing was committed or pushed.');
    return;
  }

  git('commit', '-m', commitMessage);
  const sha = git('rev-parse', '--short', 'HEAD');
  log(`Committed ${sha}`);

  const pushed = gitSafe('push', 'origin', `HEAD:${branch}`);
  if (pushed.ok) {
    log(`Pushed to origin/${branch} — Render is auto-deploying now.`);
  } else {
    log('! Push failed (working tree is safe, commit is local):');
    log(pushed.out.split('\n').map((l) => `  ${l}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  log('');
  log('Live in a few minutes. Check the Render dashboard for build status.');
}

main();