# CodePet README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 일반 사용자가 CodePet의 가치와 실행법을 빠르게 이해하는 제품형 README와 전용 배너를 만든다.

**Architecture:** 기존 앱 캐릭터를 참고한 텍스트 없는 로컬 배너를 `docs/assets/`에 추가한다. README는 제품 소개와 빠른 시작을 앞에 두고, 상세 기능·스프라이트·코드 구조를 접이식 섹션으로 내려 현재 구현과 대조 가능한 단일 진입 문서로 만든다.

**Tech Stack:** Markdown, GitHub README HTML, PNG/WebP, Node.js, Electron

## Global Constraints

- 앱 코드, 기능, 버전, 배포 산출물은 변경하지 않는다.
- 지원 도구는 Codex, Google Antigravity, Claude Code, Kimi Code CLI로 표기한다.
- Kimi 계정 전환을 지원한다고 표현하지 않는다.
- 공식 배포·CI가 존재한다고 오해할 배지를 만들지 않는다.
- 생성 이미지 안에 텍스트, 공급자 로고, 워터마크를 넣지 않는다.
- 모든 자산은 저장소 내부 상대 경로로 참조한다.

---

### Task 1: README 전용 배너

**Files:**
- Reference: `build/icon-preview.png`
- Create: `docs/assets/codepet-readme-hero.png`

**Interfaces:**
- Consumes: 기존 CodePet 캐릭터의 검은 머리, 흰 뿔, 데스크톱 펫 인상
- Produces: README 상단에서 상대 경로로 사용할 16:6 비율 PNG

- [ ] **Step 1: 배너 생성**

내장 이미지 생성 도구로 어두운 데스크톱 작업 공간, 중앙 CodePet 캐릭터, 주변 상태 말풍선과 청록·파랑·보라 계열 빛을 가진 가로 일러스트를 생성한다. 이미지 내부 텍스트·로고·워터마크는 금지한다.

- [ ] **Step 2: 자산 저장**

선택한 결과를 다음 경로에 저장한다.

```text
docs/assets/codepet-readme-hero.png
```

- [ ] **Step 3: 시각 검증**

이미지를 열어 캐릭터 훼손, 잘린 요소, 생성형 텍스트, 워터마크가 없는지 확인한다. 가로 배너로 읽히지 않으면 한 번만 목적에 맞게 재생성한다.

### Task 2: 제품형 README 재구성

**Files:**
- Modify: `README.md`
- Consume: `docs/assets/codepet-readme-hero.png`

**Interfaces:**
- Consumes: `package.json`의 `start`, `dev`, `test`, `dist` 명령과 현재 provider별 기능
- Produces: GitHub 첫 화면에서 렌더링되는 사용자 중심 문서

- [ ] **Step 1: 상단 제품 소개 작성**

다음 순서로 상단을 만든다.

```text
배너 → CodePet 제목 → 한 줄 설명 → macOS/Windows/Electron/Local-first 배지 → 빠른 시작
```

- [ ] **Step 2: 핵심 기능과 지원 범위 작성**

네 provider 동시 감시, 반응형 상태 말풍선, 계정별 사용량, 펫 커스터마이징을 짧은 섹션으로 설명한다. Kimi 관리형 사용량과 계정 전환 제외 경계를 명시한다.

- [ ] **Step 3: 상세 문서 정리**

조작법은 표로 유지한다. 계정 전환, 개인정보 모드, 커스텀 스프라이트, 코드 구조는 `<details>` 블록으로 접어 첫 화면 길이를 줄인다.

- [ ] **Step 4: 문서 정확성 검사**

```bash
node -e "const p=require('./package.json'); for (const name of ['start','dev','test','dist']) { if (!p.scripts[name]) throw new Error(name) }"
test -f docs/assets/codepet-readme-hero.png
rg -n 'Codex|Antigravity|Claude|Kimi|npm run start|npm test|npm run dist' README.md
git diff --check
```

Expected: 모든 명령 종료 코드 `0`, 끊어진 핵심 명령·provider 표기 없음.

- [ ] **Step 5: 전체 회귀 검사**

Run:

```bash
npm test
```

Expected: 전체 테스트 PASS.

### Task 3: 커밋과 독립 저장소 반영

**Files:**
- Stage: `README.md`
- Stage: `docs/assets/codepet-readme-hero.png`
- Stage: `docs/superpowers/plans/2026-07-21-readme-redesign.md`

**Interfaces:**
- Consumes: 검증된 README와 배너
- Produces: `origin/main`에 반영된 문서 변경

- [ ] **Step 1: 포함 범위 확인**

```bash
git status -sb
git diff -- README.md docs/superpowers/plans/2026-07-21-readme-redesign.md
git diff --stat
```

Expected: README 관련 파일만 변경됨.

- [ ] **Step 2: 커밋**

```bash
git add README.md docs/assets/codepet-readme-hero.png docs/superpowers/plans/2026-07-21-readme-redesign.md
git commit -m "docs: CodePet README 제품 소개 개편"
```

- [ ] **Step 3: 푸시 및 원격 검증**

```bash
git push origin main
test "$(git rev-parse HEAD)" = "$(git ls-remote origin refs/heads/main | awk '{print $1}')"
```

Expected: push 성공, local HEAD와 `origin/main` SHA 일치.
