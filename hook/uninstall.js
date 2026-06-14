#!/usr/bin/env node
'use strict';
/*
 * uninstall.js — remove the auto-effort UserPromptSubmit hook from a settings file.
 * Mirror of install.js scopes:
 *   node hook/uninstall.js --global
 *   node hook/uninstall.js --target <dir>
 *   node hook/uninstall.js --here
 * Leaves all other settings (and other hooks) untouched.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function usage(msg) {
  if (msg) console.error('error: ' + msg + '\n');
  console.error(`auto-effort uninstaller

Usage:
  node hook/uninstall.js --global
  node hook/uninstall.js --target <dir>
  node hook/uninstall.js --here`);
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
  if (args.scope === 'global') return path.join(os.homedir(), '.claude', 'settings.json');
  if (args.scope === 'project') {
    if (!args.dir) usage('--target requires a directory');
    return path.join(path.resolve(args.dir), '.claude', 'settings.json');
  }
  usage('a scope is required: --global, --target <dir>, or --here');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const settingsPath = settingsPathFor(args);

  if (!fs.existsSync(settingsPath)) {
    console.log('nothing to do — no settings file at ' + settingsPath);
    return;
  }
  let settings;
  try {
    const txt = fs.readFileSync(settingsPath, 'utf8').trim();
    settings = txt ? JSON.parse(txt) : {};
  } catch (e) {
    console.error('refusing to modify malformed JSON: ' + settingsPath + '\n  ' + e.message);
    process.exit(1);
  }

  const groups = settings.hooks && settings.hooks.UserPromptSubmit;
  if (!Array.isArray(groups)) {
    console.log('auto-effort hook not present in ' + settingsPath);
    return;
  }

  const before = groups.length;
  const kept = groups.filter((g) =>
    !(Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes('auto-effort.js')))
  );
  const removed = before - kept.length;

  if (removed === 0) {
    console.log('auto-effort hook not present in ' + settingsPath);
    return;
  }

  if (kept.length > 0) settings.hooks.UserPromptSubmit = kept;
  else {
    delete settings.hooks.UserPromptSubmit;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('removed ' + removed + ' auto-effort hook entr' + (removed === 1 ? 'y' : 'ies') + ' from ' + settingsPath);
  console.log('(hook/config.json, capability.json and logs are left in place — delete the folder to remove them.)');
}

main();
