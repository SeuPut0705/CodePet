# 공급자 연결·감지 구조

이 문서는 현재 CodePet이 지원하는 로컬 AI 도구의 설치 감지, 계정 연결, 활동 수집, 개인정보 경계와 장애 복구 계약을 설명한다. 날짜가 붙은 `docs/superpowers/` 문서는 당시 설계 기록이며, 현재 동작은 이 문서와 루트 README를 기준으로 한다.

## 지원 표면

| 공급자 | 감지 클라이언트 | 활동 원본 | 설정의 연결 동작 | 사용량 |
|---|---|---|---|---|
| Codex | Desktop, CLI | `~/.codex/sessions` rollout | 로그인, 저장 계정 전환·삭제 | 계정별 |
| Antigravity | App | 로컬 transcript | 로그인, 저장 계정 전환·삭제 | 계정별 |
| Claude | App, CLI | `~/.claude/projects` JSONL | 로그인, 저장 계정 전환·삭제 | 계정별 |
| Kimi | CLI | `state.json`, `wire.jsonl` | `kimi login` | 관리형 로그인만 |
| Gemini | CLI | 세션 JSONL | `gemini --prompt-interactive /auth` | 제공하지 않음 |
| GitHub Copilot | CLI | hook, main-agent transcript | hook 설치 후 `copilot login` | 제공하지 않음 |
| Cursor | App, CLI | hook | hook 설치 후 로그인 또는 앱 열기 | 제공하지 않음 |
| OpenCode | App, CLI | 로컬 SQLite DB | `opencode auth login` 또는 앱 열기 | 제공하지 않음 |
| Windsurf | App | hook | hook 설치 후 앱 열기 | 제공하지 않음 |

사용량 카드가 없는 공급자는 임의 계산값이나 컨텍스트 사용률을 계정 한도로 표시하지 않는다.

## 앱·CLI 설치 감지

`src/provider-catalog.js`가 공급자 ID, 이름, 실제 아이콘, 지원 클라이언트와 기능을 한곳에서 정의한다. `src/provider-client-discovery.js`는 다음 위치를 함께 확인한다.

- macOS: `/Applications`, `~/Applications`, Homebrew, npm, pnpm, Bun, `~/.local/bin`
- Windows: `%LOCALAPPDATA%\Programs`, npm, pnpm, Bun, Scoop, `~/.local/bin`
- Linux: 시스템·사용자 실행 경로와 지원 앱 실행 파일
- Cursor CLI: 현재 `agent`와 구버전 `cursor-agent`
- OpenCode: `OPENCODE_INSTALL_DIR`, `XDG_BIN_DIR`, `~/.opencode/bin`

macOS GUI 앱은 로그인 셸의 `PATH`를 그대로 받지 않을 수 있으므로 알려진 설치 경로를 직접 확인한다. 설정의 계정 목록에는 다음 중 하나라도 확인된 공급자만 표시한다.

- 앱 또는 CLI 설치
- CodePet hook 연결
- 확인된 로컬 계정

`계정 추가` 메뉴에는 연결 가능한 전체 공급자를 표시한다. 연결 전에 필요한 앱이나 CLI가 실제로 있는지 다시 확인하므로, 실패한 연결을 연결됨으로 저장하지 않는다.

## Codex 계정 전환 수명주기

실행 중인 Codex Desktop은 인증 파일 변경을 즉시 다시 읽는다고 가정하지 않는다. 계정 전환은 다음 순서를 지킨다.

1. macOS는 `com.openai.codex` 번들 ID, Windows는 등록 패키지 실행 경로로 Desktop 실행 여부를 확인한다.
2. 실행 중이면 종료를 요청하고 프로세스가 실제로 사라질 때까지 제한 시간 안에서 확인한다.
3. 종료 확인 뒤에만 선택한 프로필의 `auth.json`을 기본 Codex 홈에 원자 복사한다.
4. 원래 실행 중이던 Desktop만 다시 실행하고 시작 상태를 확인한다.

