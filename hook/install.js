#!/usr/bin/env node
'use strict';
/*
 * install.js — wire the auto-effort UserPromptSubmit hook into Claude Code.
 *
 *   node hook/install.js --global              # all sessions (~/.claude/settings.json)
 *   node hook/install.js --target /path/proj   # one project (<proj>/.claude/settings.json)
 *   node hook/install.js --here                # the current directory as the project
 *
 * A scope is REQUIRED on purpose: the hook runs a ~5s classifier on every
 * prompt, so installing it globally is a real choice, not a default.
 *
 * What it does: detects the `claude` binary, writes hook/config.json with that
 * path, and merges the hook into the chosen settings file without touching any
 * other keys. Re-running is safe (idempotent).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const HOOK_SCRIPT = path.resolve(HERE, 'auto-effort.js').replace(/\\/g, '/');
const HOOK_TIMEOUT = 25; // seconds; > the internal classifier timeout (12s)

function usage(msg) {
  if (msg) console.error('error: ' + msg + '\n');
  console.error(`auto-effort installer

Usage:
  node hook/install.js --global             Install for ALL Claude Code sessions
  node hook/install.js --target <dir>       Install for one project directory
  node hook/install.js --here               Install for the current directory

Notes:
  - The hook runs a ~5s Haiku classifier on every prompt. --global applies that
    everywhere; prefer --target for a single project while trying it out.
  - Re-running is safe. Use uninstall.js to remove it.`);
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const a = { scope: null, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--global') a.scope = 'global';
    else if (x === '--here') { a.scope = 'project'; a.dir = process.cwd(); }
    else if (x === '--target') { a.scope = 'project'; a.dir = argv[++i]; }
    else if (x === '-h' || x === '--help') usage();
    else usage('unknown argument: ' + x);
  }
  return a;
}

function settingsPathFor(args) {
  if (args.scope === 'global') {
    return path.join(os.homedir(), '.claude', 'settings.json');
  }
  if (args.scope === 'project') {
    if (!args.dir) usage('--target requires a directory');
    return path.join(path.resolve(args.dir), '.claude', 'settings.json');
  }
  usage('a scope is required: --global, --target <dir>, or --here');
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const txt = fs.readFileSync(file, 'utf8').trim();
  return txt ? JSON.parse(txt) : {};
}

function detectClaude() {
  const isWin = process.platform === 'win32';
  const candidates = [];
  try {
    const r = spawnSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      candidates.push(...r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    }
  } catch { /* ignore */ }
  const home = os.homedir();
  if (home) candidates.push(path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude'));
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c.replace(/\\/g, '/'); } catch { /* ignore */ }
  }
  return null;
}

function writeConfig() {
  const cfgPath = path.join(HERE, 'config.json');
  const examplePath = path.join(HERE, 'config.example.json');
  let cfg = {};
  try { cfg = readJson(fs.existsSync(cfgPath) ? cfgPath : examplePath); }
  catch (e) { console.warn('! could not read existing config, starting from defaults: ' + e.message); }
  const claude = detectClaude();
  cfg.claudePath = claude || 'claude';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return { cfgPath, claude };
}

function installHook(settingsPath) {
  let settings;
  try { settings = readJson(settingsPath); }
  catch (e) {
    console.error('refusing to modify malformed JSON: ' + settingsPath + '\n  ' + e.message);
    process.exit(1);
  }
  settings.hooks = settings.hooks || {};
  const groups = settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
  const command = `node "${HOOK_SCRIPT}"`;

  const already = groups.some((g) =>
    Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes('auto-effort.js'))
  );
  if (already) return { changed: false, command };

  groups.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { changed: true, command };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const settingsPath = settingsPathFor(args);

  const { claude } = writeConfig();
  const { changed, command } = installHook(settingsPath);

  console.log('\nauto-effort installed' + (changed ? '' : ' (already present)'));
  console.log('  scope        : ' + args.scope + (args.dir ? ' (' + args.dir + ')' : ''));
  console.log('  settings     : ' + settingsPath);
  console.log('  hook command : ' + command);
  console.log('  claude binary: ' + (claude || 'NOT FOUND — falling back to PATH ("claude"); set claudePath in hook/config.json if needed'));
  console.log('\nNext steps:');
  console.log('  1) (optional) node hook/calibrate.js   # detect the effort ceiling (~2 min, uses opus)');
  console.log('  2) Restart Claude Code (or open a new session) to load the hook.');
  console.log('  3) Submit a prompt — you should see "🧠 auto-effort → <level>".');
  console.log('\nRemove with:  node hook/uninstall.js ' + (args.scope === 'global' ? '--global' : '--target ' + (args.dir || '<dir>')));
}

main();
