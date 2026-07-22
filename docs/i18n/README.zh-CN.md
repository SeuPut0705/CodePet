<p align="center">
  <a href="../../README.md">한국어</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <strong>简体中文</strong>
</p>

<div align="center">
  <img src="../assets/codepet-readme-hero.png" alt="CodePet 使用气泡显示多个 AI 编程工具的工作状态" width="100%">

  <h1>CodePet</h1>

  <p><strong>AI 编程工具工作时，让屏幕上的小宠物告诉你当前进度。</strong></p>

  <p>
    <code>macOS</code>
    <code>Windows</code>
    <code>Electron</code>
    <code>Local-first</code>
    <code>npm test</code>
  </p>

  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#支持范围">支持范围</a> ·
    <a href="#主要功能">主要功能</a> ·
    <a href="#自定义宠物">自定义宠物</a> ·
    <a href="#开发与构建">开发</a>
  </p>
</div>

---

CodePet 是一款桌面宠物，可同时监控 **Codex**、**Google Antigravity (AGY)**、**Claude Code**、**Kimi Code CLI**、**Gemini CLI**、**GitHub Copilot CLI**、**Cursor**、**OpenCode** 和 **Windsurf** 的本地工作。它把多个任务的状态和最新消息整理到一个响应式气泡中，并集中管理已检测的 provider、账户、额度与宠物设置。

工作数据只为屏幕显示而在本地读取。你可以自行选择活动气泡显示多少内容。

## 一览

| 实时任务状态 | 额度与账户 | 并行任务 | 你的桌面宠物 |
|---|---|---|---|
| 通过动作和气泡显示响应编写、文件修改、命令、测试、等待批准与完成。 | 为每个已连接的 Codex、AGY 和 Claude 账户以及托管 Kimi 登录显示独立额度卡片。 | 跨 provider 按开始顺序追踪最多 5 个任务。 | 加载 Codex 宠物和自定义精灵图，并保存大小、位置与移动偏好。 |

## 快速开始

### 从源码运行

```bash
git clone https://github.com/SeuPut0705/CodePet.git
cd CodePet
npm install
npm run start
```

> 本地安装受支持的 AI 工具并产生会话记录后，CodePet 才会显示其活动。

### 构建可执行文件

```bash
npm run dist          # 当前操作系统
npm run dist -- --win # Windows 便携版 exe
npm run dist -- --mac # macOS dmg + zip
```

构建产物保存在 `artifacts/`。运行中的 CodePet 可能锁定输出文件，因此构建前请完全退出应用。本仓库不会自动发布经过签名或公证的官方安装程序。

## 支持范围

| 工具 | 活动检测 | 额度显示 | 账户与连接 |
|---|:---:|:---:|:---:|
| Codex Desktop / CLI | ✓ | ✓ | ✓ |
| Google Antigravity | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | ✓ |
| Kimi Code CLI | ✓ | 仅托管登录 | — |
| Gemini CLI | ✓ | — | 登录与账户识别 |
| GitHub Copilot CLI | ✓ | — | 登录与 hook 连接 |
| Cursor App / CLI | ✓ | — | 登录与 hook 连接 |
| OpenCode App / CLI | ✓ | — | 登录检测 |
| Windsurf App | ✓ | — | hook 连接 |

- **Codex** 同时监控 `~/.codex/sessions` 下的 Desktop 与 CLI 工作。
- **Claude Code** 监控 `~/.claude/projects` 中记录的 CLI 与桌面应用会话。
- **Kimi Code CLI** 读取 `~/.kimi-code/sessions` 或 `KIMI_CODE_HOME` 下的工作记录。自定义 provider 不会被视为托管 Kimi。
- CodePet 不支持 Kimi 账户切换。
- **Gemini CLI** 读取 `~/.gemini/tmp` 或 `GEMINI_CLI_HOME` 下的 JSONL 会话。只显示主会话消息；嵌套 subagent 不显示正文，只计入活动数量。
- **OpenCode** 在后台 worker 中读取本地 SQLite 会话数据库。只显示应用与 CLI 的主会话消息；子会话只计入活动数量。
- 从设置连接 **GitHub Copilot CLI**、**Cursor** 或 **Windsurf** 时，CodePet 会在各工具的 hook 配置中加入本地事件转发项。已有 hook 会保留，损坏的 JSON 不会被覆盖。
- 设置中的 provider 列表只显示已检测到应用或 CLI、已连接集成或已识别账户的项目。其余 provider 可从**添加账户**中选择并连接。
- CLI 活动标题使用**项目文件夹名称**，而不是自动生成的会话标题。