종료 확인이 실패하면 인증을 바꾸지 않는다. 인증 교체가 실패하면 종료했던 Desktop을 기존 인증으로 복구 실행한다. Desktop이 원래 꺼져 있으면 계정만 바꾸고 임의로 앱을 열지 않는다.

`Codex 한도 자동 전환 (로컬 엔진)`은 내장 OpenCodex 엔진(worker thread, `127.0.0.1` 전용)이 새 CLI 연결의 인증 헤더 적용과 한도 자동 로테이션을 담당한다. 엔진은 OpenCodex 업스트림 스냅샷(MIT, `vendor/opencodex/UPSTREAM.json`에 태그·커밋 고정)에서 빌드되며 외부 데몬이 필요 없다. Desktop 계정 전환의 자동 종료·재실행 계약은 엔진 활성 여부와 무관하게 유지한다. 이미 열린 CLI 세션은 새로 시작해야 선택 계정이 적용될 수 있다.

## 사용자 지정 홈과 데이터 위치

| 환경변수 | 적용 범위 |
|---|---|
| `KIMI_CODE_HOME` | Kimi 세션과 관리형 OAuth 파일 |
| `GEMINI_CLI_HOME` | 그 아래 `.gemini` 세션·계정 파일 |
| `COPILOT_HOME` | 그 아래 `hooks/codepet.json` |
| `XDG_DATA_HOME` | OpenCode DB와 인증 파일 |
| `OPENCODE_INSTALL_DIR` | OpenCode CLI 탐색 |

환경변수는 CodePet을 시작하기 전에 설정해야 한다.

## 네이티브 로그 감지

### Gemini CLI

- `.gemini/tmp/*/chats`의 JSONL을 기존 파일 끝에서 감시해 과거 대화를 재생하지 않는다.
- 같은 응답 ID가 텍스트, 도구 호출, 최종 응답 순서로 갱신되는 형식을 병합한다.
- 메인 세션의 사용자 요청, 보이는 응답, 안전한 도구 입력만 표시한다.
- 중첩 subagent 본문은 버리고 부모 작업에 활성 개수만 전달한다.
- 불완전하거나 알 수 없는 JSON은 해당 행만 건너뛴다.

### OpenCode

- `XDG_DATA_HOME` 또는 `~/.local/share/opencode/opencode.db`를 읽는다.
- SQLite 조회는 `worker_threads`에서 실행해 Electron main/UI 루프를 막지 않는다.
- 필요한 JSON 필드만 SQL에서 추출하며 전체 메시지·도구 결과를 renderer로 보내지 않는다.
- `(time_updated, id)` 복합 cursor와 페이지 조회로 같은 millisecond에 많은 이벤트가 생겨도 누락하지 않는다.
- 부모가 있는 세션은 본문을 숨기고 부모 작업의 활성 subagent 개수로만 집계한다.
- 시작 시 DB가 없어도 polling을 유지해 나중에 OpenCode가 설치되거나 DB가 생기면 재시작 없이 연결한다.

## Hook 기반 감지

CodePet은 다음 파일에 자기 항목만 병합한다.

- GitHub Copilot: `${COPILOT_HOME:-~/.copilot}/hooks/codepet.json`
- Cursor: `~/.cursor/hooks.json`
- Windsurf: `~/.codeium/windsurf/hooks.json`

연결 계약:

1. CodePet이 `127.0.0.1` 전용 이벤트 브리지를 시작한다.
2. 무작위 로컬 token을 `0600` 설정 파일에 저장한다.
3. hook은 짧은 timeout으로 이벤트 JSON을 브리지에 전달한다.
4. 브리지는 올바른 경로와 `X-CodePet-Token`이 모두 일치하는 요청만 받는다.
5. 기존 사용자 hook은 유지하고 CodePet 항목만 멱등 병합한다.
6. 기존 JSON이 손상됐으면 원본을 덮어쓰지 않고 연결 오류를 표시한다.

