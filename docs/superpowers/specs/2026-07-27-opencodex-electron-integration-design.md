# OpenCodex 완전 내장 및 수동 업데이트 설계

## 목표

CodePet이 OpenCodex의 현재 런타임 기능을 MIT 라이선스와 업스트림 이력을 보존한 채 자체 Electron 애플리케이션 안에서 제공한다. 별도 OpenCodex 실행 파일이나 사용자가 관리해야 하는 데몬은 두지 않는다. macOS와 Windows 일반 사용자 빌드는 Stable GitHub Release를 확인하되, 사용자가 명시적으로 버튼을 누른 경우에만 다운로드하고 설치한다.

최초 동등성 기준은 OpenCodex `v2.7.41`, 커밋 `ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`이다. 구현 중 더 새 Stable 태그를 흡수하려면 먼저 이 문서와 `UPSTREAM.json`의 기준을 함께 갱신하고 같은 완료 기준을 다시 적용한다.

완료 시 다음 조건이 모두 참이어야 한다.

- OpenCodex의 provider, adapter, OAuth, 계정, 모델 카탈로그, Responses 변환, 스트리밍, 도구 호출, 라우팅, 재시도, 사용량 및 진단 기능이 CodePet 안에서 동작한다.
- OpenCodex 원본 소스, MIT LICENSE, 원본 저장소 URL, 태그와 커밋 SHA를 저장소와 패키지에서 추적할 수 있다.
- OpenCodex 엔진은 Electron main이 소유하는 worker thread에서 실행되며 별도 사용자 설치 또는 외부 데몬이 필요하지 않다.
- 기존 Codex Desktop은 CodePet이 제공하는 loopback Responses 주소를 계속 사용할 수 있다.
- 모호한 `429`는 계정 소진으로 판단하지 않으며 실제 HTTP와 WebSocket 스트림이 끝나기 전에 CodePet이나 엔진을 종료하지 않는다.
- Stable Release 확인은 자동으로 할 수 있지만 다운로드와 설치는 각각 사용자 동작으로만 시작한다.
- Windows NSIS와 macOS 서명·공증 빌드에서 실제 업데이트가 검증된다.

OpenCodex의 테스트, 빌드 보조 코드와 문서는 보존·실행할 수 있게 유지하지만 CodePet UI에 그대로 복제할 사용자 기능으로 간주하지 않는다. OpenCodex CLI가 제공하는 런타임 진단과 관리 동작은 엔진 인터페이스와 CodePet 설정 UI 또는 진단 명령으로 접근할 수 있어야 한다.

## 선택한 접근법

OpenCodex를 기능별로 다시 작성하거나 외부 실행 파일로 동봉하지 않는다. 원본 스냅샷을 저장소 안에 추적하고, CodePet 전용 빌드와 호스트 어댑터를 원본 바깥에 둔다.

이 구조는 세 가지 목적을 동시에 만족한다.

1. 원본과 CodePet 수정의 차이를 명확히 유지해 업스트림 새 버전을 반복해서 흡수할 수 있다.
2. OpenCodex 내부 복잡성을 작은 엔진 인터페이스 뒤에 숨긴다.
3. 외부 프로세스의 포트·종료·설치 문제 없이 CodePet 수명주기가 엔진을 소유한다.

## 저장소 구조

```text
vendor/opencodex/
  LICENSE
  UPSTREAM.json
  src/
  tests/
  package metadata

src/open-codex/
  engine-host.js
  engine-worker.js
  engine-interface.js
  codepet-adapter.js
  credential-adapter.js
  diagnostics.js

scripts/opencodex/
  sync.js
  verify-provenance.js
  build.js
  parity-report.js

patches/opencodex/
  series.json
  *.patch

src/updater/
  update-manager.js
  update-state.js
  release-policy.js

.github/workflows/
  ci.yml
  release.yml
```

`vendor/opencodex`는 업스트림 스냅샷이다. CodePet에서 필요한 변경은 가능한 한 어댑터나 빌드 단계에 두며, 원본 수정이 불가피하면 `patches/opencodex`에 목적, 대상 업스트림 SHA와 검증 명령을 기록한다.

`UPSTREAM.json`에는 원본 저장소 URL, 태그, 커밋 SHA, 동기화 시각, 라이선스 해시와 적용 패치 목록을 기록한다. `verify-provenance.js`는 CI와 패키징 전에 이 값과 실제 파일을 검증한다.

