# OpenCodex 엔진 컷오버 설계 (codex-proxy 대체)

## 목표

`src/codex-proxy.js`가 담당하던 Codex Desktop 트래픽(127.0.0.1:10161, Responses API)을 내장 OpenCodex 엔진(`build/generated/opencodex-engine.mjs`, worker thread)으로 전환한다. CodePet이 유지해야 하는 책임은 `~/.codex/config.toml`의 `model_catalog_json` + `openai_base_url` 주입과, 엔진 설정/계정 브리지, 안전 종료뿐이다. 이 문서는 코드 독해가 아니라 임시 샌드박스에서 엔진을 실제로 구동한 실측으로 각 전제를 검증하고, 그 결과로 브리지 설계를 결정한다.

## 조사 방법

`scripts/opencodex/engine-smoke.js`의 패턴을 확장한 실험 하네스를 `os.tmpdir()` 아래에 만들었다(저장소 변경 없음).

- 엔진 번들: `npm run opencodex:build-engine`으로 새로 빌드(3,588,065 bytes).
- 워커: `engine-worker.js`의 사본에 fetch shim을 프리로드한 `spike-worker.js`. `createEngineHost({workerPath})`가 지원하는 옵션이라 `src/`를 건드리지 않는다. shim은 하드코딩된 프로덕션 호스트(`https://chatgpt.com`, `https://auth.openai.com`, `https://api.kimi.com`, `https://auth.kimi.com`)로 나가는 엔진 fetch만 로컬 fixture 서버로 재작성한다.
- fixture: ChatGPT Codex 백엔드(`/backend-api/codex/responses`), 사용량 API(`/backend-api/wham/usage`), 토큰 엔드포인트(`/oauth/token`, `/api/oauth/token`), Kimi(`/coding/v1/chat/completions`)를 흉내 내고 모든 요청을 로깅한다.
- 샌드박스: 실험마다 임시 `OPENCODEX_HOME`/`CODEX_HOME`/`KIMI_CODE_HOME`을 만들고 `config.json`, `codex-accounts.json`, `auth.json`을 직접 쓴다. 실험 포트는 19xxx 대(실행 중인 CodePet의 10161과 무관).
- 실험 스크립트 6개(`exp12`, `exp3`, `exp4`, `exp56`, `exp7`, `exp8910`), 총 44개 단언 전부 통과.

## 실측 결과

### 1. 엔진 config.json 스키마와 최소 풀 설정

**결론**: `OPENCODEX_HOME/config.json` 하나로 provider와 Codex 계정 풀을 선언할 수 있다. 풀 자격 증명은 별도 파일 `OPENCODEX_HOME/codex-accounts.json`에 둔다. ChatGPT 업스트림 base URL은 **설정으로 바꿀 수 없다**(레지스트리 고정, 실측으로 확인).

최소 동작 설정(실험에서 실제 사용):

```json
{
  "port": 0,
  "hostname": "127.0.0.1",
  "openaiProviderTierVersion": 2,
  "defaultProvider": "openai",
  "codexAccounts": [
    { "id": "acct-a", "email": "a@example.com", "isMain": false, "plan": "plus" }
  ],
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward",
      "codexAccountMode": "pool"
    }
  }
}
```

`codex-accounts.json`(레거시 단순 형태도 로더가 정규화함, `vendor/opencodex/src/codex/account-store.ts:63-77`):

```json
{
  "acct-a": {
    "accessToken": "…",
    "refreshToken": "…",
    "expiresAt": 1785000000000,
    "chatgptAccountId": "…"
  }
}
```

**실측 근거**:

- 위 설정 + fixture 업스트림으로 `POST /v1/responses`(`model: "gpt-5.5"`)가 200 SSE로 응답하고, 업스트림에 `Authorization: Bearer token-a`와 `chatgpt-account-id: chatgpt-acct-a`가 전달됨(exp12 `a`).
- `codexAccounts` 메타데이터는 config.json, 자격 증명은 `codex-accounts.json`이라는 이중 구조는 `types.ts:1053-1069`(`CodexAccount` vs `CodexAccountCredentials`)와 `routing.ts:432-451`(`getEligiblePoolAccounts`가 `config.codexAccounts`를 읽음)에서 확인.
- base URL 불변 증명: `providers.openai.baseUrl`을 `http://127.0.0.1:<fixture>/custom-override`로 바꿔도 요청은 `/custom-override`가 아니라 shim 경유 `chatgpt.com/backend-api/codex/responses`로 나감(exp12 `f`). 코드상 registry 항목(`registry.ts:349-357`)이 템플릿도 `allowBaseUrlOverride`도 아니라 `routedProviderConfig`가 사용자 값을 폐기하고 경고만 출력(`router.ts:231-234`).
- `codexAccountMode`는 정규(canonical) openai 형태에서만 저장 가능. 비정규 base URL과 함께 쓰면 스키마 거부 → `config.json.invalid-<timestamp>` 백업 후 기본 설정으로 부팅됨(exp12 `f` 1차 시도에서 실측, `config.ts:630-645`).
- `openaiProviderTierVersion: 2`를 반드시 써야 한다. 없으면 시작 시 tier 마이그레이션이 config.json을 재작성하고 `.pre-openai-tiers-v2.bak`을 만든다. 이후 외부 프로세스가 config.json을 통째로 덮어쓰면 백업과 불일치로 `OpenAiTierBackupCollisionError`("Existing OpenAI tier backup differs from the current config")가 나며 **엔진 시작이 거부**된다(exp8910 `10e` 1차 시도에서 실측).

**컷오버에의 영향**: CodePet은 엔진 시작 전 위 형태의 config.json(+`openaiProviderTierVersion: 2`)을 원자적으로 기록하고, 시작 후에는 파일을 건드리지 않는다. ChatGPT 업스트림을 가리킬 수 없으므로 프로덕션 경로 테스트는 실제 OAuth 자격 증명 또는 관리 API의 fixture가 필요하다.

### 2. 다중 ChatGPT 계정과 우선순위, 라이브 변경

**결론**: 풀은 여러 ChatGPT OAuth 계정을 가진다. 선택은 "최저 사용량 점수"(동점이면 config.json `codexAccounts` 배열 순서)다. `codex-accounts.json`의 **자격 증명 갱신은 재시작 없이 즉시 반영**되지만, config.json의 **계정 목록 추가는 파일 편집으로는 반영되지 않는다**(인메모리 설정은 시작 시 1회 로드). 계정 추가·선택 같은 라이브 조작은 관리 API로 가능하다.

**실측 근거**(exp12):

- 사용량 10% vs 20% 계정 둘 중 첫 요청은 10% 계정으로 라우팅됨. 시작 시 `primeCodexPoolQuotas`가 계정당 `/backend-api/wham/usage`를 호출해 점수를 만든다(2회 호출 실측, `server/index.ts:865-879`).
- `codex-accounts.json`을 외부에서 덮어써 토큰을 `token-a`→`token-a2`로 바꾸자 **다음 요청부터** `Bearer token-a2`가 나감(재시작 없음). 저장소는 요청마다 디스크에서 읽는다(`account-store.ts:79-96` 캐시 없음, `oauth/store.ts:284-288`도 동일 패턴).
- config.json 파일에 `acct-c`를 추가필 후 요청 → 여전히 `token-a2`. 인메모리 설정 미반영 확인.
- `POST /api/codex-auth/accounts`(환경변수 `OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT=1` 필요, `auth-api.ts:161-170`)로 계정 추가 → 200. 이 API는 추가 전에 실제 ChatGPT에 warmup 요청을 본다(`auth-api.ts:172-198`, fixture가 통과시킴). 추가 후 `PUT /api/codex-auth/active {"accountId":"acct-c"}` → 다음 요청이 `Bearer token-c`로 나감. **재시작 없는 라이브 추가·선택 확인**.
- 주의: quota 미프라임 계정은 점수 100(unknown)이라 임계치(기본 80) 자동 전환 규칙이 끼어들어 방금 선택한 계정에서 튕길 수 있다. `GET /api/codex-auth/accounts?refresh=1`로 사용량을 프라임한 뒤 선택해야 한다(exp12에서 실제로 한 번 튕김을 관측).
- 엔진이 `activeCodexAccountId`를 config.json에 **스스로 기록**한다(`routing.ts:484-488` → `saveConfigPreservingClaudeCode`). 첫 요청 후 디스크의 config.json에 `"activeCodexAccountId": "acct-a"`가 추가돼 있었다.

