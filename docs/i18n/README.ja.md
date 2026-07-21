<p align="center">
  <a href="../../README.md">한국어</a> ·
  <a href="README.en.md">English</a> ·
  <strong>日本語</strong> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <img src="../assets/codepet-readme-hero.png" alt="複数の AI コーディングツールの状態を吹き出しで知らせる CodePet" width="100%">

  <h1>CodePet</h1>

  <p><strong>AI コーディングツールの作業状況を、画面上の小さなペットがお知らせします。</strong></p>

  <p>
    <code>macOS</code>
    <code>Windows</code>
    <code>Electron</code>
    <code>Local-first</code>
    <code>npm test</code>
  </p>

  <p>
    <a href="#クイックスタート">クイックスタート</a> ·
    <a href="#対応範囲">対応範囲</a> ·
    <a href="#主な機能">主な機能</a> ·
    <a href="#ペットのカスタマイズ">ペットのカスタマイズ</a> ·
    <a href="#開発とビルド">開発</a>
  </p>
</div>

---

CodePet は **Codex**、**Google Antigravity (AGY)**、**Claude Code**、**Kimi Code CLI** のローカル作業ログをまとめて監視するデスクトップペットです。複数タスクの状態と最新メッセージを一つのレスポンシブな吹き出しに整理し、アカウント別の利用上限とペット設定も一か所で管理できます。

作業データは画面表示のためにローカルで読み取ります。吹き出しに表示する情報量はユーザーが選べます。

## 概要

| リアルタイム状態 | 利用上限とアカウント | 複数タスク | デスクトップペット |
|---|---|---|---|
| 応答作成、ファイル変更、コマンド、テスト、承認待ち、完了をモーションと吹き出しで表示します。 | 接続された Codex・AGY・Claude の各アカウントと管理型 Kimi ログインの上限をカードで表示します。 | provider をまたいで開始順に最大 5 件を追跡します。 | Codex ペットとカスタムスプライトを読み込み、サイズ・位置・移動設定を保存します。 |

## クイックスタート

### ソースから実行

```bash
git clone https://github.com/SeuPut0705/CodePet.git
cd CodePet
npm install
npm run start
```

> 対応する AI ツールがローカルにインストールされ、セッション記録が作成されると CodePet が活動を表示します。

### 実行ファイルを作成

```bash
npm run dist          # 現在の OS 向け
npm run dist -- --win # Windows ポータブル exe
npm run dist -- --mac # macOS dmg + zip
```

成果物は `artifacts/` に生成されます。実行中の CodePet が出力ファイルをロックする場合があるため、ビルド前にアプリを完全終了してください。このリポジトリでは、署名・公証済みの公式インストーラーを自動配布していません。

## 対応範囲

| ツール | 活動検知 | 利用上限 | アカウント保存・切り替え |
|---|:---:|:---:|:---:|
| Codex Desktop / CLI | ✓ | ✓ | ✓ |
| Google Antigravity | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | ✓ |
| Kimi Code CLI | ✓ | 管理対象ログインのみ | — |

- **Codex** は `~/.codex/sessions` にある Desktop と CLI の作業をまとめて検知します。
- **Claude Code** は `~/.claude/projects` に記録される CLI とデスクトップアプリのセッションを検知します。
- **Kimi Code CLI** は `~/.kimi-code/sessions` または `KIMI_CODE_HOME` 配下の作業記録を読み取ります。カスタム provider を管理対象 Kimi として扱いません。
- CodePet は Kimi のアカウント切り替えには対応しません。
- CLI の活動タイトルには自動生成されたセッション名ではなく、**プロジェクトフォルダー名**を使います。

## 主な機能

### 状態をひと目で確認できる吹き出し

CodePet は provider ごとのイベントを共通状態に正規化します。

