<p align="center">
  <strong>한국어</strong> ·
  <a href="docs/i18n/README.en.md">English</a> ·
  <a href="docs/i18n/README.ja.md">日本語</a> ·
  <a href="docs/i18n/README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <img src="docs/assets/codepet-readme-hero.png" alt="여러 AI 코딩 도구의 작업 상태를 말풍선으로 보여 주는 CodePet" width="100%">

  <h1>CodePet</h1>

  <p><strong>AI 코딩 도구가 일하는 동안, 화면 위의 작은 펫이 진행 상황을 알려줍니다.</strong></p>

  <p>
    <code>macOS</code>
    <code>Windows</code>
    <code>Electron</code>
    <code>Local-first</code>
    <code>npm test</code>
  </p>

  <p>
    <a href="#빠른-시작">빠른 시작</a> ·
    <a href="#지원-범위">지원 범위</a> ·
    <a href="#주요-기능">주요 기능</a> ·
    <a href="#펫-꾸미기">펫 꾸미기</a> ·
    <a href="#개발과-빌드">개발과 빌드</a>
  </p>
</div>

---

CodePet은 **Codex**, **Google Antigravity(AGY)**, **Claude Code**, **Kimi Code CLI**, **Gemini CLI**, **GitHub Copilot CLI**, **Cursor**, **OpenCode**, **Windsurf**의 로컬 작업을 함께 감시하는 데스크톱 펫입니다. 여러 작업의 상태와 마지막 메시지를 하나의 반응형 말풍선에 정리하고, 감지된 공급자·계정·사용량과 펫 설정도 한곳에서 관리합니다.

작업 내용은 화면에 표시하기 위해 로컬에서 읽습니다. 개인정보 표시 수준은 사용자가 직접 선택할 수 있습니다.

## 한눈에 보기

| 실시간 작업 상태 | 사용량과 계정 | 여러 작업 동시 표시 | 나만의 데스크톱 펫 |
|---|---|---|---|
| 응답 작성, 파일 수정, 명령, 테스트, 승인 대기, 완료를 모션과 말풍선으로 표시합니다. | Codex·AGY·Claude의 연결된 계정과 관리형 Kimi 로그인의 한도를 계정 행에서 바로 확인합니다. | 공급자를 합쳐 시작 순서대로 최대 5개 작업을 각각 추적합니다. | Codex 펫과 커스텀 스프라이트를 불러오고 크기·위치·이동 방식을 저장합니다. |

## 빠른 시작

### 소스에서 실행

```bash
git clone https://github.com/SeuPut0705/CodePet.git
cd CodePet
npm install
npm run start
```

> CodePet은 감지하려는 AI 도구가 로컬에 설치되어 있고, 해당 도구의 세션 기록이 존재할 때 활동을 표시합니다.

### 실행 파일 만들기

```bash
npm run dist          # 현재 운영체제용
npm run dist -- --win # Windows 포터블 exe
npm run dist -- --mac # macOS dmg + zip
```

산출물은 `artifacts/`에 생성됩니다. 실행 중인 CodePet이 산출물을 잠글 수 있으므로 빌드 전 앱을 완전히 종료하세요. 현재 저장소는 서명·공증된 공식 설치 파일을 자동 배포하지 않습니다.

## 지원 범위

| 도구 | 활동 감지 | 사용량 표시 | 계정·연결 |
|---|:---:|:---:|:---:|
| Codex Desktop / CLI | ✓ | ✓ | ✓ |
| Google Antigravity | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | ✓ |
| Kimi Code CLI | ✓ | 관리형 로그인만 | — |
| Gemini CLI | ✓ | — | 로그인·계정 식별 |
| GitHub Copilot CLI | ✓ | — | 로그인·hook 연결 |
| Cursor App / CLI | ✓ | — | 로그인·hook 연결 |
| OpenCode App / CLI | ✓ | — | 로그인 감지 |
| Windsurf App | ✓ | — | hook 연결 |

