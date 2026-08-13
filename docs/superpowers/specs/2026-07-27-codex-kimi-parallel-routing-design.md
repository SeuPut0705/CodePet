# Codex 앱의 OpenAI·Kimi 병렬 모델 라우팅 설계

## 목표

CodePet을 사용하는 Codex 데스크톱 앱에서 OpenAI 모델과 사용자의 기존 Kimi Code 관리형 계정 모델을 작업별로 선택해 동시에 사용한다. Kimi API 키를 새로 요구하지 않고 `~/.kimi-code`의 기존 OAuth 로그인을 안전하게 재사용한다.

이 기능은 전역 공급자 전환이 아니다. 각 Codex 요청의 `model` 식별자를 기준으로 CodePet 로컬 게이트웨이가 독립적으로 업스트림을 선택한다. 따라서 한 작업은 OpenAI 모델로 스트리밍하는 동안 다른 작업은 Kimi 모델로 스트리밍할 수 있다.

## 사용자 경험

- Codex 앱의 기존 모델 선택기에 CodePet이 지원하는 Kimi 모델이 함께 나타난다.
- 새 작업에서 Kimi 모델을 선택하면 그 작업의 요청만 Kimi 관리형 API로 전송한다.
- OpenAI 모델을 선택한 기존 작업과 설정은 현재 동작을 유지한다.
- 여러 작업이 동시에 실행되어도 요청별 모델 선택이 서로 영향을 주지 않는다.
- Kimi 오류가 나도 OpenAI로 몰래 대체하지 않는다. 실패한 Kimi 작업에만 공급자 오류를 반환한다.
- Kimi 모델 사용을 위한 별도 API 키 입력 UI나 전역 토글은 추가하지 않는다.

## 선택한 접근

### 모델 인식 CodePet 게이트웨이와 병합 모델 카탈로그

```text
Codex 데스크톱 앱
        │  Responses API 요청(model 포함)
        ▼
CodePet 로컬 게이트웨이 127.0.0.1:10161
        ├─ OpenAI 모델 ── 현재 ChatGPT Codex 업스트림
        │                 현재 계정 인증·한도 확인·계정 전환 유지
        └─ Kimi 모델 ──── Responses ↔ Chat Completions 변환기
                          기존 Kimi Code OAuth
                          https://api.kimi.com/coding/v1
```

Codex 앱은 현재와 같이 CodePet의 Responses 엔드포인트만 본다. CodePet은 요청 본문을 읽은 뒤 허용된 Kimi 모델 식별자만 Kimi 경로로 보내고, 나머지는 기존 OpenAI 경로로 보낸다.

Kimi Open Platform과 Kimi Code 관리형 공급자는 OpenAI 호환 Chat Completions 계약을 제공하지만 현재 Codex 사용자 지정 공급자는 Responses API를 전제로 한다. 따라서 단순 Base URL 교체가 아니라 CodePet 내부의 명시적인 프로토콜 변환 계층이 필요하다.

Codex 데스크톱은 내장 OpenAI 공급자에서 Responses WebSocket을 사용할 수 있다. CodePet은 사용자 config에 자기 소유의 `codepet` 공급자를 등록하고 `wire_api = "responses"`, `requires_openai_auth = true`, `supports_websockets = false`를 지정한다. 이 공급자는 모든 요청을 기존 로컬 HTTP 게이트웨이로 보내되, 업스트림 선택은 여전히 요청별 모델로 결정한다. OpenAI와 Kimi 중 하나를 전역 선택하는 상태는 생기지 않는다.

## 검토한 대안

### 전역 공급자 설정 전환

`~/.codex/config.toml`의 기본 공급자와 URL을 OpenAI 또는 Kimi 중 하나로 바꾸는 방식이다. 구현은 단순하지만 실행 중인 모든 작업에 영향을 주고, OpenAI와 Kimi를 병렬로 사용할 수 없다. 기존 작업이 의도하지 않은 공급자로 전송될 위험이 있어 채택하지 않는다.

### CC Switch와 Kimi Platform API 키

Kimi의 공식 Codex 가이드처럼 별도 로컬 라우터를 두고 Platform API 키를 사용하는 방식이다. Codex CLI에는 적합하지만 CodePet 프록시와 포트·설정 소유권이 겹치며, 사용자가 이미 로그인한 Kimi Code 계정과 별도의 키 관리가 필요하다. 이번 제품 통합에는 채택하지 않는다.

### 모델 인식 CodePet 게이트웨이

