# CLI 프로젝트 라벨과 Kimi 5h·7d 사용량 설계

## 목표

CodePet 활동 말풍선에서 CLI가 만든 자동 세션 제목을 사용자 지정 작업명처럼 노출하지 않는다. CLI 작업은 프로젝트 폴더명을 기본 식별자로 사용한다. Kimi Code의 계정 한도는 공식 관리형 사용량 API에서 조회해 Codex와 같은 `5h`, `7d` 남은 퍼센트로 표시한다.

## 표시 규칙

### CLI 작업 제목

- Kimi Code CLI는 `state.json.title`을 표시 제목으로 사용하지 않는다.
- Kimi와 Claude Code CLI는 `cwd`의 마지막 폴더명을 프로젝트명으로 사용한다.
- Codex는 `session_meta.payload.originator`와 `source`로 Desktop과 CLI/exec를 구분한다.
  - Desktop 세션은 기존 app-server 작업 제목 보강을 유지한다.
  - CLI/exec 세션은 app-server 제목을 조회하지 않고 `cwd`의 마지막 폴더명을 사용한다.
- 프로젝트명을 구할 수 없으면 공급자명(`Kimi`, `Claude`, `Codex`)을 사용한다.
- 최종 제목은 `프로젝트명 · 모델 · 강도` 순서다. 상태 문구는 기존 아이콘의 접근성 이름과 본문에 유지한다.
- Antigravity는 데스크톱 공급자이므로 현재 제목 정책을 유지한다.

### 공급자별 사용량 배지

- 사용량 배지는 집계 헤더가 아니라 해당 공급자의 첫 번째 보이는 작업 섹션 오른쪽에 표시한다.
- 같은 공급자의 작업이 여러 개여도 첫 섹션에만 한 번 표시한다.
- 단일 작업 말풍선에서도 표시한다.
- Codex와 Kimi가 동시에 작업하면 각 공급자의 첫 섹션에 자기 배지를 표시한다.
- 표시 형식은 `5h 72%`, `7d 41%`이며 값은 남은 비율이다.
- 접근성 이름은 `Kimi 5시간 72% 남음`, `Kimi 7일 41% 남음`처럼 공급자와 기간을 포함한다.
- 유효한 한도가 하나뿐이면 그 배지만 표시하고, 둘 다 없으면 배지 영역을 만들지 않는다.

## Kimi 사용량 데이터

Kimi Code CLI 0.27.0의 `/usage` 구현과 동일한 관리형 API를 사용한다.

- 사용량 URL: `https://api.kimi.com/coding/v1/usages`
- 자격정보: `~/.kimi-code/credentials/kimi-code.json`
- OAuth 갱신 URL: `https://auth.kimi.com/api/oauth/token`
- OAuth client ID와 장치 헤더는 설치된 Kimi Code의 공개 클라이언트 계약을 따른다.
- `usage` 요약은 7일 한도로, `limits`의 5시간 window는 5시간 한도로 정규화한다.
- 남은 비율은 `round((limit - used) / limit * 100)`을 `0..100`으로 제한해 계산한다.
- 이름 문자열만 신뢰하지 않고 window의 duration/timeUnit도 함께 사용한다.

공식 근거:

- Kimi Code 멤버십은 7일 주기 한도와 5시간 롤링 한도를 제공한다: <https://www.kimi.com/code/docs/en/kimi-code/membership.html>
- `/usage`는 토큰, 컨텍스트, 계정 한도 정보를 제공한다: <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html>

## 인증과 보안

- 자격정보와 응답 원문은 Electron 메인 프로세스 밖으로 전달하지 않는다.
- renderer에는 정규화된 `key`, `remainingPercent`, `ariaLabel`만 전달한다.
- 토큰, API 응답, 사용자 식별자는 로그와 오류 문구에 포함하지 않는다.
- access token이 충분히 유효하면 읽기만 하고 사용량을 조회한다.
- 갱신이 필요하면 Kimi CLI와 같은 `~/.kimi-code/oauth/kimi-code.lock` 잠금 규약을 사용해 refresh token 회전을 직렬화한다.
- 잠금 획득 후 자격정보를 다시 읽어 다른 프로세스의 갱신 결과를 우선 사용한다.
- 갱신 결과는 `0600` 임시 파일을 `fsync`한 뒤 원자적으로 rename하고, 새 refresh token이 없으면 기존 값을 보존한다.
- 인증 거부 시 자격정보를 임의 삭제하지 않는다. 배지만 숨기고 재로그인 필요 상태로 격리한다.
- 네트워크 요청은 8초 안에 중단한다.