Copilot은 root/main agent의 보이는 마지막 응답만 transcript tail에서 읽는다. reasoning, ephemeral, 도구 출력과 subagent 본문은 표시하지 않는다. Cursor와 Windsurf도 지원 event만 공통 작업 상태로 정규화하며, 중복·늦은 subagent 종료 이벤트가 개수를 흔들지 않게 세션별로 dedupe한다.

CodePet은 단일 인스턴스만 유지한다. 두 번째 실행은 기존 프로세스의 설정창을 열어 hook bridge port와 token이 실행 중 바뀌지 않게 한다. 이미 설치한 hook은 다음 시작 때 현재 bridge 정보로 갱신한다.

## 개인정보와 renderer 경계

- 내부 reasoning/thought와 subagent 메시지 본문은 표시하지 않는다.
- 도구 결과, 원시 API 응답, 자격 파일과 전체 transcript를 renderer로 보내지 않는다.
- 표시 가능한 도구 입력은 `src/activity-redaction.js`에서 한 번 더 정리한다.
- `Authorization`, Bearer/Basic 인증, API-key 헤더, Cookie, 사용자·비밀번호 옵션, 민감 환경변수와 URL query 비밀값을 마스킹한다.
- 개인정보 모드가 `상태만`이면 요청·응답·도구 세부 내용을 숨기고 상태만 유지한다.
- 공급자 하나의 파싱·DB·네트워크 오류는 다른 공급자 활동과 사용량 카드를 지우지 않는다.

## 장기 실행 복구

- watcher 시작 전 기록은 EOF 또는 DB cursor로 seed해 재생하지 않는다.
- 파일이 삭제·재생성되거나 일부 JSONL만 기록돼도 다음 append부터 안전하게 복원한다.
- 완료 timer, 세션 cache, subagent count는 세션 종료와 watcher stop에서 정리한다.
- OpenCode DB 조회 실패는 다음 poll에서 다시 seed하며 Electron main thread 밖에서 처리한다.
- hook의 실패 종료는 성공 완료로 바꾸지 않고 실패 상태로 전달한다.
- 말풍선에서 작업이 제거되면 같은 ID의 다음 작업에 이전 subagent 개수를 재사용하지 않는다.

## 점검 명령

```bash
npm test
git diff --check
xmllint --noout src/provider-icons/*.svg
npm run dist -- --mac
```

패키징 후 `app.asar`에 다음 항목이 포함됐는지 확인한다.

- `src/provider-icons/`
- `src/gemini-watcher.js`
- `src/opencode-watcher.js`
- `src/opencode-db-query.js`
- `src/opencode-db-worker.js`
- `src/provider-hook-bridge.js`
- `src/provider-hook-watcher.js`

로컬에서 실행되는 미서명 패키지 검증은 Apple Developer ID 서명·공증 또는 배포 완료를 뜻하지 않는다.

## 문제 해결

- 공급자가 계정 화면에 없음: 앱·CLI 설치를 확인하고 설정에서 `새로고침`한다.
- CLI가 터미널에서는 보이지만 CodePet에서 없음: 지원 설치 경로에 있는지 확인하고 CodePet을 다시 시작한다.
- hook 공급자 활동이 없음: CodePet을 실행한 상태에서 `계정 추가`로 다시 연결한다.
- hook JSON 오류가 표시됨: 기존 파일 문법을 직접 복구한 뒤 다시 연결한다. CodePet은 손상된 파일을 자동 덮어쓰지 않는다.
- Gemini 사용자 홈을 바꿈: `GEMINI_CLI_HOME`을 설정한 뒤 Gemini와 CodePet을 모두 다시 시작한다.
- OpenCode를 나중에 설치함: CodePet watcher는 자동 재시도한다. 설정의 설치 배지는 `새로고침` 후 갱신된다.
- 사용량 카드가 없음: 해당 공급자가 공식 계정 한도를 제공하지 않거나 로컬 로그인이 확인되지 않은 상태다.