| 検知イベント | CodePet の反応 |
|---|---|
| タスク開始・応答作成 | 見回すモーションとタスク名・モデル・推論強度を表示 |
| ファイル変更・コマンド・テスト・ビルド | 対応する状態アイコンと現在の表示可能なメッセージ |
| ユーザー入力・実行承認待ち | 待機モーション、対応する Codex タスクはクリックで開く |
| タスク完了 | ジャンプモーションと最後の表示可能な応答 |
| タスク中断 | 失敗モーション |
| サブエージェント実行 | メッセージ本文ではなくタスク別の有効数のみ表示 |

吹き出しは内容と現在の画面サイズに合わせて幅を自動調整します。長いメッセージは上限幅の中で折り返し、タスク名・モデル・サブエージェント数・`5h`・`7d` バッジは一行を維持します。

Codex rollout に Sol・Terra・Luna モデルと推論強度が含まれる場合はタスク名の横に表示します。複数セッションを同時に動かしてもタイトルとメッセージを分離し、完了イベントのないタスクは provider ごとの quiet-time または stale 処理後に整理します。

### 接続済み全アカウントの利用上限

ペットをダブルクリックすると、設定の **アカウント別上限 (계정별 한도)** が開きます。

- 接続済み Codex・AGY・Claude アカウントと管理型 Kimi ログインを個別カードで表示
- 一つの照会に失敗しても他のカードを維持
- Codex が返す実期間から 5 時間・週間・月間・モデル別上限を表示
- 使用率 70% 以上は黄色、90% 以上は赤色
- Codex が 90% を超えるとリセット期間ごとに一度警告
- 管理対象 Kimi Code の最初のアクティブセクションに **`5h`・`7d` の残量**を表示

管理対象の Kimi Code セッションでは `5h`・`7d` の残量のみを表示し、カスタム provider とコンテキスト使用量は表示しません。

### プライバシーレベル

設定の **一般 (일반)** で活動情報の表示量を選べます。

| モード | 表示内容 |
|---|---|
| 全内容 (전체 내용) | リクエスト、表示可能な応答、ファイル名、コマンド |
| 状態のみ (상태만) | 作業中、テスト中、承認待ちなどの状態 |
| オフ (끄기) | 自動吹き出しを非表示、ペットのモーションは継続 |

内部推論とサブエージェントのメッセージは吹き出しに表示しません。

### 見た目と移動

- 吹き出しの背景色・文字色とシステムフォントを選択
- ドラッグ移動と左上のリサイズハンドル
- 保存した位置とサイズを現在の画面内に復元
- マウス追従と二次元の自動移動
- 移動一時停止とマウス追従設定を保存
- macOS・Windows のログイン時自動起動
- 設定画面は 한국어・English・日本語・简体中文 に対応し、既定はシステム言語に従います

## 操作

| 操作 | 反応 |
|---|---|
| クリック | あいさつ |
| ダブルクリック | ジャンプしてアカウント別上限を開く |
| ドラッグ | ペットを移動 |
| 左上のリサイズハンドルをドラッグ | 右下を固定したままサイズ変更 |
| 右クリック | 設定、アカウント、ペット、モーション、移動、自動起動、非表示 |
| システムトレイ | 設定、表示・非表示、アカウント、ペット、完全終了 |
| 完了・入力待ち・承認待ちの吹き出しをクリック | 対応する Codex タスクを開く |
| その他の吹き出しをクリック | 閉じる |

**非表示 (숨기기)** はウィンドウだけを隠し、CodePet はシステムトレイに残ります。アプリを終了するにはトレイの **完全終了 (완전 종료)** を選択してください。

<details>
<summary><strong>アカウント管理の詳細</strong></summary>

右クリックメニューとトレイメニューは Codex・AGY・Claude で共通の構成です。非アクティブなプロフィールは設定の **アカウント (계정)** から削除します。現在のプロフィールは別アカウントに切り替えてから削除できます。