检测路径、连接文件、隐私边界与恢复行为见 [provider 连接与检测结构](../provider-integrations.md)。

## 主要功能

### 一眼看懂任务状态的气泡

CodePet 将各 provider 的事件归一为统一状态。

| 检测到的事件 | CodePet 的反应 |
|---|---|
| 任务开始或编写响应 | 环顾动作，并显示任务标题、模型与推理强度 |
| 修改文件、执行命令、测试或构建 | 对应状态图标与当前可见消息 |
| 等待用户输入或执行批准 | 等待动作；支持的 Codex 任务可点击打开 |
| 任务完成 | 跳跃动作与最后一条可见响应 |
| 任务中断 | 失败动作 |
| 子代理运行 | 仅显示每个任务的活动数量，不显示子代理消息内容 |

气泡会根据内容和当前屏幕自动调整宽度。长消息会在最大宽度内换行，而任务标题、模型、子代理数量和用量徽标保持在同一行。

如果 Codex rollout 元数据包含 Sol、Terra 或 Luna 模型及推理强度，CodePet 会把它们显示在任务标题旁。并行会话的标题和消息彼此分离；没有完成事件的任务会在 provider 对应的 quiet-time 或 stale 处理后清理。

### 所有已连接账户的额度

双击宠物可在设置中打开**按账户查看额度 (계정별 한도)**。

- 为每个已连接的 Codex、AGY 和 Claude 账户以及托管 Kimi 登录显示独立卡片
- 单个账户查询失败不会隐藏其他卡片
- 按 Codex 服务器提供的真实周期显示五小时、每周、每月和模型专属额度
- 使用率达到 70% 时显示黄色，达到 90% 时显示红色
- Codex 使用率超过 90% 后，每个重置周期只警告一次
- 第一个活动的托管 Kimi Code 区块显示 **`5h` 与 `7d` 剩余额度**

托管 Kimi Code 会话仅显示 `5h` 和 `7d` 剩余额度，不显示自定义 provider 或上下文用量。

### 隐私级别

可在设置的**常规 (일반)** 页面选择活动信息的显示程度。

| 模式 | 显示内容 |
|---|---|
| 完整内容 (전체 내용) | 请求、可见响应、文件名和命令 |
| 仅状态 (상태만) | 工作中、测试中、等待批准等状态 |
| 关闭 (끄기) | 隐藏自动任务气泡，宠物动作仍然运行 |

气泡中的内部推理内容或子代理消息不会显示。可显示的工具输入也会遮盖授权标头、API 密钥、Cookie、密码和 URL 中的秘密参数。

### 外观与移动

- 自定义气泡背景色、文字颜色和系统字体
- 拖动移动，以及位于左上角的缩放手柄
- 在当前屏幕工作区内恢复已保存的位置与大小
- 跟随鼠标与二维自动漫游
- 保存移动暂停和跟随鼠标设置
- macOS 与 Windows 登录时自动启动
- 设置界面支持 한국어、English、日本語、简体中文，默认跟随系统语言

## 操作

| 操作 | 反应 |
|---|---|
| 单击 | 打招呼 |
| 双击 | 跳跃并打开按账户查看额度 |
| 拖动 | 移动宠物 |
| 拖动左上角缩放手柄 | 固定右下角并调整大小 |
| 右键 | 设置、账户、宠物、动作、移动、自动启动和隐藏菜单 |
| 系统托盘 | 设置、显示/隐藏、账户、宠物和完全退出 |
| 单击完成、等待输入或等待批准气泡 | 打开支持的 Codex 任务 |
| 单击其他气泡 | 关闭气泡 |

**隐藏 (숨기기)** 只隐藏窗口，CodePet 仍保留在系统托盘。要停止应用，请从托盘菜单选择**完全退出 (완전 종료)**。

<details>
<summary><strong>账户管理详情</strong></summary>

右键菜单与托盘菜单为 Codex、AGY 和 Claude 提供相同的账户结构。可在设置的**账户 (계정)** 页面删除未使用的配置；当前配置需先切换到其他账户才能删除。

- **Codex**：按配置保存凭据。如果切换账户时 Codex Desktop 正在运行，CodePet 会请求应用退出、确认进程已结束、替换凭据，然后自动重新启动。无需手动退出 Codex。**Codex 额度自动切换（本地代理）(Codex 한도 자동 전환 (로컬 프록시))** 通过 `127.0.0.1` 为新的 CLI 连接应用凭据，并在达到额度后轮换账户。它管理 `~/.codex/config.toml` 中的 `# codepet-codex-proxy` 区块。已打开的 CLI 会话可能需要重新启动才能使用所选账户。
- **AGY**：保存 Windows 凭据管理器或 macOS Keychain 中的当前凭据，切换到所选配置后重启 AGY。
- **Claude**：保存当前凭据文件和 `claude auth status` 返回的邮箱。已有会话保持运行，新会话使用所选账户。