현재 Codex 연결과 OpenAI 계정 전환을 그대로 두고 요청별 모델 식별자만으로 라우팅한다. 한 앱에서 병렬 사용이 가능하고 Kimi 자격정보를 Electron 메인 프로세스에 격리할 수 있어 이 방식을 채택한다.

## Kimi 모델 식별자

CodePet은 임의의 `model` 문자열을 Kimi로 전달하지 않는다. 다음 고정 매핑 중 현재 Kimi Code 설정에 존재하는 모델만 노출하고 허용한다.

| Codex 모델 식별자 | 표시 이름 | Kimi 업스트림 모델 |
| --- | --- | --- |
| `codepet-kimi-k3` | `Kimi K3` | `k3` |
| `codepet-kimi-k3-256k` | `Kimi K3 256K` | `k3-256k` |
| `codepet-kimi-k2-7-coding` | `Kimi K2.7 Coding` | `kimi-for-coding` |
| `codepet-kimi-k2-7-coding-fast` | `Kimi K2.7 Coding Fast` | `kimi-for-coding-highspeed` |

- 설치된 `~/.kimi-code/config.toml`에서 관리형 `kimi-code` 공급자와 실제 모델 별칭을 읽는다.
- 관리형 Base URL이 아니거나 모델이 없으면 해당 항목을 Codex 모델 카탈로그에 넣지 않는다.
- 컨텍스트 크기와 지원 reasoning 강도는 Kimi 설정의 현재 모델 메타데이터를 우선하되 안전한 상한과 허용값으로 검증한다.
- 모델 식별자와 업스트림 매핑은 자격정보가 아니므로 카탈로그에 기록할 수 있다. 토큰, 계정 ID, 사용량 원문은 기록하지 않는다.

## Codex 모델 카탈로그 연동

Codex 앱, CLI, IDE는 사용자 단위 `~/.codex/config.toml`을 공유한다. CodePet은 Codex의 내장 모델 카탈로그를 복사한 뒤 Kimi 항목을 병합한 별도 JSON 카탈로그를 CodePet `userData` 아래에 원자적으로 생성한다.

1. 현재 실행 가능한 Codex CLI의 `debug models --bundled` 결과를 읽는다.
2. 원래 OpenAI 모델 항목을 순서와 내용 그대로 보존한다.
3. 현재 사용 가능한 Kimi 모델 항목을 추가한다.
4. 임시 파일을 쓰고 검증한 뒤 rename하여 완성되지 않은 JSON 노출을 막는다.
5. CodePet이 소유한 표시가 있는 `model_catalog_json`, `model_provider = "codepet"`, `[model_providers.codepet]` 설정을 사용자 config에 연결한다.

Kimi 항목은 Codex 에이전트가 필요한 기본 instructions·tool capability 필드를 호환되는 내장 모델 항목에서 가져오되, `slug`, 표시 이름, 설명, reasoning 강도, 컨텍스트 크기, 서비스 계층과 노출 상태는 Kimi 계약으로 덮어쓴다. 카탈로그 생성 실패 시 기존 OpenAI 모델 목록과 프록시 동작은 바꾸지 않는다.

사용자가 이미 직접 `model_catalog_json`, `model_provider` 또는 `[model_providers.codepet]`을 설정한 경우 CodePet은 이를 덮어쓰지 않는다. 이때 병합 기능을 비활성화하고 설정 화면 또는 진단 로그에 충돌 해결 안내를 남긴다. 사용자 설정 파일을 수정할 때는 전체 TOML 재직렬화로 주석과 순서를 훼손하지 않고 CodePet 소유 블록만 추가·갱신한다. 이전 CodePet 버전의 `openai_base_url` 마커는 안전하게 제거해 새 공급자 블록으로 이전한다.

Codex는 카탈로그를 시작할 때 읽으므로 모델 목록 변경에는 Codex 앱 재시작이 필요하다. CodePet은 활성 프록시 연결이 하나라도 있으면 Codex를 종료하거나 재시작하지 않는다. 현재 작업이 프록시에 연결된 상태에서는 새 카탈로그만 준비하고, 안전한 종료 시점 또는 별도 격리된 테스트 인스턴스에서 재시작·화면 검증을 수행한다.

## 요청 라우팅

`src/codex-proxy.js`의 외부 HTTP 계약과 기존 OpenAI 경로는 유지한다. `/v1/responses` POST 본문에서 모델을 판별할 수 있을 만큼만 요청을 제한된 크기로 버퍼링한다.