- **Codex**: プロフィールごとに認証情報を保存します。既定の **Codex を再起動せず切り替え (プロキシ) (Codex 재시작 없는 전환 (프록시))** は `127.0.0.1` のローカルプロキシでリクエストごとに認証情報を適用し、上限到達後にアカウントをローテーションします。`~/.codex/config.toml` の `# codepet-codex-proxy` ブロックを管理します。初回有効化直後は Codex を一度再起動する場合があります。
- **AGY**: Windows 資格情報マネージャーまたは macOS Keychain の現在の資格情報を保存し、選択したプロフィールに切り替えて AGY を再起動します。
- **Claude**: 現在の認証ファイルと `claude auth status` のメールアドレスを保存します。既存セッションは維持され、新規セッションから選択したアカウントを使います。

プロフィールは `~/.codepet/codex-switch`、`~/.codepet/antigravity-switch`、`~/.codepet/claude-switch` に保存します。設定画面に秘密値は表示しません。

強制終了後に Codex が接続できない場合は CodePet を一度起動して古いプロキシマーカーを整理してください。必要なら `~/.codex/config.toml` から `# codepet-codex-proxy` ブロックを削除できます。

</details>

## ペットのカスタマイズ

**ペットを変更 (펫 바꾸기)** メニューは次の順番で探します。

1. 実行ファイル横の `pet/spritesheet.webp`
2. Codex CLI が `~/.codex/pets` にインストールしたペット
3. CodePet 内蔵ペット

選択内容は次回起動時にも復元されます。

<details>
<summary><strong>カスタムスプライト仕様</strong></summary>

CodePet は Codex ペットスプライト v1 と v2 を自動認識します。

| バージョン | 全体サイズ | セルサイズ | グリッド |
|---|---:|---:|---:|
| v1 | 1536×1872 | 192×208 | 8 列 × 9 行 |
| v2 | 1536×2288 | 192×208 | 8 列 × 11 行 |

| Row | 状態 | v1 フレーム | v2 フレーム |
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

v2 の row 9〜10 には時計回りの視線方向 16 個が入ります。現在は row 0〜8 の基本アニメーションを再生し、row 9〜10 は v2 レイアウトを正しく分割するために認識します。

通常は画像の高さから 9 行・11 行を判定します。比率を判定できない場合は隣の `pet.json` にある `spriteVersionNumber` を使います。完成した `spritesheet.webp` を実行ファイル横の `pet/` に入れると **カスタム (커스텀)** として表示されます。

</details>

## 開発とビルド

### コマンド

```bash
npm run dev  # 開発実行
npm test     # ローカル全テスト
npm run dist # 現在の OS 向けパッケージ
```

環境変数を設定すると DevTools を有効にできます。

```bash
PET_DEVTOOLS=1 npm run dev # macOS / Linux shell
```

```powershell
$env:PET_DEVTOOLS="1"
npm run dev
```

GitHub Actions は無効です。ローカルの `npm test` を検証基準にします。

<details>
<summary><strong>コード構成</strong></summary>

- `src/main.js` — Electron ウィンドウ、メニュー、移動、アカウントと吹き出しのライフサイクル
- `src/codex-watcher.js` — Codex Desktop・CLI セッション監視
- `src/antigravity-watcher.js` — Google Antigravity transcript 監視
- `src/claude-watcher.js` — Claude Code プロジェクトログ監視
- `src/kimi-watcher.js` — Kimi Code CLI セッション・活動監視
- `src/activity-bubble-state.js` — provider 間の同時作業集約
- `src/bubble-window-geometry.js` — 内容と画面に応じた吹き出し配置
- `src/codex-account-switcher.js`, `src/antigravity-account-switcher.js`, `src/claude-account-switcher.js` — 保存アカウント切り替え
- `src/kimi-usage-client.js`, `src/provider-usage.js` — provider 利用上限の取得・正規化
- `src/settings.html`, `src/settings.js`, `src/settings.css` — 設定と利用上限 UI
- `src/renderer.js` — ペットスプライトアニメーション
- `src/bubble.html`, `src/bubble.js`, `src/bubble.css` — 統合作業吹き出し
- `test/` — Node.js 標準 test runner の回帰テスト

</details>

---

<div align="center">
  <sub>CodePet は各ツールのローカルファイル形式と認証状態に依存します。provider の更新により、一部の検知が一時的に制限される場合があります。</sub>
</div>
