<p align="center">
  <a href="../../README.md">한국어</a> ·
  <strong>English</strong> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <img src="../assets/codepet-readme-hero.png" alt="CodePet showing the status of multiple AI coding tools in speech bubbles" width="100%">

  <h1>CodePet</h1>

  <p><strong>A tiny desktop pet that keeps you posted while your AI coding tools work.</strong></p>

  <p>
    <code>macOS</code>
    <code>Windows</code>
    <code>Electron</code>
    <code>Local-first</code>
    <code>npm test</code>
  </p>

  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#support-matrix">Support</a> ·
    <a href="#features">Features</a> ·
    <a href="#customize-your-pet">Pet customization</a> ·
    <a href="#development-and-builds">Development</a>
  </p>
</div>

---

CodePet is a desktop companion that watches local work logs from **Codex**, **Google Antigravity (AGY)**, **Claude Code**, and **Kimi Code CLI**. It combines multiple task states and recent messages into one responsive bubble, while keeping account quota and pet settings in one place.

Work data is read locally for on-screen display. You decide how much detail the activity bubble may show.

## At a glance

| Live task status | Quotas and accounts | Concurrent tasks | Your desktop pet |
|---|---|---|---|
| Shows responding, editing, commands, tests, approval waits, and completion through motion and bubbles. | Shows every connected Codex, AGY, and Claude account in its own quota card. | Tracks up to five tasks across providers in start order. | Loads Codex pets and custom sprite sheets, then remembers size, position, and movement preferences. |

## Quick start

### Run from source

```bash
git clone https://github.com/SeuPut0705/CodePet.git
cd CodePet
npm install
npm run start
```

> CodePet displays activity after a supported AI tool is installed locally and has produced session records.

### Build an executable

```bash
npm run dist          # Current operating system
npm run dist -- --win # Windows portable exe
npm run dist -- --mac # macOS dmg + zip
```

Build outputs are written to `artifacts/`. Quit CodePet completely before building because a running app may lock the output files. This repository does not automatically publish signed or notarized installers.

## Support matrix

| Tool | Activity | Quota | Saved account switching |
|---|:---:|:---:|:---:|
| Codex Desktop / CLI | ✓ | ✓ | ✓ |
| Google Antigravity | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | ✓ |
| Kimi Code CLI | ✓ | Managed login only | — |

- **Codex** watches both Desktop and CLI work under `~/.codex/sessions`.
- **Claude Code** watches CLI and desktop-app sessions recorded under `~/.claude/projects`.
- **Kimi Code CLI** reads work records under `~/.kimi-code/sessions` or `KIMI_CODE_HOME`. A custom provider is never treated as managed Kimi.
- CodePet does not support Kimi account switching.
- CLI activity uses the **project folder name** instead of an automatically generated session title.

## Features

### A bubble that makes task state easy to scan

CodePet normalizes provider-specific events into a common set of states.

| Detected event | CodePet response |
|---|---|
| Task starts or writes a response | Look-around motion with task title, model, and reasoning effort |
| File edit, command, test, or build | Matching status icon and current visible message |
| Waiting for user input or approval | Waiting motion; supported Codex tasks can be opened by clicking |
| Task completed | Hop animation and final visible response |
| Task interrupted | Failure animation |
| Subagent running | Active count per task, never the subagent message text |

The bubble automatically adjusts its width to its content and the current display. Long messages wrap within a capped width, while the task title, model, subagent count, and `5h` and `7d` badges stay on one line.

When Codex rollout metadata includes a Sol, Terra, or Luna model and reasoning effort, CodePet shows them next to the task title. Concurrent sessions keep separate titles and messages. Tasks without a completion event are cleared after provider-specific quiet-time or stale handling.

### Every connected account quota

Double-click the pet to open **Usage by Account (계정별 한도)** in Settings.

- One card for every connected Codex, AGY, and Claude account
- A failed account lookup never hides the other cards
- Codex windows use the actual server duration for five-hour, weekly, monthly, and model-specific limits
- Usage over 70% turns yellow; usage over 90% turns red
- Codex warns once per reset window after usage exceeds 90%
- The first active managed Kimi Code section shows remaining **`5h` and `7d` quota**

Managed Kimi Code sessions show remaining `5h` and `7d` quota; custom providers and context usage do not.

### Privacy level

Choose the activity detail level in **General (일반)** settings.

| Mode | What appears |
|---|---|
| Full content (전체 내용) | Requests, visible responses, file names, and commands |
| Status only (상태만) | States such as working, testing, or waiting for approval |
| Off (끄기) | Hides automatic task bubbles while pet motion continues |

Internal reasoning and subagent messages are never shown in the bubble.

### Appearance and movement

- Custom bubble background and text colors
- Installed system font picker
- Drag movement and a top-left resize handle
- Saved geometry restored inside the current display work area
- Mouse following and two-dimensional roaming
- Persisted movement pause and mouse-follow settings
- Login auto-start on macOS and Windows

## Controls