## 깊은 엔진 모듈

Electron과 UI가 알아야 하는 외부 인터페이스는 다음 동작으로 제한한다.

```text
start(configuration) -> EngineStatus
reload(configuration) -> EngineStatus
getStatus() -> EngineStatus
getCapabilities() -> CapabilityCatalog
quiesceAndStop(options) -> ShutdownResult
```

HTTP Responses 요청은 엔진이 소유하는 loopback listener를 통해 들어가므로 Electron 호출자가 provider별 메서드를 배울 필요가 없다. OAuth, provider 선택, 계정 회전, 요청 변환, 스트림 조립과 사용량 계산은 엔진 구현 안에 숨긴다.

내부 테스트를 위해 시간, 네트워크, 자격 증명 저장소와 이벤트 출력 위치에는 내부 seam을 둔다. Electron 쪽에 provider별 얕은 인터페이스를 노출하지 않는다.

## 프로세스와 수명주기

OpenCodex 엔진은 Electron main이 생성한 Node `worker_threads` worker에서 실행한다. 이는 CodePet 패키지 안에서 main process가 소유하는 실행 단위이며, 독립 설치 파일이나 사용자가 시작하는 데몬이 아니다. CPU 집약적인 변환과 스트림 처리가 Electron 창과 반려동물 동작을 막지 않게 한다.

시작 순서는 다음과 같다.

1. Electron main이 설정과 계정 메타데이터를 읽는다.
2. `EngineHost`가 worker를 만들고 검증된 엔진 번들을 로드한다.
3. worker가 loopback listener를 열고 준비 상태를 반환한다.
4. CodePet이 소유한 Codex 설정 블록에 모델 카탈로그 경로와 loopback 주소를 원자적으로 기록한다.
5. UI에 준비 상태와 provider 기능을 게시한다.

종료 순서는 다음과 같다.

1. 새 연결 수락을 중지할 이유가 있는지 확인한다.
2. 활성 HTTP와 WebSocket 연결 수를 조회한다.
3. 연결이 남아 있으면 일반 종료를 보류한다. 업데이트 설치는 취소 가능한 대기 상태로 둔다.
4. 연결이 모두 빠진 순간 다시 확인한 뒤 listener와 worker를 닫는다.
5. CodePet 소유 설정과 임시 파일을 정리한다.

종료 대기 중 새 연결이 생기면 종료를 취소하거나 다시 대기한다. watcher의 작업 상태만으로 종료 여부를 결정하지 않는다.

## 요청과 이벤트 흐름

Codex Desktop 요청은 loopback Responses 주소에서 엔진으로 들어온다. 엔진은 모델 정의, 선택 계정과 provider 상태를 이용해 adapter를 고르고 OpenCodex의 변환 경로를 실행한다. 응답 스트림은 순서를 보존해 Codex Desktop으로 전달한다.

CodePet UI에는 정제된 상태 이벤트만 전달한다.

- provider와 모델 이름
- 연결·대기·도구 실행·완료·오류 상태
- 공개 가능한 토큰 사용량과 한도
- 사용자가 이해할 수 있는 복구 지침

OAuth URL, access token, refresh token, 원시 추론, subagent 내부 이벤트와 provider 원문 오류의 비밀값은 UI나 일반 로그에 전달하지 않는다.

## 인증과 자격 증명

macOS는 Keychain, Windows는 Credential Manager를 사용한다. OpenCodex가 기대하는 자격 증명 인터페이스는 `credential-adapter.js`가 만족한다. 평문 설정 파일에는 계정 식별에 필요한 비밀이 아닌 메타데이터만 둔다.

OAuth 콜백은 CodePet이 소유하는 일회성 loopback 경로로 받고 state와 만료 시간을 검증한다. provider 하나의 인증 실패는 다른 provider나 기존 스트림을 종료하지 않는다. 재인증이 필요한 계정만 UI에 표시한다.

## 계정 선택과 한도 처리

계정 자동 회전은 다음 두 조건을 모두 만족할 때만 허용한다.

1. provider 응답이 명시적인 quota exhaustion 의미를 가진다.
2. 신뢰 가능한 사용량 표면이 해당 계정의 소진을 확인한다.

