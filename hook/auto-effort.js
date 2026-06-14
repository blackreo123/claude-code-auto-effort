#!/usr/bin/env node
'use strict';
/*
 * auto-effort — a UserPromptSubmit hook for Claude Code.
 *
 * For every prompt you submit, this hook asks a fast model
 * (`claude -p --model haiku`) how much reasoning effort the request warrants,
 * then injects a calibrated "think this hard" directive into that turn's
 * context. The top tier includes the `ultrathink` keyword.
 *
 * Design rules:
 *   - FAIL OPEN. Any error, timeout, or unparseable result lets the prompt
 *     through untouched. This hook must never block or break your workflow.
 *   - NO RECURSION. The classifier itself runs `claude`, which could re-trigger
 *     this hook; the AUTO_EFFORT_CLASSIFYING env marker short-circuits that.
 *   - STDOUT IS THE CONTRACT. Only the final JSON goes to stdout; everything
 *     else (diagnostics) goes to the log file.
 *
 * Note: Claude Code does not let a hook flip the session `/effort` setting.
 * This injects a per-turn reasoning directive instead — which auto-resets each
 * prompt, so it is genuinely per-prompt rather than sticky.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;

// ---- defaults (any subset overridable via config.json beside this file) ----
const DEFAULTS = {
  model: 'haiku',           // fast/cheap classifier model
  timeoutMs: 12000,         // internal classifier timeout (keep < hook timeout)
  maxPromptChars: 4000,     // truncate long prompts before classifying
  minPromptChars: 1,        // skip empty prompts
  skipSlashCommands: true,  // don't classify /clear, /effort, etc.
  showSystemMessage: true,  // surface the chosen tier to you
  log: true,                // append one JSON line per decision to auto-effort.log
  claudePath: 'claude',     // claude executable; absolute path => clean kill, no shell
  classifierEffort: 'low',  // run the classifier cheaply (it only emits one word)

  // --- the two ways this hook can act on a classification ---
  injectDirective: true,    // same-turn (reliable): inject a "think this hard" directive
  writeEffortLevel: true,   // also set the REAL session effort by writing effortLevel to
                            // .claude/settings.local.json, which Claude Code hot-reloads.
  // tier -> DESIRED settings effortLevel. The result is clamped to the detected
  // ceiling (capability.json from calibrate.js); without it, to safeCeiling. So
  // `max` auto-lifts from xhigh to max if a future Claude Code honors it in settings.
  effortFor: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  safeCeiling: 'xhigh',     // fallback settings ceiling when capability.json is missing/stale
  settingsLocalPath: null,  // null => <CLAUDE_PROJECT_DIR or cwd>/.claude/settings.local.json

  // Tier labels map to the directive injected into the turn's context.
  tiers: {
    low: {
      label: 'low',
      directive:
        'This request looks trivial or mechanical. Optimize for speed: answer ' +
        'or act directly and concisely, without extended deliberation, ' +
        'exhaustive exploration, or weighing alternatives — unless you notice ' +
        'something genuinely off, in which case escalate your care.',
    },
    medium: {
      label: 'medium',
      directive:
        'This is a moderate task. Think briefly about the right approach, then ' +
        'proceed. Cover the obvious edge cases, but do not over-engineer or ' +
        'over-explain.',
    },
    high: {
      label: 'high',
      directive:
        'This is a non-trivial task. Reason carefully before acting: verify ' +
        'assumptions against the actual code, consider edge cases and failure ' +
        'modes, and check your work for correctness before finishing.',
    },
    max: {
      label: 'max',
      // `ultrathink` leads the string on purpose: it is the one documented
      // per-turn escalation keyword, and the surrounding prose is the reliable
      // steer if the keyword path does not fire through injected context.
      directive:
        'ultrathink — This is a hard task that demands deep, systematic ' +
        'reasoning. Before acting: map the problem space, consider multiple ' +
        'approaches and their trade-offs, enumerate edge cases and failure ' +
        'modes, verify every assumption against the real code, and double-check ' +
        'your reasoning. Prioritize correctness and completeness over speed.',
    },
  },

  // {TIERS} and {PROMPT} are substituted before sending to the classifier.
  classifierInstruction:
    'You are an effort-level classifier for an AI coding assistant. Read the ' +
    'USER REQUEST below and decide how much reasoning effort the assistant ' +
    'should spend on it. Reply with EXACTLY ONE lowercase word from this set ' +
    'and NOTHING else: {TIERS}.\n\n' +
    'Calibration:\n' +
    '- low: trivial/mechanical — rename, reformat, list files, a one-line edit, ' +
    'a simple factual lookup, "what does this do".\n' +
    '- medium: a localized change or single-file edit; a straightforward ' +
    'question that needs a little thought.\n' +
    '- high: multi-file changes, debugging, "why is X happening", implementing a ' +
    'feature, a refactor, comparing trade-offs.\n' +
    '- max: architecture/system design, subtle concurrency/security/data bugs, ' +
    'large or cross-cutting refactors, deep root-cause investigations — anything ' +
    'needing careful multi-step reasoning.\n' +
    'When genuinely torn between two tiers, pick the higher one.\n\n' +
    'USER REQUEST:\n<<<\n{PROMPT}\n>>>\n\n' +
    'Answer with one word ({TIERS}):',
};

function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(over)) return over.slice();
  if (typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) {
      const b = base ? base[k] : undefined;
      out[k] = (b && typeof b === 'object' && over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
        ? deepMerge(b, over[k])
        : over[k];
    }
    return out;
  }
  return over;
}

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const cfgPath = path.join(HERE, 'config.json');
  try {
    if (fs.existsSync(cfgPath)) {
      return deepMerge(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
    }
  } catch (e) {
    cfg._configError = String(e && e.message ? e.message : e);
  }
  return cfg;
}

const LEVEL_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']; // canonical low -> high

// The highest effort level the settings `effortLevel` key actually honors, as
// detected by calibrate.js (capability.json). Falls back to safeCeiling when the
// cache is missing, or when the claude binary changed since calibration (an
// update may have shifted what settings honors — re-run calibrate.js).
function loadCapability(cfg) {
  const safe = cfg.safeCeiling || 'xhigh';
  try {
    const p = path.join(HERE, 'capability.json');
    if (!fs.existsSync(p)) return { ceiling: safe, stale: true, reason: 'no-cache' };
    const cap = JSON.parse(fs.readFileSync(p, 'utf8'));
    let stale = false, reason = null;
    const bin = cfg.claudePath && cfg.claudePath !== 'claude' && fs.existsSync(cfg.claudePath) ? cfg.claudePath : null;
    if (bin && cap.fingerprint) {
      const st = fs.statSync(bin);
      if (Math.round(st.mtimeMs) !== cap.fingerprint.mtimeMs || st.size !== cap.fingerprint.size) {
        stale = true; reason = 'binary-changed';
      }
    }
    return { ceiling: stale ? safe : (cap.settingsCeiling || safe), stale, reason, version: cap.version };
  } catch (e) {
    return { ceiling: safe, stale: true, reason: 'cache-error' };
  }
}

function clampLevel(level, ceiling) {
  const li = LEVEL_ORDER.indexOf(level), ci = LEVEL_ORDER.indexOf(ceiling);
  if (li < 0 || ci < 0) return level; // unknown level name — pass through unchanged
  return li <= ci ? level : ceiling;
}

function logLine(cfg, rec) {
  if (!cfg.log) return;
  try {
    fs.appendFileSync(
      path.join(HERE, 'auto-effort.log'),
      JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'
    );
  } catch { /* logging must never throw */ }
}