配置保存在 `~/.codepet/codex-switch`、`~/.codepet/antigravity-switch` 和 `~/.codepet/claude-switch`。设置页面不会显示秘密值。

如果强制退出后 Codex 无法连接，请启动一次 CodePet 以清理过期代理标记；也可以从 `~/.codex/config.toml` 删除 `# codepet-codex-proxy` 区块。

</details>

## 自定义宠物

**更换宠物 (펫 바꾸기)** 菜单按以下顺序查找：

1. 可执行文件旁的 `pet/spritesheet.webp`
2. Codex CLI 安装在 `~/.codex/pets` 下的宠物
3. CodePet 内置宠物

所选宠物会在下次启动时恢复。

<details>
<summary><strong>自定义精灵图规范</strong></summary>

CodePet 自动识别 Codex 宠物精灵图 v1 与 v2。

| 版本 | 总尺寸 | 单元格尺寸 | 网格 |
|---|---:|---:|---:|
| v1 | 1536×1872 | 192×208 | 8 列 × 9 行 |
| v2 | 1536×2288 | 192×208 | 8 列 × 11 行 |

| 行 | 状态 | v1 帧数 | v2 帧数 |
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

v2 的第 9～10 行包含顺时针方向的 16 个视线方向。CodePet 目前播放第 0～8 行的基础动画，并识别第 9～10 行以正确切分 v2 布局。

通常根据图像高度判断 9 行或 11 行精灵图。如果无法判断比例，则使用相邻 `pet.json` 中的 `spriteVersionNumber`。将完成的 `spritesheet.webp` 放入可执行文件旁的 `pet/` 文件夹，即会显示为**自定义 (커스텀)**。

</details>

## 开发与构建

### 命令

```bash
npm run dev  # 开发运行
npm test     # 完整本地测试
npm run dist # 为当前操作系统打包
```

通过环境变量启用 DevTools。

```bash
PET_DEVTOOLS=1 npm run dev # macOS / Linux shell
```

```powershell
$env:PET_DEVTOOLS="1"
npm run dev
```

GitHub Actions 已禁用。本地 `npm test` 是验证标准。

<details>
<summary><strong>代码结构</strong></summary>

- `src/main.js` — Electron 窗口、菜单、移动、账户与气泡生命周期
- `src/codex-watcher.js` — Codex Desktop 与 CLI 会话监控
- `src/antigravity-watcher.js` — Google Antigravity transcript 监控
- `src/claude-watcher.js` — Claude Code 项目日志监控
- `src/kimi-watcher.js` — Kimi Code CLI 会话与活动监控
- `src/gemini-watcher.js`、`src/opencode-watcher.js` — Gemini CLI、OpenCode 会话与子任务生命周期监控
- `src/opencode-db-query.js`、`src/opencode-db-worker.js` — OpenCode SQLite 后台查询
- `src/provider-hook-bridge.js`、`src/provider-hook-watcher.js`、`src/provider-integrations.js` — Copilot、Cursor 与 Windsurf 本地 hook 连接和事件归一化
- `src/provider-catalog.js`、`src/provider-client-discovery.js` — provider 元数据与应用、CLI 安装检测
- `src/activity-redaction.js` — 工具输入进入气泡前的秘密值清理
- `src/activity-bubble-state.js` — 跨 provider 的并行活动汇总
- `src/bubble-window-geometry.js` — 基于内容和屏幕的气泡几何计算
- `src/codex-account-switcher.js`、`src/antigravity-account-switcher.js`、`src/claude-account-switcher.js` — 已保存账户切换
- `src/kimi-usage-client.js`、`src/provider-usage.js` — provider 额度获取与归一化
- `src/settings.html`、`src/settings.js`、`src/settings.css` — 设置与额度 UI
- `src/renderer.js` — 宠物精灵动画
- `src/bubble.html`、`src/bubble.js`、`src/bubble.css` — 统一活动气泡
- `test/` — 使用 Node.js 内置 test runner 的回归测试

</details>

---

<div align="center">
  <sub>CodePet 依赖各工具的本地文件格式与认证状态。provider 更新可能会暂时限制部分检测能力。</sub>
</div>