일반 rate limit, 네트워크 장애, 사용량 조회 실패 또는 의미가 불명확한 `429`는 소진으로 처리하지 않는다. 이 경우 현재 요청에 표준 오류를 반환하고 계정을 유지한다.

이미 시작한 스트림은 계정 전환이나 설정 재로드 때문에 중간에 끊지 않는다. 새 설정은 다음 요청부터 적용한다.

## 업스트림 동기화

`scripts/opencodex/sync.js`는 명시적으로 지정한 OpenCodex 태그 또는 SHA를 임시 위치에 가져와 라이선스와 manifest를 검증하고 스냅샷을 갱신한다. 동기화는 다음 결과를 생성한다.

- 이전 SHA와 새 SHA
- 추가·변경·삭제된 OpenCodex 기능 및 파일
- 패치 재적용 결과
- 업스트림 테스트 결과
- CodePet 계약 테스트 결과
- 기능 동등성 매트릭스의 변경

동기화 결과는 자동으로 Stable Release에 들어가지 않는다. 검증된 변경만 CodePet `main`에 커밋한다. upstream 소스에 대한 지역 변경은 CI가 탐지한다.

## 기능 동등성 매트릭스

`parity-report.js`는 고정한 OpenCodex 버전의 런타임 기능을 다음 범주로 목록화한다.

- provider와 모델
- OAuth 및 인증 방식
- request/response adapter
- SSE와 WebSocket
- tool call과 reasoning 처리
- 계정 선택, retry와 quota 정책
- usage와 diagnostics
- CLI 런타임 관리 동작

각 항목에는 업스트림 테스트, CodePet 계약 테스트와 패키지 런타임 증거를 연결한다. 증거가 없는 항목은 미완료로 처리한다. 최종 전환은 모든 필수 항목이 `verified`일 때만 수행한다.

## 업데이트 제품 계약

CodePet은 Hermes Desktop과 같은 사용자 승인형 업데이트 흐름을 사용한다.

1. 앱 시작과 설정 화면 진입 시 Stable GitHub Release 메타데이터를 확인할 수 있다.
2. 새 버전이 있으면 배지와 릴리스 정보를 표시한다. 자동 다운로드하지 않는다.
3. 사용자가 다운로드 버튼을 누르면 진행률을 표시하며 패키지를 받는다.
4. 다운로드 완료 뒤 설치 버튼을 별도로 표시한다. 자동 재시작하지 않는다.
5. 설치 버튼을 누르면 스트림 drain 계약을 통과한 뒤 `quitAndInstall`을 실행한다.

개발 빌드, portable Windows 빌드, 서명되지 않은 macOS 빌드에서는 updater를 비활성화하고 이유를 진단 화면에 표시한다.

## 릴리스와 플랫폼

`main` 푸시는 테스트, 출처 검증, macOS 패키징 검사와 Windows NSIS 패키징 검사를 수행한다. 일반 사용자에게 보이는 업데이트는 Stable GitHub Release가 발행된 경우에만 생성한다.

Windows 산출물은 NSIS 설치판과 선택적 portable 실행 파일이다. NSIS만 `electron-updater` 대상이며 코드 서명이 준비된 경우 서명한다. 미서명 빌드는 Stable 품질 게이트를 충족하지 않는 것으로 표시해 SmartScreen 위험을 숨기지 않는다.

macOS 산출물은 Developer ID로 서명하고 Apple 공증과 stapling을 통과해야 한다. updater용 ZIP과 사용자가 직접 설치할 DMG를 함께 발행한다.

릴리스는 다음을 포함한다.

- NSIS installer와 updater metadata
- macOS ZIP, DMG와 updater metadata
- SHA-512 checksums
- OpenCodex upstream SHA와 MIT notices
- CodePet 변경 기록

## 오류 처리와 복구

- 엔진 번들 또는 출처 검증 실패: 검증된 이전 엔진으로 시작하고 업데이트 실패를 표시한다.
- provider 인증 실패: 해당 provider만 비활성화하고 재인증 경로를 제공한다.
- 스트림 중 upstream 오류: 순서를 보존한 표준 Responses 오류로 변환한다.
- renderer 종료: 엔진과 기존 스트림을 유지하고 UI 재연결을 허용한다.
- Electron 종료 요청: 활성 연결이 있으면 종료를 보류한다.
- 업데이트 설치 요청: drain이 실패하면 설치를 취소하고 앱을 계속 실행한다.
- 손상된 사용자 설정: CodePet 소유 블록만 안전하게 재생성하고 사용자 소유 설정은 덮어쓰지 않는다.
- 새 upstream 패치 실패: 현재 검증 버전을 유지하며 새 버전을 반영하지 않는다.