- **Codex**는 `~/.codex/sessions`의 Desktop·CLI 작업을 함께 감지합니다.
- **Claude Code**는 `~/.claude/projects`에 기록되는 CLI와 데스크톱 앱 세션을 함께 감지합니다.
- **Kimi Code CLI**는 `~/.kimi-code/sessions` 또는 `KIMI_CODE_HOME` 아래의 작업 기록을 읽습니다. 사용자 지정 provider를 관리형 Kimi로 간주하지 않습니다.
- CodePet은 Kimi 계정 전환을 지원하지 않으며, Kimi는 계정 전환 대상이 아닙니다.
- **Gemini CLI**는 `~/.gemini/tmp` 또는 `GEMINI_CLI_HOME` 아래의 JSONL 세션을 읽습니다. 메인 세션만 메시지로 표시하고 중첩 subagent는 본문 없이 활성 개수만 합산합니다.
- **OpenCode**는 로컬 SQLite 세션 DB를 백그라운드 워커에서 읽습니다. 앱과 CLI의 메인 세션만 메시지로 표시하고 하위 세션은 활성 개수만 합산합니다.
- **GitHub Copilot CLI**, **Cursor**, **Windsurf**는 설정에서 연결할 때 각 도구의 hook 설정에 CodePet 로컬 이벤트 전달 항목을 추가합니다. 기존 hook은 유지하며 손상된 JSON은 덮어쓰지 않습니다.
- 설정의 공급자 목록은 설치된 앱·CLI, 연결된 통합, 확인된 계정 중 하나가 있는 항목만 보여 줍니다. `계정 추가`에서 나머지 공급자를 선택해 연결할 수 있습니다.
- CLI 활동 제목은 자동 생성된 세션 제목 대신 **프로젝트 폴더명**을 사용합니다.

감지 경로, 연결 파일, 개인정보 경계와 복구 동작은 [공급자 연결·감지 구조](docs/provider-integrations.md)에 정리되어 있습니다.

## 주요 기능

### 작업 상태를 바로 읽는 말풍선

CodePet은 공급자별 작업 이벤트를 공통 상태로 정리합니다.

| 감지한 이벤트 | CodePet 반응 |
|---|---|
| 작업 시작·응답 작성 | 살펴보기 모션과 작업 제목·모델·추론 강도 표시 |
| 파일 수정·명령 실행·테스트·빌드 | 해당 상태 아이콘과 현재 메시지 표시 |
| 사용자 입력·실행 승인 대기 | 기다리기 모션, 지원되는 Codex 작업은 클릭해 바로 열기 |
| 작업 완료 | 폴짝 모션과 마지막 응답 표시 |
| 작업 중단 | 실패 모션 표시 |
| 서브에이전트 실행 | 메시지 내용 대신 작업별 활성 개수만 표시 |

말풍선은 **콘텐츠와 현재 화면 크기에 맞춰 자동으로 폭을 조절**합니다. 긴 메시지는 최대 폭 안에서 줄바꿈하고, 작업 제목·모델·서브에이전트 수·사용량 배지는 한 줄을 유지합니다.

Codex rollout에서 확인된 Sol·Terra·Luna 모델과 추론 강도는 작업 제목 옆에 표시됩니다. 여러 세션을 동시에 실행해도 각 작업의 제목과 메시지를 분리하며, 완료 이벤트가 없는 작업은 공급자별 quiet-time 또는 stale 처리 후 정리합니다.

### 계정과 사용량을 한 화면에서

설정의 `계정` 화면은 연결·전환·삭제와 남은 사용량을 한곳에 모읍니다.

- Codex·AGY·Claude에 연결된 계정과 관리형 Kimi 로그인의 한도를 각 계정 행에 컴팩트한 잔여율 칩으로 표시
- 한 계정 조회가 실패해도 나머지 계정 행과 사용량 유지
- Codex 서버가 제공한 실제 기간을 읽어 5시간·주간·월간 한도를 표시하고 GPT-5.3-Codex 모델 전용 한도는 숨김
- 남은 비율 30% 이하는 노란색, 10% 이하는 빨간색으로 강조
- Codex 사용률 90% 초과 시 초기화 주기당 한 번 경고
- 관리형 Kimi Code 작업의 첫 섹션에 **`5h`·`7d` 남은 사용량** 표시

Kimi의 컨텍스트 사용량이나 사용자 지정 provider 값은 계정 한도로 표시하지 않습니다.

### 개인정보 표시 수준

설정의 `일반` 화면에서 활동 말풍선의 정보량을 고를 수 있습니다.

