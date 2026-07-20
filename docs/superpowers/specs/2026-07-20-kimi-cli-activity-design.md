# Kimi CLI 작업 감지 설계

## 배경

CodePet은 Codex, Claude, Antigravity의 로컬 작업 로그를 감시해 작업 제목, 상태, 메시지, 모델 정보와 서브에이전트 수를 펫 말풍선에 표시한다. Kimi Code CLI 0.27.0도 `~/.kimi-code/sessions` 아래에 세션별 구조화 로그를 실시간 기록하므로 같은 화면 계약으로 통합할 수 있다.

## 목표

- Kimi CLI의 여러 메인 세션을 동시에 감지한다.
- 각 작업을 `작업 제목 · 모델 · 추론 강도` 형식으로 표시한다.
- 사용자 요청, 보이는 응답, 도구 실행, 완료 상태를 기존 상태 아이콘과 연결한다.
- Kimi 서브에이전트의 메시지는 숨기고 메인 작업별 활성 개수만 표시한다.
- CodePet 시작 전에 기록된 메시지는 재생하지 않는다.
- 불완전하거나 알 수 없는 Kimi 로그가 CodePet 전체 동작을 막지 않게 한다.

## 범위 제외

- Kimi 계정 로그인, 전환, 삭제
- Kimi 사용량 또는 잔여 한도 조회
- Kimi CLI 실행과 종료 제어
- 과거 세션 내용 탐색 또는 대화 전문 표시

## 선택한 방식

`~/.kimi-code/sessions/*/session_*/agents/*/wire.jsonl`을 직접 감시한다. Kimi 프로세스만 확인하는 방식은 세부 상태를 제공하지 못하고, ACP 또는 로컬 서버 연결은 CodePet이 Kimi 런타임을 별도로 실행하거나 연결 상태를 관리해야 한다. 로컬 JSONL 감시는 현재 CodePet의 Claude·Antigravity 감시 구조와 가장 가깝고 Kimi 실행 방식에 영향을 주지 않는다.

내부 로그 형식은 Kimi 버전에서 바뀔 수 있으므로 파서는 필요한 필드만 선택적으로 읽는다. 알 수 없는 행과 필드는 무시하며 파일 탐색, 파싱, 메타데이터 조회 실패는 해당 poll만 건너뛴다.

## 구성 요소

### `KimiWatcher`

새 `src/kimi-watcher.js`가 세션 탐색과 이벤트 정규화를 담당한다.

- 메인 로그: `agents/main/wire.jsonl`
- 서브에이전트 로그: `agents/<agent-id>/wire.jsonl`
- 세션 메타데이터: 세션 루트의 `state.json`
- 기본 루트: `~/.kimi-code/sessions`

세션 루트의 직접 하위 구조만 탐색하고 메인 `wire.jsonl` 수정 시각 기준 최근 20개 세션을 tail 대상으로 유지한다. 오래된 세션을 다시 이어도 파일 수정 시각이 갱신되므로 다시 대상에 포함된다. poll 주기는 기존 외부 watcher와 같은 1.8초를 사용한다.

메인 로그 이벤트만 CodePet의 `user-message`, `agent-message`, `tool-activity`, `task-finished` 이벤트로 내보낸다. 서브에이전트 로그는 활성 개수 계산에만 사용한다.

### 메타데이터 해석

`state.json`에서 다음 값을 읽는다.

- `title`: `sectionLabel`; 없으면 `workDir`의 마지막 폴더명 사용
- `workDir`: 작업 경로
- `agents`: 메인 세션과 서브에이전트 연결 관계

메인 `wire.jsonl`의 최신 `llm.request`에서 다음 값을 읽는다.

- `modelAlias` 또는 `model`: 모델 표시 이름
- `thinkingEffort`: 추론 강도

표시 이름은 허용 목록으로 정규화한다.

- `kimi-code/k3`, `k3`: `K3`
- `kimi-code/kimi-for-coding`, `kimi-for-coding`: `K2.7 Coding`
- `kimi-code/kimi-for-coding-highspeed`, `kimi-for-coding-highspeed`: `K2.7 Coding Highspeed`
- `low`, `high`, `max`: 기존 추론 강도 표기 규칙 사용

알 수 없는 모델이나 추론 강도는 원문을 노출하지 않고 해당 배지만 숨긴다.

## 이벤트 매핑

- `turn.prompt`의 `origin.kind == "user"`: 사용자 요청
- `context.append_loop_event` / `content.part` / `part.type == "text"`: 같은 turn과 step의 조각을 누적한 보이는 Kimi 응답
- `content.part` / `part.type == "think"`: 항상 무시
- `context.append_loop_event` / `tool.call`: 도구 상태
- `context.append_loop_event` / `step.end` / `finishReason == "end_turn"`: 메인 작업 완료
- `finishReason == "tool_use"`: 중간 단계이므로 완료 처리하지 않음
- `tool.result`: 결과 전문을 말풍선에 노출하지 않음