- 허용된 `codepet-kimi-*` 모델이면 Kimi 변환기로 전달한다.
- 그 외 모델은 현재 ChatGPT Codex 업스트림과 계정 전환 경로로 그대로 전달한다.
- Kimi 경로는 Codex 계정 토큰, OpenAI 한도 판정, OpenAI 계정 전환을 사용하지 않는다.
- Kimi와 OpenAI 업스트림 연결 모두 기존 활성 연결 수와 안전 종료 drain에 포함한다.
- 클라이언트가 연결을 끊거나 요청을 취소하면 해당 업스트림 요청도 즉시 중단한다.
- 알 수 없는 `codepet-kimi-*` 식별자는 OpenAI로 전달하지 않고 명확한 모델 미지원 오류로 닫는다.

요청별 라우팅이므로 전역 현재 공급자 상태는 만들지 않는다. 동시에 들어온 요청은 서로 다른 인증 헤더와 업스트림 연결을 독립적으로 가진다.

## Kimi OAuth 재사용

기존 `src/kimi-usage-client.js`의 자격정보 읽기와 OAuth 갱신 규약을 공통 인증 구성 요소로 추출하거나 확장한다.

- `~/.kimi-code/credentials/kimi-code.json`의 access token을 Electron 메인 프로세스 안에서만 읽는다.
- 만료가 임박하면 Kimi CLI와 같은 교차 프로세스 잠금을 획득하고, 잠금 안에서 파일을 다시 읽은 뒤 필요할 때만 갱신한다.
- 토큰 회전 결과는 기존과 같이 권한이 제한된 임시 파일, `fsync`, 원자 rename으로 저장한다.
- Kimi 추론 요청이 401 또는 403을 반환하면 최신 자격정보 재확인과 강제 갱신을 한 번만 수행한 뒤 한 번 재시도한다.
- 관리형 Kimi Code endpoint와 설치된 클라이언트가 요구하는 장치 헤더를 현재 공개 클라이언트 계약과 동일하게 보낸다.
- access token, refresh token, 계정 식별자, 원문 응답은 renderer, 모델 카탈로그, 일반 로그와 오류 메시지에 포함하지 않는다.

OAuth 로그인이 없거나 손상되었으면 OpenAI 경로는 계속 동작한다. Kimi 모델 요청만 재로그인이 필요하다는 인증 오류를 반환한다.

## Responses와 Chat Completions 변환

프로토콜 변환은 `codex-proxy.js`에 직접 누적하지 않고 독립 모듈로 둔다.

- `src/kimi-codex-models.js`
  - 허용 모델 매핑, Kimi 설정 발견, 카탈로그용 모델 메타데이터
- `src/codex-model-catalog.js`
  - Codex 내장 카탈로그 읽기, Kimi 항목 병합, 원자 저장, 사용자 config 소유 블록 관리
- `src/kimi-codex-adapter.js`
  - Responses 입력을 Kimi Chat Completions 요청으로 변환
  - Kimi 스트리밍 청크를 Responses SSE 이벤트로 변환

### 입력 변환

초기 지원 범위는 Codex 에이전트 루프에 필요한 다음 항목이다.

- system, developer, user, assistant 텍스트 메시지
- 사용자 메시지의 지원되는 이미지 입력
- function tool 선언, 이름, 설명, JSON Schema 매개변수
- assistant function call과 이후 function call output
- 요청의 stream, temperature 등 양쪽 계약에 공통이고 안전한 옵션
- Kimi 모델 카탈로그에 노출한 low, high, max reasoning 강도

Responses 전용이면서 Kimi가 지원하지 않는 옵션은 조용히 의미를 바꾸지 않는다. 실행에 필수인 옵션이면 요청 전에 명시적 미지원 오류를 반환하고, 선택적 힌트면 정해진 허용 목록에 따라 생략한다.

### 출력 변환

Kimi SSE 청크를 Codex 클라이언트가 소비하는 Responses 이벤트 순서로 변환한다.

- `response.created`
- 메시지 또는 function call의 `response.output_item.added`
- 텍스트의 `response.content_part.added`, `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`
- tool call의 `response.function_call_arguments.delta`, `response.function_call_arguments.done`
- 각 항목의 `response.output_item.done`
- 사용량과 완료 상태를 포함한 `response.completed`

업스트림 오류, 잘못된 SSE, 조기 종료는 성공 이벤트로 꾸미지 않고 Responses 오류로 변환한다. 출력 ID와 call ID는 한 응답 안에서 안정적으로 유지한다. 토큰 사용량은 의미가 대응되는 필드만 매핑하고 추정값을 확정값처럼 만들지 않는다.

