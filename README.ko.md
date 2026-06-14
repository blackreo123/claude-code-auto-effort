# auto-effort

프롬프트를 자동 분석해서 Claude Code의 **사고 강도(effort)를 매 프롬프트마다 자동 조절**하는 훅입니다.
`/effort`를 손으로 바꾸는 대신, 입력 내용을 빠른 모델이 분류해서 **두 가지로** 반영합니다:

1. **실제 세션 effort 변경** — 분류 결과를 `.claude/settings.local.json`의 `effortLevel`에 기록 → Claude Code가 이 파일을 **핫리로드**해서 진짜 effort가 바뀝니다.
2. **같은 턴 즉시 효과** — 그 턴 컨텍스트에 "이만큼 깊게 생각하라"는 지시문을 주입(최상위 티어는 `ultrathink`).

---

## 동작 원리

```
사용자가 프롬프트 입력
        │
        ▼
UserPromptSubmit 훅 (auto-effort.js)         ← Claude가 처리하기 "전"에 실행
        │
        ├─ claude -p --model haiku --effort low 로 분류 → low / medium / high / max
        │
        ├─(1)─ .claude/settings.local.json 에 effortLevel 기록 (max→xhigh)
        │        → Claude Code가 watched 파일을 핫리로드 → "진짜" 세션 effort 변경
        │
        └─(2)─ 티어별 사고 지시문을 그 턴 컨텍스트에 주입 (max는 ultrathink 포함)
        │
        ▼
Claude가 그 강도로 작업 시작
```

---

## effort를 "진짜로" 바꾸는 원리

직접 경로(훅 출력으로 effort 지정)는 Claude Code가 **지원하지 않습니다** — 훅 JSON에는 effort/model/env를 바꾸는 필드가 없습니다.
대신 **settings 파일 핫리로드**라는 우회로를 씁니다. 공식 문서 근거:

- *"Claude Code watches your settings files and reloads them when they change, so edits to most keys apply to the running session without a restart."* (user·project·local·managed 모두 포함)
- 재시작이 필요한(read-once) 설정은 **`model`과 `outputStyle` 둘뿐**으로 명시돼 있고, **`effortLevel`은 거기에 없습니다** → 핫리로드 대상으로 봅니다.

