# pi-simple-subagents

Pi に軽量な `subagent` ツールを追加し、Markdown で管理する専門エージェントへ作業を分担できます。

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

## 特徴

- **軽い構成:** このパッケージは組み込みエージェントとして `general-purpose`、`Plan`、`Explore` を提供し、必要な専門エージェントを自分で追加できます。
- **デフォルトモデルの継承:** エージェント定義で `model` を省くと、子 Pi は親 Pi のデフォルトモデルを使います。
- **Markdown エージェント:** ユーザー定義は `~/.pi/agent/agents/*.md`、プロジェクト定義は `.pi/agents/*.md` に置きます。
- **柔軟な分担:** 1 件の委譲、並列実行、前の出力を渡す chain 実行、background 実行に対応します。
- **reference-style 互換:** 従来の `agent` / `task` に加えて、`subagent({ subagent_type, prompt })`、`Agent(...)`、`get_subagent_result(...)` を使えます。
- **run 管理:** `status`、`result`、`interrupt`、実験的な `resume` に対応します。
- **プロジェクトプロンプトの確認:** Pi は `.pi/agents/*.md` のリポジトリ管理エージェントを実行する前に確認します。

## インストール

GitHub からパッケージをインストールします。

```sh
pi install git:github.com/ryonakae/pi-simple-subagents
```

手元のチェックアウトを 1 回だけ読み込む場合は、リポジトリ直下で実行します。

```sh
pi -e .
```

Pi パッケージはコードを実行します。第三者のパッケージを入れる前に中身を確認してください。

## 使い方

Pi を起動し、委譲したい内容を伝えます。

```text
List available subagents.
Use the general-purpose subagent to investigate why npm run check fails.
Use the Plan subagent to design the implementation before editing.
Use the Explore subagent to locate auth-related files and references.
Run two subagents in parallel: one reviews correctness and one checks missing documentation.
```

プロジェクトエージェントを含めたいときは、`agentScope` を `both` にします。Pi は `.pi/agents/*.md` のエージェントを実行する前に確認します。

## エージェントを追加する

ユーザー共通のエージェントは `~/.pi/agent/agents/` に置きます。

```sh
mkdir -p ~/.pi/agent/agents
cat > ~/.pi/agent/agents/reviewer.md <<'EOF'
---
name: reviewer
description: Review code changes for correctness, tests, and simplicity
tools: read, bash
thinking: high
prompt_mode: replace
---

You are a code reviewer. Read the current diff and report only actionable findings.
EOF
```

ファイルを追加したら、Pi にエージェント一覧を表示させます。

```text
List available subagents.
```

### Frontmatter

- `name`: エージェント名。省くとファイル名を使います。
- `description`: 必須。一覧とツール説明に表示します。
- `tools` / `exclude_tools`: 子 Pi に渡す tool を絞ります。
- `model` / `thinking`: 子 Pi のモデルと思考量を指定します。`model` を省くと親 Pi のデフォルトを使います。
- `prompt_mode`: `replace` または `append`。
- `extensions` / `skills` / `context_files` / `enabled`: discovery や読み込み可否を切り替えます。
- `run_in_background` / `runInBackground`: このエージェントの既定を background 実行にします。
- `inherit_context` / `inheritContext`: 将来の context fork 用です。現在は指定すると明示的に失敗します。
- `max_turns` / `maxTurns` と `isolation`: 将来互換のために読み取ります。

## 実行モード

推奨の reference-style 単発実行:

```ts
subagent({
  subagent_type: "reviewer",
  prompt: "現在の差分をレビューして",
  description: "diff review"
})
```

従来互換の単発実行:

```ts
subagent({ agent: "reviewer", task: "現在の差分をレビューして" })
```

Background 実行:

```ts
subagent({
  subagent_type: "scout",
  prompt: "認証フローを調査して",
  run_in_background: true
})
```

Run 管理:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "sub_abc123" })
subagent({ action: "result", id: "sub_abc123" })
get_subagent_result({ id: "sub_abc123", verbose: true })
subagent({ action: "interrupt", id: "sub_abc123" })
subagent({ action: "resume", id: "sub_abc123", message: "テスト観点も確認して" })
```

その他のモード:

- 一覧表示: `action: "list"` を指定します。
- 並列実行: `tasks` を渡します。最大 8 件まで受け取り、同時に最大 4 件を実行します。
- Chain 実行: `chain` を渡し、`{previous}` で前ステップの出力を差し込みます。
- Scope: `agentScope` は `user`, `project`, `both` から選びます。既定は `user` です。

## Artifacts と制限

可能な場合、run は `.pi/subagents/runs/<run-id>/` に保存します。書けない場合は `~/.pi/agent/subagents/<project-hash>/runs/<run-id>/` に fallback します。各 run は `status.json`、stdout/stderr ログ、`result.md`、子 `session.jsonl` path を記録します。

現在の制限:

- `inherit_context` / `context: "fork"` は予約済みで、silent fallback せず明示的に失敗します。
- `steer_subagent` は互換用に登録していますが、まだ未実装です。
- Background job は現在の Pi プロセス内で管理します。別プロセス由来の stale な running artifact は interrupt できません。

## 要件

- Pi Coding Agent のパッケージ機能が必要です。このリポジトリは Pi Coding Agent 0.78.1 で確認しています。
- 開発時は Node.js 22 以上を使ってください。`npm run check` が `node --experimental-strip-types` を実行します。

## 参考にしたリポジトリ

このパッケージは、次の Pi subagent リポジトリのアイデアを参考にしています。

- <https://github.com/nicobailon/pi-subagents>
- <https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents>
- <https://github.com/tintinweb/pi-subagents>

## 開発

```sh
npm run check
npm run test
npm run lint
npm run typecheck
pi --list-models -e .
```

`npm run check` は TypeScript 型チェック、Biome、Vitest を実行します。pre-commit では Husky がテスト、型チェック、lint-staged 経由の Biome チェックを実行します。

## ライセンス

[MIT](LICENSE)