Kimi의 `reasoning_content`는 Codex 화면, 일반 로그, 오류 또는 테스트 스냅샷에 노출하지 않는다. Kimi 공식 클라이언트에서 raw reasoning을 다음 요청에 되돌려 보내는 `thinking.keep = "all"` 옵션도 사용하지 않는다. 매 요청마다 thinking은 활성화하되 보존 모드를 요청하지 않고, 사용자에게 보여 줄 최종 텍스트와 tool call만 Responses 출력으로 보낸다.

## 동시성, 취소와 종료

- Kimi 토큰 갱신은 여러 동시 요청이 있어도 하나의 in-flight 작업으로 합친다.
- 토큰을 얻은 뒤의 추론 스트림은 요청별로 독립 실행한다.
- OpenAI와 Kimi 연결은 모두 `CodexProxyShutdownCoordinator`가 세는 실제 HTTP 스트림에 포함한다. 새 CodePet 공급자는 WebSocket을 비활성화하지만 이전 내장 공급자로 이미 연결된 WebSocket은 기존 원시 터널과 종료 집계가 계속 처리한다.
- 앱 종료 요청 시 새 연결을 받지 않고 기존 스트림을 drain한다.
- 정해진 종료 유예시간 이후에는 남은 업스트림을 취소하고 원인을 진단 로그에 남기되 토큰이나 프롬프트 내용은 남기지 않는다.
- Kimi 스트림 하나의 실패나 취소가 다른 Kimi 또는 OpenAI 스트림을 중단하지 않는다.

## 오류 처리

- Kimi 로그인 없음/손상: Kimi 요청에만 인증 오류를 반환하고 OpenAI는 유지한다.
- Kimi 설정에 모델 없음: 카탈로그에서 제외하고 직접 요청은 모델 미지원으로 거부한다.
- 사용자 모델 카탈로그 충돌: 사용자 값을 보존하고 Kimi 선택기 연동을 비활성화한다.
- 내장 카탈로그 조회 또는 병합 실패: 기존 config를 수정하지 않고 OpenAI 전용 상태를 유지한다.
- Kimi 401/403: 잠금 안에서 자격정보를 재확인하고 한 번 갱신·재시도한다.
- Kimi 429: 계정 한도 오류로 반환하되 OpenAI 계정 전환을 실행하지 않는다.
- Kimi 5xx/timeout/잘못된 SSE: 해당 요청만 실패시키고 자동 공급자 대체를 하지 않는다.
- 클라이언트 연결 종료: Kimi 업스트림을 취소하고 활성 연결 수를 정확히 줄인다.
- 요청 본문 제한 초과 또는 잘못된 JSON: 업스트림에 보내기 전에 4xx로 거부한다.

## 테스트 전략

기능 코드는 실패하는 테스트를 먼저 추가하는 TDD 순서로 구현한다.

### 모델과 카탈로그

- 네 개 고정 Kimi 식별자를 정확한 업스트림 모델로 매핑한다.
- 설치된 관리형 모델만 노출하고 임의 모델과 사용자 지정 Base URL은 거부한다.
- 내장 OpenAI 카탈로그를 손실·변형 없이 보존한다.
- Kimi 카탈로그 항목의 slug, 표시 이름, reasoning 강도, 컨텍스트 크기를 검증한다.
- 원자 파일 교체와 실패 시 원본 보존을 검증한다.
- CodePet 소유 config 블록만 갱신하고 사용자의 기존 `model_catalog_json`과 주석을 덮어쓰지 않는다.

### 인증

- 유효한 기존 access token은 자격 파일 쓰기 없이 재사용한다.
- 만료와 401/403 시 교차 프로세스 잠금, 최신 파일 재확인, 단일 갱신, 한 번 재시도를 검증한다.
- 동시 추론 요청이 하나의 token refresh를 공유한다.
- 반환 객체, 로그, 오류, 카탈로그에 민감값이 없는지 검증한다.

### 프로토콜 변환

- 텍스트·developer/system 메시지·이미지·tool schema를 Chat Completions 입력으로 변환한다.
- assistant tool call과 function call output을 다음 turn에 보존한다.
- 텍스트 delta, 다중 tool call, 분할 JSON 인자, finish reason을 올바른 Responses SSE 순서로 변환한다.
- `reasoning_content`가 사용자 출력과 로그에 나타나지 않고 `thinking.keep = "all"`도 요청하지 않는지 검증한다.
- 잘못된 SSE와 조기 종료가 `response.completed` 성공으로 끝나지 않는지 검증한다.
- 클라이언트 취소가 업스트림 요청을 중단하는지 검증한다.

### 프록시 통합과 회귀