| 모드 | 표시 내용 |
|---|---|
| 전체 내용 | 요청, 보이는 응답, 파일명과 명령 |
| 상태만 | 작업 중, 테스트 중, 승인 대기 같은 상태 |
| 끄기 | 자동 작업 말풍선 숨김, 펫 모션은 유지 |

내부 추론 내용과 서브에이전트 메시지는 말풍선에 노출하지 않습니다. 표시 가능한 도구 입력에서도 인증 헤더, API 키, 쿠키, 비밀번호와 URL 비밀값을 마스킹합니다.

### 화면과 움직임

- 말풍선 배경색·글자색과 설치된 시스템 글꼴 선택
- 펫 드래그 이동과 좌상단 핸들을 이용한 크기 조절
- 화면이 바뀌어도 저장된 위치와 크기를 현재 작업 영역 안으로 복원
- 마우스 따라가기와 2차원 자동 배회
- 이동 일시 정지와 마우스 따라가기 설정 영구 저장
- macOS·Windows 로그인 시 자동 실행
- 설정 화면은 한국어·English·日本語·简体中文을 지원하며 기본값은 시스템 언어입니다

## 조작법

| 동작 | 반응 |
|---|---|
| 클릭 | 인사 |
| 더블클릭 | 점프 후 현재 Codex 사용량 말풍선 표시 |
| 드래그 | 펫 이동 |
| 좌상단 크기 핸들 드래그 | 화면 끝에서도 우하단 기준으로 크기 조절 |
| 우클릭 | 설정, 계정, 펫, 모션, 이동, 자동 실행, 숨기기 메뉴 |
| 시스템 트레이 | 설정, 보이기·숨기기, 계정, 펫, 완전 종료 |
| 완료·입력 대기·승인 대기 말풍선 클릭 | 지원되는 Codex 작업 열기 |
| 그 외 말풍선 클릭 | 말풍선 닫기 |

`숨기기`는 창만 감추고 CodePet을 시스템 트레이에 남깁니다. 앱을 끄려면 트레이 메뉴의 `완전 종료`를 선택하세요.

<details>
<summary><strong>계정 추가·전환·삭제 자세히 보기</strong></summary>

우클릭 메뉴와 시스템 트레이는 Codex·AGY·Claude에 같은 계정 메뉴 구조를 제공합니다. 계정 삭제는 `설정…`의 `계정` 화면에서 수행하며, 현재 사용 중인 프로필은 다른 계정으로 전환한 뒤 삭제할 수 있습니다.

- **Codex**: 프로필별 인증 정보를 저장합니다. 계정을 전환할 때 Codex Desktop이 실행 중이면 CodePet이 앱 종료를 요청하고 실제 종료를 확인한 뒤 인증을 교체하고 자동으로 다시 실행합니다. 사용자가 Codex를 수동으로 종료할 필요가 없습니다. `Codex 한도 자동 전환 (로컬 엔진)`은 내장 OpenCodex 엔진(MIT, `vendor/opencodex`에 출처·커밋 추적)이 `127.0.0.1`에서 새 CLI 연결의 인증 헤더를 적용하고 한도 소진 시 다음 계정으로 로테이션합니다. 설정을 켜거나 끌 때 `~/.codex/config.toml`의 `# codepet-codex-provider` 블록을 관리합니다. 이미 열린 CLI 세션은 새로 시작해야 계정 변경이 적용될 수 있습니다.
- **AGY**: Windows 자격 증명 관리자 또는 macOS Keychain의 현재 자격 증명을 프로필로 저장하고, 선택한 계정으로 전환한 뒤 AGY를 다시 시작합니다.
- **Claude**: 현재 자격 파일과 `claude auth status`의 이메일을 프로필로 저장합니다. 이미 열린 세션은 유지되고 새 세션부터 선택한 계정을 사용합니다.

프로필은 `~/.codepet/codex-switch`, `~/.codepet/antigravity-switch`, `~/.codepet/claude-switch`에 저장됩니다. 설정 화면에는 비밀 값이 노출되지 않습니다.

강제 종료 후 Codex 연결이 막히면 CodePet을 다시 실행해 stale 엔진 마커를 정리하세요. 필요하면 `~/.codex/config.toml`에서 `# codepet-codex-provider` 블록을 제거할 수 있습니다.

</details>

## 펫 꾸미기