응답 text는 `(sessionId, turnId, step)`별 버퍼에 순서대로 누적한다. 각 text 이벤트에서는 누적된 문장을 갱신하고, `end_turn` 완료 메시지에는 마지막 누적 응답을 사용한다. `think`는 이 버퍼에 넣지 않는다.

도구 종류는 기존 상태로 정규화한다.

- `Read`, `ReadMediaFile`, `Glob`, `Grep`: 자료 확인
- `Edit`, `Write`: 파일 수정
- `Bash`: 명령 실행; 명령 내용이 안전하게 확인되면 기존 test/build/read 분류 재사용
- `Agent`, `AgentSwarm`, `TaskOutput`: 서브에이전트 상태 갱신
- 그 외: 명령 실행

## 서브에이전트 수명주기

각 세션의 `agents/<agent-id>/wire.jsonl`을 메인 로그와 별도 상태로 감시한다.

- 서브에이전트의 `step.begin` 또는 사용자 prompt가 새로 기록되면 활성 집합에 추가한다.
- `step.end`의 `finishReason == "end_turn"`이면 활성 집합에서 제거한다.
- `tool_use` 종료는 다음 단계가 이어지므로 제거하지 않는다.
- CodePet 시작 시 각 서브에이전트 로그의 마지막 수명주기 이벤트만 읽어 현재 활성 여부를 복원한다. 메시지는 재생하지 않는다.
- 메인 `end_turn`에서 해당 세션의 활성 항목을 모두 제거한다.
- 정상 종료 이벤트 없이 로그가 멈춘 세션은 마지막 메인·서브에이전트 이벤트 후 5분이 지나면 작업과 활성 항목을 함께 제거한다.

메인 작업에는 활성 집합 크기만 `subagentCount`로 전달한다. 서브에이전트의 요청, 응답, 도구 내용은 절대 메인 말풍선 메시지로 전달하지 않는다.

## 데이터 흐름

1. watcher 시작 시 기존 파일의 EOF와 서브에이전트 수명주기만 초기화한다.
2. poll마다 새 세션과 파일 크기 변화를 찾는다.
3. 완성된 JSONL 행만 파싱하고 이벤트 ID로 중복을 제거한다.
4. 메인 이벤트를 CodePet 공통 activity 이벤트로 변환한다.
5. `main.js`가 `registerExternalWatcher(kimiWatcher, "Kimi")`로 기존 말풍선과 상태 아이콘을 재사용한다.
6. `ActivityBubbleState`가 section, model, reasoning, subagent count를 작업별로 보관한다.

## 종료와 오류 처리

- 정상 종료는 메인 `end_turn`을 우선 사용한다.
- 로그가 중단되면 5분 quiet 제한을 실패 안전장치로 사용해 무한 작업 표시를 막는다.
- JSON parse 실패, 파일 교체, truncate, 삭제, 권한 오류는 예외를 외부로 던지지 않는다.
- 파일 truncate 시 offset과 부분 버퍼를 초기화한다.
- 한 세션 오류가 다른 Kimi·Codex·Claude·AGY 세션 상태에 영향을 주지 않는다.

## UI 통합

- 공급자 이름: `Kimi`
- 단일·다중 작업 레이아웃과 전체 작업 수: 기존 공통 렌더러 재사용
- 제목 예시: `ToolFlowy · K3 · Max`
- 상태 아이콘: 요청 확인, 응답 작성, 자료 확인, 파일 수정, 명령 실행, 완료의 기존 아이콘 재사용
- 서브에이전트: 기존 `×N` 배지 재사용
- Kimi 사용량 배지는 표시하지 않는다.

## 테스트

`test/kimi-watcher.test.js`에 다음 계약을 추가한다.

- 사용자 prompt와 text 응답 정규화
- think와 tool result 비노출
- tool 종류 분류
- `end_turn`만 완료 처리
- 제목, 경로, K3, Max 메타데이터 전달
- 알 수 없는 모델과 강도 숨김
- 여러 메인 세션 분리
- 서브에이전트 시작·중간 tool use·완료 개수 변화
- 서브에이전트 메시지 유출 방지
- 기존 로그 재생 방지와 시작 시 활성 개수 복원
- 중복 이벤트, 불완전 JSON, truncate, 파일 삭제 내성

기존 전체 `npm test`도 통과해야 한다.

## 완료 기준

- Kimi CLI에서 새 요청을 보내면 CodePet에 해당 작업이 2회 poll 이내 나타난다.
- 제목이 있으면 `제목 · K3 · Max`가 표시된다.
- 읽기, 수정, 명령, 응답, 완료 상태가 실제 Kimi 이벤트 순서대로 갱신된다.
- 서브에이전트 실행 중에는 작업별 개수가 정확히 표시되고 서브에이전트 메시지는 보이지 않는다.
- Kimi와 기존 공급자를 동시에 실행해도 전체 작업 수와 각 section이 분리된다.
- Kimi가 설치되지 않았거나 로그가 없어도 CodePet이 정상 실행된다.
