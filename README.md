# auto-effort

**Automatically set Claude Code's reasoning effort, per prompt.**

Instead of running `/effort` by hand, a `UserPromptSubmit` hook classifies each prompt you send with a fast model (Claude Haiku) and adjusts how hard Claude thinks — high effort for a gnarly refactor, low for a rename — and resets every prompt.

> 🇰🇷 [한국어 README](README.ko.md)

---

## What it does

For every prompt, the hook does two things:

1. **Sets the real session effort** — writes the classified level to `.claude/settings.local.json` (`effortLevel`), which Claude Code hot-reloads. Capped at `xhigh` (see [below](#why-xhigh-and-not-max)).
2. **Injects a same-turn directive** — adds a "think this hard" instruction to that turn's context (the top tier includes the `ultrathink` keyword), which takes effect immediately and covers what the settings ceiling can't.

```
you submit a prompt
        │
        ▼
UserPromptSubmit hook  ──▶  claude -p --model haiku   →  low / medium / high / max
        │
        ├─(1) write effortLevel to .claude/settings.local.json   (real effort, hot-reloaded)
        └─(2) inject a reasoning directive into this turn         (same-turn; ultrathink for max)
        │
        ▼
Claude works at that effort
```

Because it runs per prompt, it's genuinely adaptive — unlike a session-wide `/effort` that stays high until you remember to lower it.

## Why `xhigh` and not `max`?

A hook cannot change the `/effort` session setting directly — Claude Code exposes no such hook output. The only channel a hook can use on a *running* session is the settings file (which Claude Code hot-reloads). That channel's `effortLevel` key accepts `low/medium/high/xhigh` but **silently drops `max`** (it's session-only).

This was verified behaviorally (Opus, identical prompt):

| effort source | output tokens |
| --- | --- |
| settings `effortLevel: low` | ~940 |
| settings `effortLevel: max` | ~915 ← **ignored, behaves like low** |
| settings `effortLevel: xhigh` | ~1980 ✓ |
| `--effort max` (flag) | ~4000 ← real max, flag only |

So `max` truly works only at launch (`--effort max` / `CLAUDE_CODE_EFFORT_LEVEL=max`), which can't be driven per-prompt. auto-effort therefore caps the real level at `xhigh` and uses the `ultrathink` directive to get max-level reasoning on hard turns. The ceiling isn't hardcoded — it's **auto-detected** (see [Updates](#staying-current-across-claude-code-updates)), so if a future Claude Code honors `max` in settings, auto-effort lifts the cap on its own.

## Requirements

- [Claude Code](https://claude.com/claude-code) with the `claude` CLI on your `PATH`
- Node.js ≥ 16
- A model that supports effort (e.g. Opus 4.8 / Sonnet 4.6 / Fable 5)

## Install

```bash
git clone https://github.com/<you>/claude-code-auto-effort.git
cd claude-code-auto-effort

# install for ONE project (recommended while trying it out):
node hook/install.js --target /path/to/your/project

# …or for ALL sessions:
node hook/install.js --global

# (optional) detect the effort ceiling for your Claude Code build (~2 min, uses opus):
node hook/calibrate.js
```

Then **restart Claude Code** (or open a new session) in that scope. Submit a prompt — you should see `🧠 auto-effort → <level>`.

> A scope is required on purpose: the hook runs a ~5s classifier on every prompt, so `--global` is a deliberate choice, not a default.

## Verify it's working

- The transcript shows `🧠 auto-effort → high (effortLevel=high)` per prompt.
- `hook/auto-effort.log` records each decision (tier, ms, prompt).
- To confirm the *real* effort changes live, watch the `with <level> effort` indicator next to the spinner (don't set `/effort` manually — a manual override outranks the settings file).

## Configuration — `hook/config.json`

`install.js` generates this from `config.example.json` and fills in `claudePath`. Key options:

| key | default | meaning |
| --- | --- | --- |
| `model` | `haiku` | classifier model |
| `timeoutMs` | `12000` | classifier timeout; on timeout it **fails open** (prompt passes through) |
| `skipSlashCommands` | `true` | don't classify `/clear`, `/effort`, … |
| `injectDirective` | `true` | inject the same-turn reasoning directive |
| `writeEffortLevel` | `true` | write the real `effortLevel` to `settings.local.json` |
| `effortFor` | `{low,medium,high,max→max}` | tier → desired level (clamped to the detected ceiling) |
| `safeCeiling` | `xhigh` | fallback ceiling when no calibration is present |
| `claudePath` | (auto) | path to the `claude` binary |

Set `writeEffortLevel: false` to make it suggestion-only (directive nudges, no settings change), or `injectDirective: false` to use the real-effort write alone.

## Staying current across Claude Code updates

The `xhigh` ceiling reflects today's Claude Code. To avoid hardcoding it:

- **Every run (free):** the hook checks the `claude` binary's fingerprint (mtime + size). If it changed (i.e. you updated), it falls back to `safeCeiling` and shows `[effort caps stale — run calibrate.js]`.
- **After an update:** run `node hook/calibrate.js` to re-detect — it parses the valid level names and behaviorally probes (on Opus, ~3 calls) whether settings honors `max`, writing `hook/capability.json`.
- **Auto-lift:** the clamp targets `max` → detected ceiling, so if settings ever starts honoring `max`, calibration picks it up and the cap disappears. No code change.

## Cost & limitations (honest)

- ⏱ ~4–7s added per prompt (mostly `claude` startup), plus a small amount of usage per classification.
- 🛡 **Fail-open:** any classifier error/timeout lets the prompt through untouched. The hook never blocks (always exits 0).
- 🔁 The classifier's own `claude` call is guarded against recursively triggering the hook.
- 🧢 Real effort tops out at `xhigh` (see above); `ultrathink` covers max-level turns.
- ❓ Whether a hook-injected `ultrathink` triggers the *formal* thinking-budget path is undocumented; the directive text steers behavior regardless.
- ✅ **Hot-reload verified (next-turn):** editing `effortLevel` in the watched settings file is re-read and applied on the **next** prompt. Measured on Opus (Claude Code 2.1.177, Windows) via a persistent stream-json session — flipping `low→xhigh` between turns raised reasoning to 1.42× vs a 0.92× same-effort control (n=1).
- ⚠️ **This can vary by environment**, so confirm in yours: the hot-reload / read-once set can change between **Claude Code versions**; a manual `/effort` or `CLAUDE_CODE_EFFORT_LEVEL` **shadows** the settings write (so it looks like nothing happens); file-watcher behavior differs on some filesystems (network drives, WSL); and interactive-TUI *same-turn* application isn't separately confirmed. Check via the `with <level> effort` indicator (see [Verify](#verify-its-working)).
- 🧠 The classifier sees prompt text only (no codebase/conversation context), so deceptively-simple prompts can be under-rated; it errs toward *higher* effort, which is the safe direction.

## Uninstall

```bash
node hook/uninstall.js --target /path/to/your/project   # or --global
```

This removes only the auto-effort hook entry; other settings and hooks are left intact. Delete the folder to remove the rest.

## License

[MIT](LICENSE).