우클릭 메뉴의 `펫 바꾸기`에서 다음 순서로 펫을 찾습니다.

1. 실행 파일 옆 `pet/spritesheet.webp`
2. Codex CLI가 설치한 `~/.codex/pets`의 펫
3. CodePet 내장 기본 펫

선택한 펫은 다음 실행에도 유지됩니다.

<details>
<summary><strong>커스텀 스프라이트 규격</strong></summary>

CodePet은 Codex 펫 스프라이트 v1과 v2를 자동 인식합니다.

| 버전 | 전체 크기 | 셀 크기 | 그리드 |
|---|---:|---:|---:|
| v1 | 1536×1872 | 192×208 | 8열 × 9행 |
| v2 | 1536×2288 | 192×208 | 8열 × 11행 |

| row | 상태 | v1 프레임 | v2 프레임 |
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

v2의 row 9~10은 시계 방향 시선 16개입니다. 현재 CodePet은 row 0~8의 기본 애니메이션을 재생하고, row 9~10은 v2 시트 판별과 올바른 셀 분할에 사용합니다.

이미지 높이로 9행·11행을 우선 판별하고, 비율을 확인할 수 없으면 같은 폴더의 `pet.json`에 있는 `spriteVersionNumber`를 사용합니다. 완성한 `spritesheet.webp`를 실행 파일 옆 `pet/` 폴더에 넣으면 `커스텀` 항목으로 나타납니다.

</details>

## 개발과 빌드

### 명령

```bash
npm run dev  # 개발 실행
npm test     # 전체 로컬 테스트
npm run dist # 현재 운영체제용 패키지
```

DevTools가 필요하면 환경변수를 설정한 뒤 개발 모드로 실행합니다.

```bash
PET_DEVTOOLS=1 npm run dev # macOS / Linux shell
```

```powershell
$env:PET_DEVTOOLS="1"
npm run dev
```

GitHub Actions는 사용하지 않습니다. 변경 검증 기준은 로컬 `npm test`입니다.

<details>
<summary><strong>코드 구조</strong></summary>

- `src/main.js` — Electron 창, 메뉴, 이동, 계정·말풍선 수명주기
- `src/codex-watcher.js` — Codex Desktop·CLI 세션 감시
- `src/antigravity-watcher.js` — Google Antigravity transcript 감시
- `src/claude-watcher.js` — Claude Code 프로젝트 로그 감시
- `src/kimi-watcher.js` — Kimi Code CLI 세션·활동 감시
- `src/gemini-watcher.js`, `src/opencode-watcher.js` — Gemini CLI·OpenCode 세션과 하위 작업 수명주기 감시
- `src/opencode-db-query.js`, `src/opencode-db-worker.js` — OpenCode SQLite 백그라운드 조회
- `src/provider-hook-bridge.js`, `src/provider-hook-watcher.js`, `src/provider-integrations.js` — Copilot·Cursor·Windsurf 로컬 hook 연결과 이벤트 정규화
- `src/provider-catalog.js`, `src/provider-client-discovery.js` — 공급자 메타데이터와 앱·CLI 설치 감지
- `src/activity-redaction.js` — 말풍선에 전달하기 전 도구 입력의 비밀값 제거
- `src/activity-bubble-state.js` — 공급자별 동시 작업과 표시 상태 집계
- `src/bubble-window-geometry.js` — 콘텐츠·화면 기반 말풍선 크기와 배치
- `src/codex-account-switcher.js`, `src/antigravity-account-switcher.js`, `src/claude-account-switcher.js` — 계정 프로필 저장·전환
- `src/kimi-usage-client.js`, `src/provider-usage.js` — 공급자 사용량 조회·정규화
- `src/settings.html`, `src/settings.js`, `src/settings.css` — 설정과 계정·사용량 통합 UI
- `src/renderer.js` — 펫 스프라이트 애니메이션
- `src/bubble.html`, `src/bubble.js`, `src/bubble.css` — 통합 작업 말풍선
- `test/` — Node 내장 test runner 기반 회귀 테스트

</details>

---

<div align="center">
  <sub>CodePet은 각 도구의 로컬 파일 형식과 인증 상태에 의존합니다. 공급자 업데이트로 형식이 바뀌면 일부 감지가 일시적으로 제한될 수 있습니다.</sub>
</div>