> ⚠️ **이 부분은 문서에 *명시적으로* 확정된 게 아니라 추론입니다. 반드시 아래 [검증](#실제-effort-변경-검증) 절차로 당신 환경에서 확인하세요.** 핫리로드가 안 먹어도 (2) 지시문 주입은 항상 작동합니다.

### 두 메커니즘을 둘 다 쓰는 이유

| | `writeEffortLevel` (실제 effort) | `injectDirective` (지시문 주입) |
|---|---|---|
| 바꾸는 것 | 진짜 세션 effort 값 (인디케이터에 표시) | 그 턴의 컨텍스트(행동 유도) |
| 적용 시점 | **다음 턴 지연 가능** (파일 감시가 비동기) | **같은 턴 즉시** |
| 표현 범위 | `low`~`xhigh` (**`max`/`ultracode` 불가**) | 모든 티어, `max`는 `ultrathink` |
| 확실성 | 핫리로드 동작에 의존(검증 필요) | 항상 작동 |

→ 서로의 약점을 메웁니다. 실제 effort는 `xhigh`가 천장이고 한 턴 늦을 수 있으니, **`max` 티어의 즉각적인 깊은 사고는 지시문(`ultrathink`)이 담당**합니다.

---

## 업데이트 대응 — effort 천장 자동 감지

`max`가 settings에서 막히는 건 **이 버전 기준**입니다(실측: flag `max`=4730토큰 vs settings `max`=915토큰 → 무시됨). Claude Code가 업데이트되면 바뀔 수 있으므로 **하드코딩하지 않고 감지**합니다:

- **매 실행(공짜):** 훅이 `claude.exe` 지문(mtime+size)을 확인. 캐시(`capability.json`)와 같으면 저장된 천장 사용. 다르면(=업데이트됨) `safeCeiling`(xhigh)로 안전 폴백 + `🧠 … [effort caps stale — run calibrate.js]` 표시.
- **업데이트 후 1회:** `node hook/calibrate.js` → (a) 유효 레벨 이름을 `--effort` 경고에서 파싱, (b) **Opus로 행동 측정**(settings `max`가 진짜 `max`처럼 추론량이 뛰는지)해서 천장 재감지 → `capability.json` 갱신.
- **자동으로 풀림:** 클램프는 `max`(희망) → 감지된 천장. 그래서 **미래에 settings가 `max`를 받게 되면**, calibrate가 `ceiling=max`로 감지 → 더 이상 `xhigh`로 안 깎고 `max`를 그대로 씁니다. 코드 수정 불필요.

> 행동 측정은 **Opus로만** 합니다(Haiku는 토큰이 effort를 단조롭게 안 따라가서 부적합 — 실측 확인). Opus 약 3콜이라 per-prompt가 아니라 **업데이트 시에만** 돕니다. 이름만 빠르게 갱신하려면 `node hook/calibrate.js --quick`.

---

## 파일 구조

```
auto_effort/
├─ .claude/
│  ├─ settings.json         # 훅 등록 (프로젝트 범위) — 직접 관리
│  └─ settings.local.json   # 훅이 effortLevel을 기록 (자동 생성/갱신)
├─ hook/
│  ├─ auto-effort.js        # 훅 본체 (Node)
│  ├─ calibrate.js          # effort 천장 감지 → capability.json (업데이트 후 1회 실행)
│  ├─ capability.json       # 감지된 천장 캐시 (자동 생성)
│  ├─ config.json           # 튜닝 설정
│  └─ auto-effort.log       # 결정 로그 (자동 생성)
└─ README.md
```

---

## 활성화

지금은 **프로젝트 범위**입니다 — `auto_effort` 폴더 세션에서만 작동하고 전역 설정은 안 건드립니다.

1. **켜기:** `auto_effort` 폴더에서 Claude Code를 **재시작**(또는 새 세션)하면 훅이 로드됩니다. `/hooks`로 확인 가능.
2. **전역으로:** `~/.claude/settings.json`의 기존 내용을 유지한 채 아래 `hooks` 키만 **병합**:
   ```json
   "hooks": {
     "UserPromptSubmit": [
       { "hooks": [ { "type": "command",
         "command": "node \"C:/Users/PRO/auto_effort/hook/auto-effort.js\"",
         "timeout": 25 } ] }
     ]
   }
   ```

---

## 실제 effort 변경 검증

`effortLevel` 핫리로드가 실제로 먹는지 **당신 환경에서** 확인하는 절차입니다.

> 🔑 **선행조건 — 수동 `/effort`를 쓰지 마세요.** 세션에서 `/effort max` 같은 수동 선택을 한 상태면 그게 settings 파일보다 우선해서 훅의 기록이 가려질 수 있습니다. 자동에 맡기려면 **수동 `/effort`를 하지 말거나, `/effort auto`로 초기화**한 뒤 테스트하세요. (또한 `CLAUDE_CODE_EFFORT_LEVEL` 환경변수가 설정돼 있으면 그게 모든 걸 덮어쓰니 비워두세요 — 현재는 비어 있음.)

1. `auto_effort`에서 **새 세션**을 엽니다(수동 `/effort` 없이).
2. 사소한 요청을 입력: 예) `rename foo to bar`. 화면에서 확인:
   - 안내 메시지 `🧠 auto-effort → low (effortLevel=low)`
   - 로고/스피너 옆 **`with low effort`** 인디케이터(또는 `/status`)가 **low로** 바뀌는지
3. 복잡한 요청을 입력: 예) `여러 서비스에 걸친 교착상태 원인 추적하고 고쳐줘`. 인디케이터가 **`xhigh`로** 오르는지 확인.

**해석:**
- 인디케이터가 따라 움직이면 → ✅ 핫리로드 확정. "진짜 effort 자동 조정"이 작동 중.
- 안내 메시지는 뜨는데 인디케이터가 안 움직이면 → 이 버전에선 `effortLevel`이 사실상 read-once. `writeEffortLevel`을 꺼도 되고(아래), **지시문 주입(2)이 같은 턴에 계속 작동**하므로 체감 효과는 유지됩니다.
- 한 턴 늦게 움직이면 → 비동기 리로드의 정상 동작(설계상 알려진 지연).

