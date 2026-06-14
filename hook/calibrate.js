#!/usr/bin/env node
'use strict';
/*
 * calibrate.js — detect the effort capabilities of the INSTALLED Claude Code.
 *
 * Two things change across Claude Code versions and can't be assumed:
 *   1. Which effort level NAMES exist (cheap: parse the `--effort` warning).
 *   2. The highest level the `effortLevel` SETTINGS key actually HONORS.
 *      Settings silently drops session-only levels (today: `max`, `ultracode`)
 *      with no error, so the only way to know is to BEHAVIORALLY probe: set a
 *      level via settings, run a reasoning prompt, and see if reasoning scales
 *      up like the real thing (the `--effort` flag, which honors every level).
 *
 * Output: capability.json next to this file. Re-run after Claude Code updates
 * (the hook detects an update for free via the binary fingerprint and asks for
 * a re-run). The behavioral probe uses opus — haiku's token usage does not
 * track effort monotonically, so it can't be calibrated against.
 *
 * Usage:  node calibrate.js            (uses opus for the behavioral probe)
 *         node calibrate.js --quick    (skip behavioral probe; names + fingerprint only)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const LEVEL_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']; // canonical low -> high
const PROBE_PROMPT =
  "How many times do a clock's hour and minute hands overlap in exactly 24 hours, and at what times? Work it out.";
const PROBE_MODEL = 'opus';
const QUICK = process.argv.includes('--quick');

function loadConfig() {
  try {
    const p = path.join(HERE, 'config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* fall through */ }
  return {};
}

function resolveBin(cfg) {
  const p = cfg.claudePath;
  if (p && p !== 'claude' && fs.existsSync(p)) return { bin: p, shell: false };
  return { bin: 'claude', shell: true }; // PATH resolution needs a shell
}

function fingerprint(bin) {
  try { const st = fs.statSync(bin); return { mtimeMs: Math.round(st.mtimeMs), size: st.size }; }
  catch { return null; }
}

function run(bin, shell, args, input, timeoutMs) {
  return spawnSync(bin, args, {
    input, encoding: 'utf8', shell, windowsHide: true,
    timeout: timeoutMs || 200000, maxBuffer: 1 << 26,
    env: { ...process.env, AUTO_EFFORT_CLASSIFYING: '1' }, // never trigger the hook
  });
}

function getVersion(bin, shell) {
  const r = run(bin, shell, ['--version'], '', 20000);
  const m = String(r.stdout || '').match(/[\d.]+/);
  return m ? m[0] : 'unknown';
}

// Parse "Valid values: low, medium, high, xhigh, max." from the --effort warning.
function detectValidLevels(bin, shell) {
  const r = run(bin, shell, ['-p', '--model', 'haiku', '--effort', '__detect__'], 'hi', 60000);
  const text = String(r.stderr || '') + String(r.stdout || '');
  const m = text.match(/valid values?:\s*([a-z0-9, ]+)/i);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/\.$/, '')).filter(Boolean);
}

// output_tokens for the reasoning prompt under a given effort config.
function probeTokens(bin, shell, mode, level) {
  const args = ['-p', '--output-format', 'json', '--model', PROBE_MODEL];
  if (mode === 'flag') args.push('--effort', level);
  else args.push('--settings', JSON.stringify({ effortLevel: level }));
  const r = run(bin, shell, args, PROBE_PROMPT, 240000);
  try { const j = JSON.parse(r.stdout); return (j.usage && j.usage.output_tokens) || null; }
  catch { return null; }
}

function main() {
  const cfg = loadConfig();
  const { bin, shell } = resolveBin(cfg);
  console.log(`[calibrate] claude = ${bin} (shell=${shell})`);

  const fp = fingerprint(bin);
  const version = getVersion(bin, shell);
  console.log(`[calibrate] version = ${version}, fingerprint = ${fp ? fp.mtimeMs + ':' + fp.size : 'n/a'}`);

  const detected = detectValidLevels(bin, shell);
  const validLevels = detected || LEVEL_ORDER.slice();
  const orderedValid = LEVEL_ORDER.filter(l => validLevels.includes(l));
  console.log(`[calibrate] valid effort levels: ${validLevels.join(', ')}${detected ? '' : '  (fallback — warning not parsed)'}`);

  const top = orderedValid[orderedValid.length - 1];           // e.g. "max"
  const belowTop = orderedValid[orderedValid.length - 2] || top; // e.g. "xhigh"

  let settingsCeiling = belowTop; // conservative default: top is session-only
  let probe = null;

  if (QUICK) {
    console.log('[calibrate] --quick: skipping behavioral probe; assuming top level is session-only.');
  } else {
    console.log(`[calibrate] behavioral probe on ${PROBE_MODEL} (3 calls, ~1-2 min)...`);
    const B = probeTokens(bin, shell, 'flag', 'low');   // baseline
    const R = probeTokens(bin, shell, 'flag', top);     // real top via flag
    const S = probeTokens(bin, shell, 'settings', top); // top via settings
    probe = { baseline_low: B, flag_top: R, settings_top: S, top, model: PROBE_MODEL };
    console.log(`[calibrate] tokens — low=${B}, flag ${top}=${R}, settings ${top}=${S}`);

    if (B && R && S && R > B * 1.4) {
      // settings honors `top` if its reasoning scaled at least halfway to the real thing
      const honored = S >= B + 0.5 * (R - B);
      settingsCeiling = honored ? top : belowTop;
      console.log(`[calibrate] settings ${honored ? 'HONORS' : 'DROPS'} "${top}" -> ceiling = ${settingsCeiling}`);
    } else {
      console.log(`[calibrate] probe inconclusive (low/top not separable) -> conservative ceiling = ${settingsCeiling}`);
      probe.inconclusive = true;
    }
  }

  const out = {
    version, fingerprint: fp, validLevels, orderedValid,
    settingsCeiling, sessionOnlyDetected: settingsCeiling === top ? [] : orderedValid.slice(orderedValid.indexOf(settingsCeiling) + 1),
    probe, calibratedAtEpochMs: Date.now(),
  };
  const outPath = path.join(HERE, 'capability.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`[calibrate] wrote ${outPath}`);
  console.log(`[calibrate] => settings effortLevel ceiling = "${settingsCeiling}"`);
}

main();
