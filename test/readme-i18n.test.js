const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..");

const documents = [
  {
    file: "README.md",
    languageTargets: [
      "docs/i18n/README.en.md",
      "docs/i18n/README.ja.md",
      "docs/i18n/README.zh-CN.md",
    ],
  },
  {
    file: "docs/i18n/README.en.md",
    languageTargets: ["../../README.md", "README.ja.md", "README.zh-CN.md"],
  },
  {
    file: "docs/i18n/README.ja.md",
    languageTargets: ["../../README.md", "README.en.md", "README.zh-CN.md"],
  },
  {
    file: "docs/i18n/README.zh-CN.md",
    languageTargets: ["../../README.md", "README.en.md", "README.ja.md"],
  },
];

const sharedTokens = [
  "CodePet",
  "Codex",
  "Google Antigravity",
  "Claude Code",
  "Kimi Code CLI",
  "Gemini CLI",
  "GitHub Copilot CLI",
  "Cursor",
  "OpenCode",
  "Windsurf",
  "KIMI_CODE_HOME",
  "GEMINI_CLI_HOME",
  "5h",
  "7d",
  "npm install",
  "npm run start",
  "npm test",
  "npm run dist",
];

function readRepositoryFile(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  assert.ok(fs.existsSync(absolutePath), `missing ${relativePath}`);
  return fs.readFileSync(absolutePath, "utf8");
}

function localTargets(markdown) {
  const targets = [];
  const patterns = [/(?:href|src)="([^"]+)"/g, /\[[^\]]*\]\(([^)]+)\)/g];

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
      targets.push(target);
    }
  }

  return targets;
}

test("네 언어 README는 공통 기능과 언어 전환 링크를 유지한다", () => {
  for (const document of documents) {
    const markdown = readRepositoryFile(document.file);

    for (const label of ["한국어", "English", "日本語", "简体中文"]) {
      assert.match(markdown, new RegExp(label), `${document.file}: ${label}`);
    }

    for (const token of sharedTokens) {
      assert.ok(markdown.includes(token), `${document.file}: ${token}`);
    }

    for (const target of document.languageTargets) {
      assert.ok(markdown.includes(`href="${target}"`), `${document.file}: ${target}`);
    }
  }
});

test("다국어 README의 로컬 링크와 배너 경로는 실제 파일을 가리킨다", () => {
  for (const document of documents) {
    const markdown = readRepositoryFile(document.file);
    const documentDirectory = path.dirname(path.join(repositoryRoot, document.file));

    for (const target of localTargets(markdown)) {
      const resolved = path.resolve(documentDirectory, target);
      assert.ok(fs.existsSync(resolved), `${document.file}: missing ${target}`);
    }
  }
});

test("각 언어는 Kimi·개인정보·배포 제한을 명시한다", () => {
  const expectations = {
    "README.md": [/계정 전환 대상이 아/, /내부 추론.*서브에이전트 메시지/s, /공식 설치 파일을 자동 배포하지 않/],
    "docs/i18n/README.en.md": [/does not support Kimi account switching/i, /internal reasoning.*subagent messages/is, /does not automatically publish signed or notarized installers/i],
    "docs/i18n/README.ja.md": [/Kimi.*アカウント切り替え.*対応しません/s, /内部推論.*サブエージェント.*表示しません/s, /署名・公証済み.*自動配布していません/s],
    "docs/i18n/README.zh-CN.md": [/不支持 Kimi 账户切换/, /内部推理.*子代理消息.*不会显示/s, /不会自动发布.*签名或公证/s],
  };

  for (const [file, patterns] of Object.entries(expectations)) {
    const markdown = readRepositoryFile(file);
    for (const pattern of patterns) assert.match(markdown, pattern, `${file}: ${pattern}`);
  }
});

test("각 언어는 Codex Desktop 계정 전환의 자동 재실행 계약을 설명한다", () => {
  const expectations = {
    "README.md": [/실제 종료를 확인한 뒤 인증을 교체/, /수동으로 종료할 필요가 없/],
    "docs/i18n/README.en.md": [/waits for it to exit.*launches it again automatically/i, /do not need to quit Codex manually/i],
    "docs/i18n/README.ja.md": [/実際の終了を確認してから.*自動的に再起動/s, /手動で終了する必要はありません/],
    "docs/i18n/README.zh-CN.md": [/确认进程已结束.*自动重新启动/s, /无需手动退出 Codex/],
  };

  for (const [file, patterns] of Object.entries(expectations)) {
    const markdown = readRepositoryFile(file);
    for (const pattern of patterns) assert.match(markdown, pattern, `${file}: ${pattern}`);
  }
});

test("각 언어는 계정과 사용량을 한 화면의 컴팩트한 계정 행으로 설명한다", () => {
  const expectations = {
    "README.md": [
      /계정과 사용량을 한 화면/,
      /계정 행.*잔여율 칩/,
      /GPT-5\.3-Codex 모델 전용 한도는 숨김/,
    ],
    "docs/i18n/README.en.md": [
      /Accounts and quota in one view/i,
      /remaining-quota chips.*account row/i,
      /GPT-5\.3-Codex model-specific quota is hidden/i,
    ],
    "docs/i18n/README.ja.md": [
      /アカウントと利用上限を一つの画面/,
      /各行.*コンパクトな残量チップ/,
      /GPT-5\.3-Codex のモデル専用上限は表示しません/,
    ],
    "docs/i18n/README.zh-CN.md": [
      /在一个页面管理账户与额度/,
      /账户行.*紧凑的剩余额度标签/,
      /不显示 GPT-5\.3-Codex 模型专属额度/,
    ],
  };

  for (const [file, patterns] of Object.entries(expectations)) {
    const markdown = readRepositoryFile(file);
    for (const pattern of patterns) assert.match(markdown, pattern, `${file}: ${pattern}`);
  }
});

test("공급자 연결 문서는 현재 감지·보안·복구 계약을 설명한다", () => {
  const document = readRepositoryFile("docs/provider-integrations.md");
  for (const token of [
    "Codex",
    "Antigravity",
    "Claude",
    "Kimi",
    "Gemini",
    "GitHub Copilot",
    "Cursor",
    "OpenCode",
    "Windsurf",
    "127.0.0.1",
    "com.openai.codex",
    "X-CodePet-Token",
    "activity-redaction.js",
    "opencode-db-worker.js",
    "npm test",
  ]) {
    assert.ok(document.includes(token), `docs/provider-integrations.md: ${token}`);
  }

  assert.match(document, /subagent.*본문.*(표시하지|숨기)/s);
  assert.match(document, /종료 확인 뒤에만.*auth\.json/s);
  assert.match(document, /손상.*JSON.*덮어쓰지/s);
  assert.match(document, /Apple Developer ID.*서명.*공증/s);
});