`hook/auto-effort.log`에 매 결정의 `effortWrite` 결과(성공/변경 여부/경로)가 남으니 같이 보세요.

---

## 설정 (`hook/config.json`)

| 키 | 기본값 | 설명 |
|---|---|---|
| `model` | `"haiku"` | 분류 모델 별칭. |
| `classifierEffort` | `"low"` | 분류 호출 자체의 effort(한 단어만 뱉으면 되니 낮게). |
| `timeoutMs` | `12000` | 분류 내부 타임아웃(ms). 초과 시 **fail-open**. |
| `maxPromptChars` | `4000` | 분류기에 보낼 프롬프트 최대 길이. |
| `minPromptChars` | `1` | 이보다 짧으면 건너뜀. |
| `skipSlashCommands` | `true` | `/`로 시작하는 입력은 분류 안 함. |
| `showSystemMessage` | `true` | 선택된 티어/effortLevel을 화면에 표시. |
| `log` | `true` | `auto-effort.log`에 결정 기록. |
| `claudePath` | `…/claude.exe` | claude 실행 파일 경로(절대경로면 타임아웃 시 깔끔히 종료). |
| `injectDirective` | `true` | **(2)** 같은 턴 지시문 주입. |
| `writeEffortLevel` | `true` | **(1)** `settings.local.json`에 `effortLevel` 기록(실제 effort 변경). |
| `effortFor` | `{low,medium,high,max→max}` | 티어 → **희망** effortLevel. 결과는 감지된 천장으로 clamp되므로 `max`는 그냥 `max`로 둠. |
| `safeCeiling` | `"xhigh"` | `capability.json`이 없거나 stale일 때의 폴백 천장. |
| `settingsLocalPath` | `null` | null이면 `<CLAUDE_PROJECT_DIR 또는 cwd>/.claude/settings.local.json`. |

- **실제 effort 변경만 쓰고 싶다** → `injectDirective: false`.
- **지시문 주입만 쓰고 싶다**(검증 실패 시 등) → `writeEffortLevel: false`.
- 티어별 문구/분류 기준은 `auto-effort.js`의 `DEFAULTS`(`tiers`, `classifierInstruction`)를 `config.json`에서 덮어쓸 수 있습니다.

---

## 비용과 한계 (정직하게)

- ⏱ **프롬프트당 약 4~7초 지연** — 대부분 `claude.exe`(246MB) 기동 비용.
- 💸 매 분류가 **세션 사용량**을 약간 소모(haiku + low effort라 작음).
- 🛡 **절대 막지 않음(fail-open):** 분류 실패·타임아웃·파일 쓰기 실패 시 프롬프트는 그대로 통과. 훅은 항상 exit 0.
- 🔁 **재귀 방지:** 분류용 `claude -p`가 훅을 다시 부르지 않도록 `AUTO_EFFORT_CLASSIFYING` 환경변수로 차단.
- 🧢 **실제 effort는 현재 `xhigh`가 상한** (`max`/`ultracode`는 settings로 표현 불가 → 지시문이 보완). 단 이 천장은 `calibrate.js`가 **자동 감지**하므로, 향후 버전이 `max`를 받으면 자동으로 풀립니다([업데이트 대응](#업데이트-대응--effort-천장-자동-감지)).
- ⏳ **타이밍:** `writeEffortLevel`은 다음 턴에 반영될 수 있음. 같은 턴 효과는 `injectDirective`가 책임.
- ❓ `effortLevel` 핫리로드는 문서 추론 → [검증](#실제-effort-변경-검증) 필수.

---

## 제거

`.claude/settings.json`(전역에 병합했다면 `~/.claude/settings.json`)에서 `UserPromptSubmit` 훅 블록을 지우면 됩니다.
훅이 만든 `.claude/settings.local.json`의 `effortLevel`도 지우거나 원하는 값으로 바꾸세요. `auto_effort` 폴더를 통째로 지우면 흔적이 남지 않습니다(전역 설정은 안 건드렸음).