// Always exit 0 — this hook never blocks. Empty output = let prompt through.
function emit(cfg, additionalContext, sysMsg) {
  const out = {};
  if (additionalContext) {
    out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext };
  }
  if (sysMsg && cfg.showSystemMessage) out.systemMessage = sysMsg;
  if (Object.keys(out).length === 0) process.exit(0);
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

function buildClassifierPrompt(userPrompt, cfg) {
  const tiers = Object.keys(cfg.tiers).join(', ');
  return cfg.classifierInstruction
    .replace(/\{TIERS\}/g, tiers)
    .replace('{PROMPT}', userPrompt);
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* best effort */ }
}

function classify(userPrompt, cfg) {
  return new Promise((resolve) => {
    // Direct .exe spawn => child.kill works cleanly. Fall back to a shell
    // (PATH resolution) only when the configured path isn't a real file.
    const useShell = !(cfg.claudePath && cfg.claudePath !== 'claude' && fs.existsSync(cfg.claudePath));
    const cmd = useShell ? 'claude' : cfg.claudePath;

    let child;
    try {
      child = spawn(cmd, ['-p', '--model', cfg.model, '--effort', cfg.classifierEffort], {
        env: { ...process.env, AUTO_EFFORT_CLASSIFYING: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, reason: 'spawn_throw', detail: String(e) });
    }

    let out = '', err = '', done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { killTree(child); finish({ ok: false, reason: 'timeout' }); }, cfg.timeoutMs);

    child.on('error', (e) => finish({ ok: false, reason: 'spawn_error', detail: String(e) }));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, raw: out });
      else finish({ ok: false, reason: 'exit_' + code, detail: err.slice(0, 200) });
    });

    try {
      child.stdin.write(buildClassifierPrompt(userPrompt, cfg));
      child.stdin.end();
    } catch (e) {
      finish({ ok: false, reason: 'stdin_error', detail: String(e) });
    }
  });
}