## 상태와 데이터 흐름

1. watcher context에 `provider`, `clientKind`, `cwd`를 안전한 표시 메타데이터로 전달한다.
2. `ActivityBubbleState`는 각 작업의 공급자와 섹션별 사용량 배지를 보존한다.
3. Codex 사용량 controller는 기존 `5h/7d` 정규화를 재사용하되 결과를 `codex` 공급자에 연결한다.
4. Kimi 작업 수가 `0 → 1`이 되면 Kimi 사용량을 즉시 조회한다.
5. Kimi 작업이 있는 동안 최대 60초에 한 번 갱신한다. 동시에 여러 작업이 시작돼도 하나의 in-flight 요청만 사용한다.
6. 사용량 변경 시 Kimi의 첫 번째 보이는 섹션에만 배지를 붙여 말풍선을 다시 그린다.
7. Kimi 작업이 모두 끝나면 polling을 중단하고 화면의 Kimi 배지를 제거한다.
8. 조회 실패는 활동 메시지와 watcher 상태에 영향을 주지 않는다. 다음 주기에서 다시 시도한다.

## 구성 요소

- `src/kimi-usage.js`
  - 자격정보 읽기, 필요 시 안전한 갱신, `/usages` 호출, 5h·7d 정규화
- `src/kimi-watcher.js`
  - 자동 title 대신 프로젝트 폴더명 생성, Kimi CLI 공급자 context 전달
- `src/codex-watcher.js`
  - Desktop/CLI source 분류와 CLI 프로젝트 context 전달
- `src/claude-watcher.js`
  - CLI 프로젝트 폴더명을 section context로 전달
- `src/activity-bubble-state.js`
  - provider와 섹션별 usage badge 상태 보존 및 공급자당 첫 섹션 dedupe
- `src/bubble.js`, `src/bubble.css`
  - 단일·다중 섹션 제목 오른쪽의 배지 렌더링과 좁은 폭 처리
- `src/main.js`
  - Kimi 사용량 controller 수명주기, Codex/Kimi 배지 연결, Codex Desktop 제목 보강 제한

## 오류 처리

- 자격정보 없음/손상: Kimi 활동은 표시하고 사용량 배지만 숨긴다.
- custom Kimi provider 또는 관리형 URL이 아님: 계정 한도를 조회하지 않는다.
- 401/403: 잠금 안에서 자격정보 재확인 및 한 번의 안전한 갱신 후 실패를 격리한다.
- 404: 관리형 사용량 API를 지원하지 않는 구성으로 보고 배지를 숨긴다.
- 429/5xx/timeout: 현재 배지를 유지하고 다음 polling 주기에 재시도한다.
- 잘못된 `used`, `limit`, duration: 해당 window만 제외한다.

## 테스트

- Kimi payload의 5시간 window와 7일 summary를 남은 퍼센트로 변환한다.
- 누락·문자열 숫자·범위 초과·잘못된 duration을 안전하게 처리한다.
- 만료 전에는 자격 파일을 쓰지 않고, 만료 시 잠금 후 최신 자격정보를 다시 읽는다.
- 갱신 토큰 회전과 원자 저장을 보존하며 민감값을 반환 객체와 오류에 넣지 않는다.
- 동시 조회는 하나로 합치고 polling 시작·중단을 검증한다.
- Kimi 자동 title은 무시하고 프로젝트 폴더명을 표시한다.
- Codex Desktop 제목은 유지하고 Codex CLI/exec는 프로젝트 폴더명을 표시한다.
- Claude CLI는 프로젝트 폴더명을 표시한다.
- 단일·다중 말풍선에서 공급자별 첫 섹션에만 `5h/7d` 배지를 렌더링한다.
- Codex와 Kimi 동시 작업에서 배지가 서로 섞이거나 덮어쓰이지 않는다.
- 전체 기존 watcher, privacy, renderer, usage 회귀 테스트를 실행한다.

## 범위 밖

- Kimi 계정 전환·삭제 UI
- Kimi 세션 컨텍스트 토큰 비율
- Kimi Extra Usage 잔액과 월간 과금 한도
- CLI TUI를 자동 조작해 `/usage` 화면 텍스트를 파싱하는 방식
- 관리형 Kimi Code가 아닌 사용자 지정 provider의 사용량 추정