| Action | Response |
|---|---|
| Click | Wave |
| Double-click | Jump and open Usage by Account |
| Drag | Move the pet |
| Drag the top-left resize handle | Resize while keeping the bottom-right corner anchored |
| Right-click | Settings, accounts, pets, motion, movement, auto-start, and hide menu |
| System tray | Settings, show/hide, accounts, pets, and quit |
| Click a completed/input-wait/approval-wait bubble | Open the supported Codex task |
| Click any other bubble | Dismiss it |

**Hide (숨기기)** only hides the window; CodePet remains in the system tray. Use **Quit completely (완전 종료)** from the tray menu to stop the app.

<details>
<summary><strong>Account management details</strong></summary>

The right-click and tray menus use the same account structure for Codex, AGY, and Claude. Remove inactive profiles from **Accounts (계정)** in Settings. Switch away from the active profile before deleting it.

- **Codex** stores credentials per profile. The default **Switch without restarting Codex (proxy) (Codex 재시작 없는 전환 (프록시))** mode uses a local `127.0.0.1` proxy to apply credentials per request and rotate accounts after a quota limit. It manages the `# codepet-codex-proxy` block in `~/.codex/config.toml`. Codex may need one restart immediately after the proxy is enabled for the first time.
- **AGY** stores the current Windows Credential Manager or macOS Keychain credential, switches to the selected profile, and restarts AGY.
- **Claude** stores the current credential file with the email from `claude auth status`. Existing sessions stay open; new sessions use the selected account.

Profiles are stored under `~/.codepet/codex-switch`, `~/.codepet/antigravity-switch`, and `~/.codepet/claude-switch`. Secret values are not shown in Settings.

If Codex cannot connect after a forced shutdown, start CodePet once to clean the stale proxy marker. You can also remove the `# codepet-codex-proxy` block from `~/.codex/config.toml`.

</details>

## Customize your pet

The **Change pet (펫 바꾸기)** menu searches in this order:

1. `pet/spritesheet.webp` next to the executable
2. Pets installed by Codex CLI under `~/.codex/pets`
3. The built-in CodePet pet

Your choice is restored on the next launch.

<details>
<summary><strong>Custom sprite specification</strong></summary>

CodePet automatically recognizes Codex pet sprite formats v1 and v2.

| Version | Full size | Cell size | Grid |
|---|---:|---:|---:|
| v1 | 1536×1872 | 192×208 | 8 columns × 9 rows |
| v2 | 1536×2288 | 192×208 | 8 columns × 11 rows |

| Row | State | v1 frames | v2 frames |
|---:|---|---:|---:|
| 0 | idle | 6 | 6 |
| 1 | runningRight | 8 | 8 |
| 2 | runningLeft | 8 | 8 |
| 3 | waving | 4 | 4 |
| 4 | jumping | 5 | 5 |
| 5 | failed | 8 | 8 |
| 6 | waiting | 8 | 6 |
| 7 | running | 8 | 6 |
| 8 | review | 8 | 6 |
| 9 | look directions A | — | 8 |
| 10 | look directions B | — | 8 |

Rows 9–10 in v2 contain 16 clockwise look directions. CodePet currently plays the base animations in rows 0–8 and recognizes rows 9–10 for correct v2 layout slicing.

The image height normally identifies a 9-row or 11-row sheet. If the ratio cannot be determined, CodePet falls back to `spriteVersionNumber` in the adjacent `pet.json`. Put the finished `spritesheet.webp` in the executable's `pet/` folder to expose it as **Custom (커스텀)**.

</details>

## Development and builds

### Commands

```bash
npm run dev  # Development run
npm test     # Full local test suite
npm run dist # Package for the current operating system
```

Enable DevTools through an environment variable.

```bash
PET_DEVTOOLS=1 npm run dev # macOS / Linux shell
```

```powershell
$env:PET_DEVTOOLS="1"
npm run dev
```

GitHub Actions is disabled. Local `npm test` is the verification gate.

<details>
<summary><strong>Code map</strong></summary>

- `src/main.js` — Electron windows, menus, movement, account and bubble lifecycle
- `src/codex-watcher.js` — Codex Desktop and CLI session watcher
- `src/antigravity-watcher.js` — Google Antigravity transcript watcher
- `src/claude-watcher.js` — Claude Code project log watcher
- `src/kimi-watcher.js` — Kimi Code CLI session and activity watcher
- `src/activity-bubble-state.js` — Concurrent activity aggregation across providers
- `src/bubble-window-geometry.js` — Content- and display-aware bubble geometry
- `src/codex-account-switcher.js`, `src/antigravity-account-switcher.js`, `src/claude-account-switcher.js` — Saved account switching
- `src/kimi-usage-client.js`, `src/provider-usage.js` — Provider quota fetching and normalization
- `src/settings.html`, `src/settings.js`, `src/settings.css` — Settings and quota UI
- `src/renderer.js` — Pet sprite animation
- `src/bubble.html`, `src/bubble.js`, `src/bubble.css` — Unified activity bubble
- `test/` — Regression tests using the Node.js built-in test runner

</details>

---

<div align="center">
  <sub>CodePet depends on each tool's local file format and authentication state. Provider updates may temporarily limit some detection.</sub>
</div>