## 마이그레이션 단계

### 1. 출처와 빌드 기반

OpenCodex 스냅샷, MIT 고지, `UPSTREAM.json`, 패치 규칙, 출처 검증과 동등성 매트릭스를 추가한다.

### 2. 엔진 호스트

OpenCodex를 Electron 호환 번들로 만들고 `EngineHost`와 worker 수명주기를 추가한다. 기존 proxy 뒤에서 shadow/contract 검증을 수행한다.

### 3. 요청 경로 전환

Responses, provider, 모델 카탈로그, 스트리밍과 도구 호출을 내장 엔진으로 옮긴다. 기존 주소와 Codex 설정 계약은 유지한다.

### 4. 인증과 계정 전환

OAuth, Kimi, 자격 증명, 사용량과 한도 정책을 내장 엔진으로 옮긴다. OS별 보안 저장소와 회귀 테스트를 통과한다.

### 5. 중복 제거와 종료 검증

기능 동등성이 확인된 기존 Kimi 변환과 proxy 중복 구현을 제거한다. 장기 SSE/WebSocket, 계정 재로드와 종료 경쟁 조건을 검증한다.

### 6. 업데이트와 배포

`electron-updater`, 업데이트 UI, Windows NSIS, macOS 서명·공증과 Stable Release workflow를 추가한다.

### 7. 완료 감사

고정 OpenCodex 버전의 모든 필수 기능, MIT 고지, 업스트림 재동기화, macOS/Windows 설치와 수동 업데이트를 요구사항별 증거로 확인한다.

## 테스트 전략

- OpenCodex 원본 테스트: vendor 스냅샷의 기능 보존
- 엔진 인터페이스 테스트: 시작, 재로드, 상태, capability와 drain 종료
- golden 변환 테스트: Responses, SSE, WebSocket과 tool call 동등성
- provider 계약 테스트: 인증, 모델, 오류와 retry
- quota 회귀 테스트: 명시적 소진과 모호한 `429` 구분
- 보안 테스트: 로그 redaction과 OS 자격 증명 어댑터
- Electron 통합 테스트: IPC, UI 상태와 renderer 재연결
- 패키지 검사: 엔진 번들, LICENSE, manifest와 updater metadata 포함 여부
- Windows 실행 검증: NSIS 설치, 실행, 업데이트 다운로드와 설치
- macOS 실행 검증: 서명, 공증, 실행, 업데이트 다운로드와 설치
- 실제 Codex Desktop 검증: Kimi 및 OpenAI 모델 선택, streaming, tool call과 안전 종료

좁은 테스트 통과를 전체 완료 증거로 사용하지 않는다. 각 플랫폼의 설치와 실제 업데이트는 해당 플랫폼에서 확인해야 한다.

## 커밋과 배포 원칙

모든 원격 푸시는 `origin/main`에만 한다. 각 마이그레이션 단계는 관련 테스트와 출처 검증이 통과한 작은 커밋들로 구성한다. Stable Release는 전체 품질 게이트가 통과하고 버전이 명시적으로 발행된 경우에만 일반 사용자에게 노출한다.

## 완료 기준

다음 증거가 모두 있어야 목표를 완료로 판정한다.

- 고정 OpenCodex SHA와 MIT 고지를 검증하는 자동화
- 동등성 매트릭스의 모든 필수 항목 `verified`
- 외부 OpenCodex 프로세스 없이 Electron 패키지 안에서 실행되는 엔진
- Kimi와 OpenAI를 포함한 실제 Codex Desktop 모델 선택 및 요청 성공
- 잘못된 계정 전환과 작업 중 종료 회귀 테스트
- Windows NSIS 설치와 버튼 기반 Stable 업데이트 성공
- 서명·공증된 macOS 설치와 버튼 기반 Stable 업데이트 성공
- `origin/main`과 Stable Release의 소스 SHA 및 산출물 일치