function parseTier(raw, cfg) {
  if (!raw) return null;
  const text = String(raw).toLowerCase();
  // Prefer the last tier-word that appears (the model's final answer), so a
  // restated question that lists tiers doesn't shadow the real verdict.
  let found = null;
  for (const name of Object.keys(cfg.tiers)) {
    const re = new RegExp('\\b' + name + '\\b', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!found || m.index >= found.index) found = { name, index: m.index };
    }
  }
  return found ? found.name : null;
}

function resolveSettingsLocalPath(cfg, data) {
  if (cfg.settingsLocalPath) return cfg.settingsLocalPath;
  const root = process.env.CLAUDE_PROJECT_DIR || (data && data.cwd) || process.cwd();
  return path.join(root, '.claude', 'settings.local.json');
}

// Write effortLevel into a watched settings file so the running session
// hot-reloads it. Read-modify-write to preserve any other local settings; skip
// the write (and the resulting ConfigChange churn) when the value is unchanged.
function writeEffortLevel(level, cfg, data) {
  const file = resolveSettingsLocalPath(cfg, data);
  let obj = {};
  try {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8').trim();
      obj = txt ? JSON.parse(txt) : {};
    }
  } catch (e) {
    return { ok: false, reason: 'read_parse', detail: String(e && e.message || e), file };
  }
  if (obj.effortLevel === level) return { ok: true, changed: false, level, file };
  obj.effortLevel = level;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
    return { ok: true, changed: true, level, file };
  } catch (e) {
    return { ok: false, reason: 'write', detail: String(e && e.message || e), file };
  }
}

async function main(input) {
  const cfg = loadConfig();

  // Recursion guard: this very invocation is the classifier child → no-op.
  if (process.env.AUTO_EFFORT_CLASSIFYING === '1') process.exit(0);

  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const prompt = data && typeof data.prompt === 'string' ? data.prompt : '';
  const trimmed = prompt.trim();

  if (trimmed.length < cfg.minPromptChars) process.exit(0);
  if (cfg.skipSlashCommands && trimmed.startsWith('/')) {
    logLine(cfg, { skip: 'slash', prompt: trimmed.slice(0, 60) });
    process.exit(0);
  }

  const forClassifier = trimmed.length > cfg.maxPromptChars ? trimmed.slice(0, cfg.maxPromptChars) : trimmed;

  const started = Date.now();
  const res = await classify(forClassifier, cfg);
  const ms = Date.now() - started;

  if (!res.ok) {
    logLine(cfg, { fail_open: res.reason, detail: res.detail, ms, prompt: trimmed.slice(0, 60) });
    emit(cfg, null, null); // fail open
    return;
  }

  const tier = parseTier(res.raw, cfg);
  if (!tier) {
    logLine(cfg, { fail_open: 'unparsed', raw: String(res.raw).trim().slice(0, 80), ms });
    emit(cfg, null, null);
    return;
  }

  const t = cfg.tiers[tier];
  const desired = (cfg.effortFor && cfg.effortFor[tier]) || tier;
  const cap = loadCapability(cfg);            // detected settings ceiling (+ staleness)
  const level = clampLevel(desired, cap.ceiling);

  // (1) Set the REAL session effort via a hot-reloaded settings file.
  let effortWrite = null;
  if (cfg.writeEffortLevel) effortWrite = writeEffortLevel(level, cfg, data);

  // (2) Same-turn steer (and the only way to express the `max` tier).
  const additionalContext = cfg.injectDirective
    ? `${t.directive}\n\n(auto-effort: classified this prompt as "${t.label}" effort.)`
    : null;

  let sysMsg = `\u{1F9E0} auto-effort → ${t.label}`;
  if (cfg.writeEffortLevel && effortWrite) {
    sysMsg += effortWrite.ok ? ` (effortLevel=${level})` : ` (effortLevel write failed: ${effortWrite.reason})`;
    if (cap.stale) sysMsg += ' [effort caps stale — run calibrate.js]';
  }

  logLine(cfg, { tier, desired, level, ceiling: cap.ceiling, stale: cap.stale, ms, effortWrite, prompt: trimmed.slice(0, 60) });
  emit(cfg, additionalContext, sysMsg);
}

// ---- read all of stdin, then run (the hook-level timeout backstops a stall) ----
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => { main(input).catch(() => process.exit(0)); });