**컷오버에의 영향**: CodePet 프로필 저장소 → 엔진 풀 매핑은 "시작 시 파일 시드 + 실행 중 조작은 관리 API"의 이중 경로가 된다. 토큰 값 갱신(재로그인, grant 회전 반영)은 파일 쓰기만으로 라이브 반영된다. 외부에서 config.json을 편집해 계정을 추가하는 방식은 쓸 수 없다.

### 3. 업스트림 429 동작

**결론**: 엔진은 429를 무조건 quota류로 분류해 해당 계정에 하드 쿨다운을 걸고 **다음 요청부터** 다른 계정으로 회전한다. **요청 중 재시도(동일 요청의 타계정 failover)는 없고**, CodePet proxy처럼 **사용량 API로 소진을 검증하는 절차도 없다**(429 전후 `/wham/usage` 호출 0회 실측). 쿨다운 길이는 `Retry-After` 헤더 > `x-codex-{primary,secondary,tertiary}-reset-at` 헤더 > 기본 60초 순이다. 후보가 없으면 업스트림 호출 없이 로컬에서 `429 + Retry-After`를 반환한다. 쿨다운 해제 API(`POST /api/codex-auth/accounts/clear-cooldown`)가 있다.

**실측 근거**(exp3):

- acct-a가 429 → 클라이언트도 429를 그대로 받음, 업스트림 시도 정확히 1회(동일 요청 재시도 없음). 이 결정 지점은 `recordCodexUpstreamOutcome`의 quota 분기(`codex/routing.ts:769-799`)와 호출부(`server/responses/core.ts:1296-1304`, retryAfter와 reset 헤더를 메타로 전달).
- 다음 요청은 acct-b로 200. `activeCodexAccountId`가 디스크에서 `acct-b`로 뒤집힘(`routing.ts:794-797`).
- 단일 계정 풀에서 429 후 재요청 → 업스트림 호출 증가 없이 429, `Retry-After: 60`, 본문 "Selected Codex account (…) is cooling down until … (source: default)"(`auth-context.ts:128-142`의 `cooldownErrorResponse`).
- `POST /api/codex-auth/accounts/clear-cooldown {"id":"acct-a"}` → `{"ok":true,"id":"acct-a","cleared":true}`, 다음 요청이 다시 업스트림에 도달(`routing.ts:349-368`).
- 코드상 추가 사실: `retry-after` 명시 쿨다운은 프로브 불가, reset 유도/기본 쿨다운은 5분 간격 단일 프로브 요청으로 조기 회복을 시도(`routing.ts:237-260`, #433). 일시 5xx/연결 오류는 소프트 회피(30초→2분→10분→30분 에스컬레이션, `routing.ts:79-85`).

**컷오버에의 영향**: 2026-07-27 문서의 완료 조건 "모호한 429는 계정 소진으로 판단하지 않는다"와 **엔진 기본 동작이 충돌**한다. 엔진은 일시 429도 60초 쿨다운+회전으로 처리한다. 완화 수단은 §결정 사항 2 참조.

### 4. ChatGPT 토큰 refresh

**결론**: 엔진이 풀 계정의 만료된 ChatGPT 액세스 토큰을 **스스로** 갱신한다. 게다가 시작 시 quota 프라이밍 단계에서 **요청 전에 먼저** 갱신한다. 엔드포인트는 하드코딩 `https://auth.openai.com/oauth/token`, client id `app_EMoamEEZ73f0CkXaXp7hrann`, `grant_type=refresh_token`이며 **설정으로 바꿀 수 없다**. 갱신된 자격 증명(회전된 refresh token 포함)은 `codex-accounts.json`에 generation CAS로 쓰여진다. 갱신 실패(revoked/expired grant)는 계정을 `needsReauth`로 표시하고 사용 가능 계정이 없으면 클라이언트에 401을 반환한다.

**실측 근거**(exp4):

- 만료 토큰으로 엔진 시작 → 첫 클라이언트 요청 전에 이미 refresh 1회 발생(프라이밍, `server/index.ts:865-879` → `getValidCodexToken`, `account-store.ts:319-435`).
- fixture가 받은 refresh 요청 본문: `grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=rt-good`(`account-store.ts:212-213, 390-399`). 이 호스트도 shim이 필요했으므로 "설정 불가"가 실측으로 입증됐다.
- 갱신 후 `codex-accounts.json`: `generation: 1`, `accessToken: refreshed-1-for-rt-good`, `refreshToken: rt-good-rotated`(`account-store.ts:414-423`). 유효 기간 내 추가 요청은 refresh 0회.
- revoked grant: 프라이밍 때 `invalid_grant` → `needsReauth: true`(`GET /api/codex-auth/accounts`에 `health.status: "reauth_required"`로 표면화) → 요청 시 401 `authentication_error`, 업스트림 호출 0회.
- 파일 락(`codex-refresh-*.lock`)과 generation CAS, 동일 grant의 타계정 fresh 자격 재사용까지 구현돼 있다(`account-store.ts:265-317`).

**컷오버에의 영향**: `refreshAuthFileIfStale`(src/codex-proxy.js:1100)는 엔진 관리 계정에 대해 **폐기**한다. 단, 엔진이 grant를 회전하므로 CodePet 프로필 저장소는 엔진의 `codex-accounts.json`을 읽어 최신 grant를 **역동기화**해야 한다. 그렇지 않으면 CodePet이 오래된 refresh token으로 다음 시드를 만들어 회전 충돌을 일으킨다.

### 5. 모델 id 매핑과 임의 슬러그 별칭

**결론**: 임의 슬러그(예: `codepet-kimi-k2`)를 특정 provider/모델로 별칭할 수 있다. 수단은 config.json의 `combos`(가상 모델)다. 요청 slug → combo → `kimi/kimi-k2.7-code`로 라우팅되고 **업스트림에는 타깃 모델 id가 그대로** 나간다. 별칭은 `GET /v1/models`에도 광고된다.

**실측 근거**(exp56):

- 설정: `"combos": { "k2": { "alias": "codepet-kimi-k2", "targets": [{ "provider": "kimi", "model": "kimi-k2.7-code" }] } }`.
- `POST /v1/responses` `model: "codepet-kimi-k2"` → 200, fixture가 받은 업스트림 본문의 `model`은 `kimi-k2.7-code`.
- `GET /v1/models` 응답에 `"codepet-kimi-k2"` 포함(그 외 `kimi/k3`, `kimi/kimi-k2.7-code` 등 네임스페이스 id도 나열).
- 라우팅 우선순위: combo가 가장 먼저 평가(`router.ts:308-318`), bare 별칭은 `gpt-`/`o1-`/`o3-`/`o4-`/`codex-` 접두만 금지(`combos/types.ts:24-38`). `codepet-kimi-*`는 규칙에 걸리지 않는다.

**컷오버에의 영향**: `codepet-kimi-*` 슬러그 매핑은 별도 어댑터 없이 **config.json combos 선언으로 완결**된다. CodePet은 Kimi 모델별로 combo를 하나씩 생성하고, `model_catalog_json` 주입값과 같은 슬러그를 맞추면 된다. 단 Kimi provider의 baseUrl도 레지스트리 고정(`registry.ts:464-483`)이라 엔드포인트 오버라이드는 불가다.

### 6. Kimi provider 401 동작 (refresh: "" 브리지 조건)

**결론**: 만료된 액세스 토큰 + `refresh: ""`이면 엔진은 refresh를 **시도**하고(빈 refresh_token을 `https://auth.kimi.com/api/oauth/token`에 전송), `invalid_grant`류 응답을 종단 오류로 판정해 계정을 `needsReauth`로 표시한 뒤 클라이언트에 401을 돌려준다. 재시도나 대체 경로는 없다. 그러나 **auth.json은 요청마다 디스크에서 다시 읽히므로** CodePet이 자격 증명 파일을 재동기화하면 재시작 없이 다음 요청이 성공한다. 파일상 유효한 토큰인데 업스트림이 401을 돌린 경우엔 force-refresh/재전송 없이 401이 그대로 전파된다(kimi는 401-replay 대상 provider가 아님).

**실측 근거**(exp56):

- 6d: 만료 + `refresh: ""` → fixture에 `refresh_token=`(빈 값)이 도착 → 400 `invalid_grant` → 클라이언트 401 `"Kimi token refresh failed: 400: refresh token expired"`, Kimi 업스트림 호출 0회(`oauth/index.ts:205-238, 377-417`, `oauth/kimi.ts:200-211`).
- 6e: `syncKimiCliCredential`로 새 토큰 재동기화(어댑터가 `needsReauth` 플래그를 지우고 예약 슬롯을 덮어씀, `src/open-codex/kimi-credential-adapter.js:247-260`) → **같은 엔진 프로세스에서** 다음 요청 200.
- 6f: 파일상 유효 + 업스트림 401 → 401 `authentication_error` 그대로, oauth 호출 증가 0, 업스트림 시도 1회. 401-replay는 `xai`/`github-copilot`/`kiro`뿐(`oauth/index.ts:246-254`, `server/responses/core.ts:1738-1770`).

**컷오버에의 영향**: Kimi 401에 대한 엔진 측 훅/이벤트는 없다. 재동기화 트리거는 CodePet이 소유해야 한다(§결정 사항 5). 라이브 재읽기가 보장되므로 트리거 후 별도 엔진 재시작은 필요 없다.

### 7. Responses-over-WebSocket

**결론**: WS 업그레이드가 fixture 업스트림까지 end-to-end로 동작한다. 게이트는 config.json의 `"websockets": true` 하나다(`websocketsEnabled`, `config.ts:861-863`). 미설정이면 업그레이드는 426 `upgrade_required`로 거절되고, codex-rs는 이를 HTTP 폴백 신호로 해석한다.

**실측 근거**(exp7):

- `ws://127.0.0.1:<port>/v1/responses` 접속 → `{"type":"response.create","model":"smoke/fixture-model",…}` 전송 → 델타와 `response.completed`를 포함한 프레임 8개 수신, fixture 업스트림 호출 1회.
- `websockets` 미설정 엔진: WS 핸드셰이크 실패, 원시 HTTP로 확인한 응답은 `426 {"error":{"type":"upgrade_required","message":"Responses WebSocket transport is disabled; use HTTP"}}`(`server/index.ts:332-355`).
- Node 런타임에서 WS는 `node-bun-server.ts`가 `ws` 패키지로 구현한다(Bun.serve shim).

**컷오버에의 영향**: config.json에 `"websockets": true`를 포함하면 Codex Desktop의 WS 우선 transport를 그대로 수용한다. WS 턴은 `registerTurn`으로 activeTurns에 집계된다(`server/index.ts:769`).

### 8. 고정 포트와 점유 시 동작

**결론**: `host.start({port})`로 고정 포트를 바인드할 수 있다. 점유 중이면 **오류로 실패**한다(자동 증가·대체 포트 탐색 없음). `findAvailablePort`(`server/ports.ts:69-106`)는 CLI(`ocx start`) 경로 전용이고 임베디드 시작 경로는 쓰지 않는다.

**실측 근거**(exp8910 `8a/8b`):

- 19871을 점유한 더미 서버 위에 `start({port: 19871})` → `EngineHostError(code=ENGINE_WORKER_ERROR)`: `listen EADDRINUSE: address already in use 127.0.0.1:19871`.
- 빈 포트 19872 → `status.port === 19872`, `/healthz`의 `port`도 19872.

**컷오버에의 영향**: 10161→10170 스캔은 CodePet이 구현한다. `start`가 `EADDRINUSE`로 실패하면 다음 포트로 재시도하고, 최종 선택 포트를 config.toml 주입값과 맞춘다. 참고로 `engine-worker.js:25-32`는 `port` 외의 설정 키를 전달하지 않으므로 `hostname` 등은 config.json이 담당한다.

### 9. activeTurns 의미론과 소비 방식

**결론**: `getStatus().activeTurns`는 유지 중인 SSE/WS 턴 동안 1 이상이 되고 스트림 종료 후 0으로 돌아온다. 0 도달을 알려주는 이벤트/콜백은 **없다**. 엔진 내부 drain(`drainAndShutdown`)도 100ms 폴링이다(`server/lifecycle.ts:51-73`). 소비자는 폴링해야 한다.

**실측 근거**(exp8910 `9c`):

- fixture가 첫 청크 후 스트림을 유지하는 동안 `getStatus()` → `activeTurns: 1`. 해제 후 폴링 0회 추가로 `activeTurns: 0`.
- 추적 구현은 AbortController Set(`server/lifecycle.ts:7-16`), HTTP/WS 양쪽에서 등록된다.

**컷오버에의 영향**: CodePet 안전 종료는 `getStatus()` 폴링(예: 200–500ms)으로 activeTurns가 0이 되길 기다린 뒤 `quiesceAndStop({timeoutMs})`을 호출하는 순서로 충분하다. 엔진 자체 drain이 이미 스트림 종료를 기다리므로 CodePet 폴링은 UI 피드백·종료 보류 판단용이다.

### 10. 관리 API 인증

**결론**: loopback 바인드에서는 `/api/*`(읽기·변경 모두)와 `/v1/*`에 **인증이 없다**. 비loopback 바인드는 `OPENCODEX_API_AUTH_TOKEN` 없이는 시작 자체가 거부되고, 설정하면 `/api/*`와 `/v1/responses` 모두 `x-opencodex-api-key`(또는 `/api/*`는 Bearer/x-api-key)를 요구한다. `/healthz`는 항상 공개다.

**실측 근거**(exp8910 `10d/10e/10f`):

- loopback: `GET /api/codex-auth/accounts` 200, `PUT /api/codex-auth/active` 200 — 헤더 없이.
- `hostname: "0.0.0.0"` + 토큰 없음 → 시작 실패: `OPENCODEX_API_AUTH_TOKEN is required when binding opencodex to a non-loopback hostname`(`server/auth-cors.ts:121-129`).
- 비loopback + 토큰: `/api/*` 무인증 401/유인증 200, `/v1/responses` 무인증 401/유인증 200(`requireResponsesApiAuth`는 `x-opencodex-api-key`만 인정, `auth-cors.ts:184-189`), `/healthz` 200.

**컷오버에의 영향**: CodePet은 반드시 `127.0.0.1`에만 바인드한다(Codex Desktop이 `x-opencodex-api-key`를 넣을 수 없으므로 토큰 모드는 사실상 사용 불가). 대가로 **로컬의 임의 프로세스가 계정 추가·활성 계정 변경·쿨다운 해제·엔진 정지(`/api/stop`)를 호출할 수 있다**는 점을 위협 모델에 명시한다(§미해결/리스크).

## 결정 사항

### 1. 계정 브리지 형식 (CodePet 프로필 저장소 → 엔진 계정 풀)

**시작 시 파일 시드 + 실행 중 조작은 관리 API**의 이중 경로로 한다.

- 시작 시(엔진 부팅 전, 순서 고정):
  1. `~/.codepet/codex-switch/profiles/`의 각 프로필을 엔진 계정으로 변환한다. id는 프로필 키를 엔진 규칙(`ACCOUNT_ID_RE`)에 맞춰 정규화한다.
  2. `codex-accounts.json`에 자격 증명을 쓴다(레거시 단순 형태로 써도 엔진이 정규화한다).
  3. config.json의 `codexAccounts`에 `{id, email, isMain: false, plan}` 메타데이터를 쓴다(배열 순서 = 동점 시 우선순위).
- 실행 중 추가: `POST /api/codex-auth/accounts`(`OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT=1`를 워커 env에 상설 설정). warmup 검증을 통과해야 하므로 오프라인 추가는 불가. 기존 id는 거부되므로 **토큰 갱신은 이 API가 아니라 `codex-accounts.json` 파일 쓰기**로 한다(라이브 반영 실측됨).
- 실행 중 선택/해제: `PUT /api/codex-auth/active`, 선택 전 `GET /api/codex-auth/accounts?refresh=1`로 quota 프라임(미프라임 계정은 점수 100으로 튕긴다).
- 삭제: `DELETE /api/codex-auth/accounts?id=…`(관리 API) 또는 파일 양쪽 갱신 + 재시작.

### 2. 429 정책 구현 방식

1단계(컷오버 시점)는 **엔진 기본 동작을 그대로 수용**한다. 근거:

- 일시 429의 쿨다운은 기본 60초에 불과하고, reset 유도/기본 쿨다운은 5분 프로브로 조기 회복한다. 명시적 소진이 아닌 429라도 계정이 영구 격리되지 않는다.
- 탈출구가 존재한다: `POST /api/codex-auth/accounts/clear-cooldown`(CodePet 진단/복구 경로에서 노출 가능).
- CodePet proxy의 "429 → 사용량 API 검증 후에만 소진 판정"을 엔진 안에서 재현하려면 `server/responses/core.ts:1296-1304`의 `recordCodexUpstreamOutcome` 호출 전에 사용량 확인을 끼워 넣는 vendor 패치가 필요하다. 이는 2단계 후보로 `patches/opencodex`에 기록하고, 컷오버 차단 조건으로는 삼지 않는다.
- 2026-07-27 문서의 "모호한 429는 소진으로 판단하지 않는다" 조항과의 차이는 릴리스 노트/동등성 매트릭스에 `diverged`로 명시한다.

### 3. 토큰 refresh 책임 소재

**ChatGPT 풀 계정: 엔진 단독 소유.** `refreshAuthFileIfStale`는 엔진 관리 계정에 적용하지 않는다(코드는 남겨도 호출 경로를 끊는다). 엔진이 grant를 회전하므로 CodePet은 다음 시점에 `codex-accounts.json`을 읽어 프로필 저장소를 역동기화한다: (a) 엔진 정상 종료 후, (b) 주기적 프로필 저장 시, (c) `needsReauth`가 아닌 인증 오류가 관측됐을 때. Kimi는 기존 그대로 **Kimi CLI가 refresh 소유자**, CodePet 어댑터가 access token만 복사(`refresh: ""`).

### 4. `codepet-kimi-*` 슬러그 매핑 방식

**config.json `combos` 별칭으로 완결**(별도 어댑터 폐기). Kimi 모델별로:

```json
"combos": {
  "kimi-k2":  { "alias": "codepet-kimi-k2",  "targets": [{ "provider": "kimi", "model": "kimi-k2.7-code" }] },
  "kimi-k3":  { "alias": "codepet-kimi-k3",  "targets": [{ "provider": "kimi", "model": "k3" }] }
}
```

`model_catalog_json` 주입 슬러그와 동일 문자열을 alias로 쓴다. 슬러그 변경은 config.json 재작성 + 엔진 재시작이 필요하므로(인메모리 설정) CodePet 설정 UI의 모델 목록 변경 시 엔진 재시작을 동반한다.

### 5. Kimi 401 재동기화 전략

엔진에 훅이 없으므로 **CodePet 관측 + 파일 재동기화**로 처리한다.

- 만료 예방: 기존 kimi-credential-adapter 동기화 시점(앱 시작, Kimi CLI credential 변경 감지)을 유지한다.
- 401 감지: 엔진 요청 로그(`GET /api/logs`, request-log가 영속화됨)에서 kimi 라우트의 401을 폴링하거나, CodePet 측 세션 오류 표면화 시 `syncKimiCliCredential`을 즉시 실행한다.
- 재동기화 후 조치 불필요: auth.json은 요청마다 재읽힌다(실측 6e). 어댑터가 `needsReauth`를 지우므로 상태도 정리된다.
- 반복 401(재동기화 직후에도 401)은 Kimi CLI 재로그인 안내로 에스컬레이션한다.

### 6. safe-quit drain의 activeTurns 소비 방식

**폴링**. 종료 시퀀스: (1) `getStatus()`를 200–500ms 간격으로 폴링해 `activeTurns === 0` 대기(UI에는 "N개 응답 대기 중" 표시), (2) 타임아웃 내 0이면 `quiesceAndStop({timeoutMs})`로 엔진 drain + 워커 종료, (3) 타임아웃이면 사용자 확인 후 강제 drain(엔진이 남은 턴을 abort). 콜백이 없으므로 폴링 간격은 drain 체감을 해치지 않는 선에서 짧게 유지한다. WS 턴 포함 전부 activeTurns에 잡힌다.

## 미해결/리스크

- **429 정책 차이**: 엔진은 사용량 검증 없이 모든 429를 쿨다운+회전한다. 짧은 버스트성 429가 연속되면 풀 전체가 순차 쿨다운에 들어가 로컬 429(`Retry-After`) 구간이 생길 수 있다. 완화: clear-cooldown API, 2단계 vendor 패치(사용량 검증 훅). 실서비스 관측 후 결정이 필요하다.
- **로컬 관리 API 묵인증**: loopback이라도 `/api/codex-auth/*` 변경과 `/api/stop`을 임의 로컬 프로세스가 호출 가능하다. 완화책은 엔진 바인드를 127.0.0.1로 고정하고(비loopback은 토큰 강제), 필요 시 vendor 패치로 관리 API에 로컬 토큰을 요구하는 방안뿐이다.
- **config.json 소유권**: 엔진이 시작·요청 중 config.json을 재작성한다(마이그레이션, `activeCodexAccountId`, subagentModels 시드, OAuth provider reconcile). CodePet은 엔진 시작 전에만 쓰고, 반드시 `openaiProviderTierVersion: 2`를 포함한다. 이를 어기고 통째 덮어쓰기를 하면 tier 백업 충돌로 시작이 거부된다(실측). CodePet 소유 값은 별도 파일에 두고 config.json은 "생성 후 엔진 소유"로 취급한다.
- **quota 프라이밍 타이밍**: 계정 추가 직후 자동 전환 규칙이 의도와 다르게 동작할 수 있다(미프라임 = 점수 100). 선택 API 호출 전 `?refresh=1` 프라임을 습관화한다.
- **warmup 게이트**: 관리 API 계정 추가는 실제 ChatGPT warmup을 요구한다. 만료/오프라인 프로필의 시드는 시작 시 파일 경로만 가능하다.
- **WS 폴백**: `websockets: true` + codex-rs 조합은 문제 없음이 실측됐지만, Codex Desktop 실기기 검증(실 OAuth, WS transport)은 컷오버 전 필수다. fixture는 Responses SSE의 최소 이벤트만 흉내 냈다.
- **엔진 갱신 추적**: 이 문서의 file:line 근거는 vendor 스냅샷 v2.7.41 기준이다. 업스트림 재동기화 시 429 분기(`routing.ts:769-799`), 계정 저장소(`account-store.ts`), 관리 API(`auth-api.ts`) 세 곳은 반드시 재확인한다.