- OpenAI 모델 요청은 기존 업스트림·인증·계정 전환 경로를 그대로 사용한다.
- Kimi 모델 요청은 Kimi OAuth와 어댑터만 사용한다.
- 한 OpenAI 스트림과 한 Kimi 스트림을 동시에 실행해 헤더, 응답, 취소, 연결 수가 섞이지 않는지 검증한다.
- Kimi 429가 OpenAI 계정 전환을 유발하지 않는지 검증한다.
- OpenAI와 Kimi 활성 스트림이 모두 안전 종료 drain을 막고 완료 후 해제되는지 검증한다.
- 전체 기존 테스트, 패키징, 정상 앱 실행을 수행한다.

자동화된 통합 테스트는 토큰과 실제 사용량을 소비하지 않는 로컬 모의 Kimi 서버를 사용한다. 실제 Kimi 추론 1회는 사용량을 소비하므로 별도 사용자 승인 후에만 수행한다.

## 화면과 런타임 검증

코드와 테스트 통과만으로 Codex 앱 모델 선택기 연동을 완료로 판단하지 않는다.

1. 정상 사용자용 CodePet 앱을 새로 패키징한다.
2. 기존 활성 Codex 프록시 스트림이 모두 끝난 것을 확인한다.
3. 정상 앱을 실행해 모델 카탈로그와 config를 준비한다.
4. Codex 앱을 안전하게 다시 열고 모델 선택기에 Kimi 모델이 보이는지 화면으로 확인한다.
5. 격리된 로컬 모의 업스트림으로 Kimi 작업과 OpenAI 작업의 동시 라우팅을 확인한다.
6. 사용자가 실제 호출을 승인하면 최소 프롬프트 1회로 기존 Kimi OAuth의 실동작을 별도 확인한다.

현재 구현을 진행하는 Codex 작업 자체가 `127.0.0.1:10161` 프록시에 연결되어 있으면 그 작업 도중 CodePet 또는 Codex를 강제 재시작하지 않는다. 패키징과 자동 검증을 끝낸 뒤 현재 작업 종료 후 재시작하거나, 별도 `CODEX_HOME`과 포트를 가진 격리 인스턴스로 화면 검증한다.

## 구현 순서

1. Kimi 모델 매핑과 관리형 설정 발견 테스트·모듈을 추가한다.
2. Codex 내장 카탈로그 병합과 config 소유 블록 테스트·모듈을 추가한다.
3. 기존 Kimi OAuth 로직을 추론에서도 재사용하도록 인증 경계를 정리한다.
4. Responses 입력을 Kimi Chat Completions로 바꾸는 테스트·어댑터를 추가한다.
5. Kimi SSE를 Responses 이벤트로 바꾸는 테스트·어댑터를 추가한다.
6. `codex-proxy.js`에 모델별 라우팅과 취소·오류 경계를 연결한다.
7. OpenAI·Kimi 동시 요청과 안전 종료 통합 테스트를 추가한다.
8. 전체 회귀 테스트와 패키징을 수행한다.
9. 활성 작업을 끊지 않는 조건에서 정상 앱과 Codex 모델 선택기를 화면 검증한다.
10. 실제 Kimi 호출은 사용량 소비 승인을 받은 경우에만 검증한다.

## 완료 조건

- 기존 OpenAI 모델과 계정 전환 동작이 회귀하지 않는다.
- Codex 모델 선택기에 설치된 관리형 Kimi 모델만 추가된다.
- 작업별 모델 선택으로 OpenAI와 Kimi 스트림이 동시에 실행된다.
- 두 공급자의 자격정보, 한도 오류와 응답이 서로의 경로에 섞이지 않는다.
- Kimi tool call을 포함한 Codex 에이전트 루프가 Responses 계약으로 정상 진행된다.
- 종료 시 실제 OpenAI·Kimi 스트림이 끝날 때까지 기다리고 새 연결은 받지 않는다.
- 토큰과 원문 추론이 renderer, config, 카탈로그, 로그에 노출되지 않는다.
- 전체 자동 테스트와 사용자용 패키징이 성공한다.
- 정상 Codex 앱의 모델 선택기 노출은 화면으로 확인한다.
- 실제 Kimi 추론은 별도 승인 전까지 미검증 상태로 명확히 구분한다.

## 범위 밖

- Kimi 계정 추가·전환·로그아웃 UI
- Kimi Platform API 키 입력과 저장
- Kimi 실패 시 OpenAI 자동 fallback
- 기존 Codex 작업의 모델 자동 변경 또는 마이그레이션
- Codex 클라우드 실행 환경의 공급자 변경
- Kimi 내장 웹 검색과 별도 MCP 기능 연결
- Kimi의 모든 미래 모델을 검증 없이 자동 노출
- 실제 Kimi 사용량을 소비하는 부하·성능 테스트
