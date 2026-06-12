# pi-simple-subagents v2 実装プラン

作成日: 2026-06-12

## 背景

現状の実装は、子 Pi プロセスを `--mode json -p --no-session` で起動し、単発の foreground 結果を親へ返す薄いラッパーになっている。これは公式サンプルに近い最小構成としては動くが、参考リポジトリの `pi-subagents` が提供しているユーザー体験とは差が大きい。

目標は、デフォルト組み込み agent/model を押し付けずに、実行体験を参考リポジトリへ近づけること。

## ゴール

- ユーザー定義 agent を中心にした lightweight な設計を維持する。
- 特定プロバイダやモデルをデフォルトで pin しない。
- `subagent` の実行 API と体験を参考リポジトリに近づける。
- foreground / background / status / result / interrupt / resume の基礎を持つ。
- 実装をモジュール分割し、今後 `steer`、`inherit_context`、worktree、widget を足しやすくする。

## 非ゴール

初期 v2 では次は完璧には作らない。

- 参考リポジトリの全機能移植
- 複雑な saved chain / dynamic fanout
- intercom 連携
- 完全な nested subagent tree 管理
- 高度な settings UI
- スケジュール実行
- MCP direct tool allowlist の完全互換

ただし、API と内部構造は後で追加できる形にする。

## 目指すユーザー体験

### 1. reference-style の単発実行

```ts
subagent({
  subagent_type: "reviewer",
  prompt: "この差分をレビューして",
  description: "diff review"
})
```

後方互換として現行の形式も残す。

```ts
subagent({ agent: "reviewer", task: "この差分をレビューして" })
```

### 2. background 実行

```ts
subagent({
  subagent_type: "scout",
  prompt: "認証周りのコードを調査して",
  run_in_background: true
})
```

親には即時に run id を返す。

```text
Started background subagent scout: sub_abc123
Use subagent({ action: "status", id: "sub_abc123" }) to check progress.
```

### 3. status / result

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "sub_abc123" })
subagent({ action: "result", id: "sub_abc123" })
```

参考リポジトリ互換の別 tool も登録する。

```ts
get_subagent_result({ id: "sub_abc123" })
```

### 4. interrupt

```ts
subagent({ action: "interrupt", id: "sub_abc123" })
```

対象プロセスに `SIGTERM`、一定時間後に `SIGKILL`。

### 5. resume の土台

```ts
subagent({ action: "resume", id: "sub_abc123", message: "追加でこの観点も見て" })
```

v2 初期では、完了済み child session を `--session <path>` で続行する方針にする。実装可能性を Pi CLI で確認し、難しい場合は明示的に制限として残す。

## 公開 API 設計

### `subagent` tool

#### 共通パラメータ

| 名前 | 型 | 説明 |
|---|---|---|
| `action` | `"run" | "list" | "status" | "result" | "interrupt" | "resume"` | 実行または管理操作 |
| `agentScope` | `"user" | "project" | "both"` | agent 探索範囲 |
| `confirmProjectAgents` | boolean | project-local agent 実行前に確認 |
| `cwd` | string | child process の cwd |

#### reference-style run

| 名前 | 型 | 説明 |
|---|---|---|
| `subagent_type` | string | agent 名 |
| `prompt` | string | delegated task |
| `description` | string | UI 表示用の短い説明 |
| `run_in_background` | boolean | background 実行 |
| `inherit_context` | boolean | 親会話 fork。初期は未対応なら明示エラー |
| `resume` | string | 既存 run/session を続行 |
| `model` | string | agent frontmatter 未指定時の一時 override |
| `thinking` | string | agent frontmatter 未指定時の一時 override |

#### 現行互換 run

| 名前 | 型 | 説明 |
|---|---|---|
| `agent` | string | agent 名 |
| `task` | string | delegated task |
| `tasks` | array | parallel 実行 |
| `chain` | array | sequential 実行 |

#### 管理操作

| 名前 | 型 | 説明 |
|---|---|---|
| `id` | string | run id |
| `message` | string | resume / steer 用メッセージ |
| `verbose` | boolean | 詳細結果を返す |

### `Agent` alias

`tintinweb/pi-subagents` 互換用。`subagent` の reference-style run に変換する。

```ts
Agent({
  subagent_type: "Explore",
  prompt: "Find auth files",
  description: "Find auth files",
  run_in_background: true
})
```

初期実装では `Agent` は optional にするか、デフォルトで登録する。登録時は `SUBAGENT_TOOL_NAMES` に含め、child への再帰露出を制限する。

### `get_subagent_result` tool

`subagent({ action: "result" })` の薄い alias。

```ts
get_subagent_result({ id: "sub_abc123", verbose: true })
```

### `steer_subagent` tool

v2 初期では未実装でも schema は将来用に確保する。実装前に呼ばれたら明示エラーにする。

```text
steer_subagent is not available yet. Use subagent({ action: "resume" }) after completion, or interrupt and restart.
```

## agent discovery 方針

現行の思想を維持する。

- built-in は `general-purpose`, `Plan`, `Explore`
- built-in に model を指定しない
- user agents: `~/.pi/agent/agents/*.md`
- project agents: nearest `.pi/agents/*.md`
- `agentScope: "user"` をデフォルト
- `agentScope: "both"` のとき project が user を override
- project-local agent は UI がある場合に確認する

追加する frontmatter 候補。

| frontmatter | 対応 | 備考 |
|---|---|---|
| `run_in_background` / `runInBackground` | v2 | 既定実行モード |
| `inherit_context` / `inheritContext` | v2.1 | 初期は validation のみ |
| `max_turns` / `maxTurns` | v2.1 | child prompt で wrap-up するか CLI 対応確認 |
| `isolation` | v2.2 | `worktree` を想定 |
| `extensions` | 現行維持 | boolean/list は将来対応 |
| `skills` | 現行維持 | boolean/list は将来対応 |
| `context_files` | 現行維持 | boolean |
| `tools` | 現行維持 | `none` / `all` / extension selector は後続 |
| `exclude_tools` | 現行維持 | snake/camel 両対応 |
| `prompt_mode` | 現行維持 | `replace` / `append` |

## 内部構造

現行の `src/index.ts` 集中をやめる。

```text
src/
  index.ts            # extension entry。tool/command 登録だけ
  agents.ts           # agent discovery / frontmatter parse
  schemas.ts          # TypeBox schema と互換 normalizer
  runner.ts           # child Pi 起動、JSON event parsing、abort
  jobs.ts             # background job registry、artifact 保存、status 更新
  status.ts           # result/status formatting
  render.ts           # renderCall/renderResult
  session.ts          # child session path、resume/fork 方針
  ids.ts              # run id 生成
  files.ts            # artifact path / atomic write helper
  types.ts            # 共通型
```

## artifact 設計

background run はメモリだけでなくファイルにも保存する。

### 保存先

```text
.pi/subagents/runs/<run-id>/
  status.json
  events.jsonl
  stdout.jsonl
  stderr.log
  result.md
  session.jsonl       # child Pi session。可能なら Pi の session dir への path を保存
```

project 配下に書けない場合は user dir に fallback する。

```text
~/.pi/agent/subagents/<project-hash>/runs/<run-id>/
```

ただし sandbox / permission エラーを無理に回避しない。`Operation not permitted` はユーザーに報告する。

### `status.json`

```json
{
  "id": "sub_abc123",
  "mode": "single",
  "agent": "reviewer",
  "agentSource": "user",
  "description": "diff review",
  "task": "...",
  "cwd": "/repo",
  "state": "running",
  "startedAt": 1791760000000,
  "updatedAt": 1791760005000,
  "completedAt": null,
  "exitCode": null,
  "stopReason": null,
  "errorMessage": null,
  "pid": 12345,
  "sessionFile": "/path/to/session.jsonl",
  "usage": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": 0,
    "contextTokens": 0,
    "turns": 0
  }
}
```

### 状態

| state | 意味 |
|---|---|
| `queued` | concurrency 待ち |
| `running` | child process 実行中 |
| `completed` | 正常終了 |
| `failed` | exit code / LLM error |
| `interrupted` | interrupt 済み |
| `aborted` | parent abort 等 |

## runner 設計

### foreground

- 現行と同じく tool call 内で child process を待つ。
- `onUpdate` で child の assistant/tool result を streaming 表示する。
- child の `message_end`、`tool_result_end`、必要に応じて `tool_execution_*` を保存する。
- `--no-session` は使わない。
- child session file を生成・取得できるようにする。

### background

- tool call は child process を spawn して即 return。
- process handle は in-memory registry に保持する。
- stdout/stderr は artifact に追記する。
- 完了時に `status.json` と `result.md` を更新する。
- UI がある場合は `pi.sendMessage(..., { deliverAs: "followUp" })` か `ctx.ui.notify` で完了通知する。

### child Pi 起動引数

基本形。

```sh
pi --mode json -p --session <child-session-file> [model/thinking/tools options] "Task: ..."
```

検証が必要な点。

- `--session <path>` が存在しない file を作成できるか
- `--session-id` の方が安全か
- `--fork <parent-session>` と `--session <child-session>` の併用可否
- `-p` 実行で session が保存されるか

検証結果により `session.ts` の実装を決める。

## context inheritance 方針

v2 初期は API を予約し、実装は段階導入する。

### v2.0

- `inherit_context: true` または `context: "fork"` が指定されたら、未対応なら明示エラー。
- silent fallback は禁止。

### v2.1

- 親 session file と leaf id を取得する。
- Pi CLI の `--fork <path|id>` を使って child session を作る。
- fork できない場合は実行しない。
- 親の subagent tool-call/tool-result 履歴を可能なら context hook で除去する。

## resume 方針

### v2.0

- 完了済み run の `sessionFile` がある場合のみ resume を試す。
- `subagent({ action: "resume", id, message })` は background false の foreground resume として開始する。
- 実装が不安定な場合は `resume` を experimental と明記する。

### v2.1

- background resume 対応。
- `get_subagent_result` に session path と resume hint を表示する。

## interrupt 方針

- in-memory registry に process がある場合は `SIGTERM`。
- 5 秒後に生存していれば `SIGKILL`。
- artifact の state を `interrupted` に更新する。
- process が見つからないが status が `running` の場合は stale として扱う。
- stale の場合は `status` で「この Pi プロセスからは interrupt できない」と返す。

## UI / render 方針

v2.0 では既存 render を整理して流用する。

- foreground single/parallel/chain は現在の表示を維持しつつ、run id と session path を出す。
- background start は compact に ID と確認方法を表示する。
- status/result は collapsed と expanded を分ける。
- child の tool call を `read` / `bash` / `grep` 風に整形する処理は `render.ts` へ移動する。

v2.1 以降で widget を追加する。

- `ctx.ui.setWidget("subagents", ...)`
- active background runs の一覧
- running / queued / completed / failed の数
- token / turn / elapsed

## concurrency 方針

- 現行の parallel 上限 `MAX_PARALLEL_TASKS = 8`、concurrency `4` を維持。
- background run にも global queue を導入する。
- 初期は process 内 queue。永続 queue は後続。
- 同一 Pi プロセス内での background だけ管理対象にする。
- stale run reconciliation は v2.1 以降。

## worktree 方針

v2.2 で対応する。

API 候補。

```ts
subagent({
  tasks: [...],
  worktree: true
})
```

または reference-style。

```ts
subagent({
  subagent_type: "worker",
  prompt: "...",
  isolation: "worktree"
})
```

仕様。

- git repo でない場合は fail fast。
- HEAD commit がない場合は fail fast。
- `git worktree add` 失敗時は unisolated に fallback しない。
- 完了後に diff stat と patch path を result に追記。
- cleanup は finally で行う。

## settings 方針

v2.1 以降で設定ファイルを読む。

候補。

```json
{
  "subagents": {
    "disableBuiltins": false,
    "maxConcurrent": 4,
    "defaultRunInBackground": false,
    "agentAliases": {
      "Explore": "scout"
    },
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4-5",
        "thinking": "high",
        "tools": ["read", "bash"]
      }
    }
  }
}
```

読み込み順。

1. `~/.pi/agent/settings.json`
2. nearest `.pi/settings.json`
3. project が user を override

## テスト計画

TDD で進める。

### unit tests

#### `agents.test.ts`

- 既存テスト維持
- `run_in_background` / `inherit_context` / `max_turns` parse
- snake_case / camelCase 両対応
- `enabled: false` skip
- project override user

#### `schemas.test.ts`

- `subagent_type + prompt` を内部 `RunRequest` に正規化
- `agent + task` を内部 `RunRequest` に正規化
- `Agent` tool params を `RunRequest` に正規化
- 複数 mode 指定は invalid
- `inherit_context` 未対応時の validation

#### `runner.test.ts`

mock `spawn` または mock Pi script を使う。

- child args に `--session` が含まれる
- model/thinking/tools/exclude-tools が反映される
- stdout JSON event から messages / usage を集計
- stderr を保存
- abort で SIGTERM → SIGKILL timer
- temp prompt cleanup

#### `jobs.test.ts`

- background run id 生成
- status transition
- artifact write
- result retrieval
- interrupt transition
- stale running detection

#### `status.test.ts`

- list/status/result formatting
- truncated output
- failed result formatting
- verbose result formatting

### integration tests

mock Pi script を用意する。

- foreground single
- foreground parallel concurrency
- chain previous output injection
- background start returns id immediately
- background status running → completed
- `get_subagent_result` alias
- interrupt running mock process

### 手動確認

- `npm run check`
- `pi --list-models -e .`
- `pi -e .` で以下を確認
  - `subagent({ action: "list" })`
  - foreground single
  - background start / status / result
  - project-local agent 実行時の確認 dialog
  - child に `subagent` が露出しないこと

## 実装フェーズ

### Phase 0: 現状整理と基盤分割

目的: 振る舞いを変えずに分割する。

作業。

- `types.ts` を追加
- `schemas.ts` を追加
- `runner.ts` を追加
- `render.ts` を追加
- `status.ts` を追加
- `src/index.ts` を登録と routing 中心に縮小
- 既存テストを通す

完了条件。

- 既存 API が壊れていない
- `npm run check` が通る

### Phase 1: reference-style API 互換

目的: `subagent_type` / `prompt` / `Agent` に対応する。

作業。

- schema に reference-style params を追加
- normalizer を実装
- `Agent` alias tool を追加
- `get_subagent_result` は未実装なら friendly error
- README に API 互換を追記

完了条件。

- `subagent({ subagent_type, prompt })` が動く
- `Agent({ subagent_type, prompt })` が動く
- 現行 `agent/task` が動く

### Phase 2: session 保存と foreground 改善

目的: `--no-session` を廃止し、child session path を保存する。

作業。

- child session file path 生成
- Pi CLI の session 挙動を検証
- `runner.ts` で `--session` を使う
- result details に session path を含める
- render に session path / run id を表示

完了条件。

- foreground run の child session が残る
- result details から session path を確認できる

### Phase 3: background / status / result

目的: 参考リポジトリに近い async 体験の最小版を作る。

作業。

- `jobs.ts` 実装
- artifact 保存
- `run_in_background` 実装
- `subagent({ action: "status" })`
- `subagent({ action: "result" })`
- `get_subagent_result` 実装
- 完了通知の最小実装

完了条件。

- background run が即 id を返す
- running/completed status を取得できる
- result を後から取得できる
- 完了時に artifact が残る

### Phase 4: interrupt / stale handling

目的: background run を止められるようにする。

作業。

- in-memory process registry
- `subagent({ action: "interrupt" })`
- state transition
- stale running detection
- status message 整備

完了条件。

- 実行中 process を interrupt できる
- stale run が分かる

### Phase 5: resume experimental

目的: 保存された child session を使った続行を試験導入する。

作業。

- `subagent({ action: "resume", id, message })`
- `resume` param alias
- child session がない場合の明示エラー
- foreground resume から開始

完了条件。

- 完了済み child に追加指示を送れる
- 失敗時に理由が明確

### Phase 6: context inheritance

目的: `inherit_context` / `context: "fork"` を silent fallback なしで実装する。

作業。

- parent session file / leaf id 取得
- Pi CLI `--fork` 検証
- forked child session 作成
- parent-only subagent artifacts の除去方針実装
- unsupported 状況の fail fast

完了条件。

- fork 指定時に親会話を引き継ぐ
- fork 不能時に fresh 実行へ落ちない

### Phase 7: worktree isolation

目的: 並列編集の安全性を上げる。

作業。

- `worktree.ts`
- `isolation: "worktree"` / `worktree: true`
- git repo validation
- setup / cleanup
- diff stat / patch 保存

完了条件。

- worktree 指定時は別 checkout で実行される
- worktree 作成不能時は fail fast

### Phase 8: settings / widget

目的: 日常利用の操作性を上げる。

作業。

- settings 読み込み
- agentOverrides
- concurrency 設定
- built-in disable
- active run widget

完了条件。

- user/project settings が効く
- active background run が TUI で見える

## migration 方針

現行ユーザー向けに互換を維持する。

- `agent` / `task` は残す
- `tasks` / `chain` は残す
- `agentScope` / `confirmProjectAgents` は残す
- frontmatter の既存項目は残す
- `general-purpose` は残すが、README で「唯一の fallback」と説明する

破壊的変更を避けるため、reference-style API は追加として導入する。

## リスクと対策

### Pi CLI session 挙動が想定と違う

対策。

- Phase 2 の最初に検証する。
- `--session-id` / `--session-dir` を代替案にする。
- どうしても難しければ artifact の JSONL 保存を独自に行い、resume は v2.1 に延期する。

### background process が Pi 終了後に孤児化する

対策。

- v2.0 では session-scoped と明記する。
- `session_shutdown` で running child を terminate するか、設定で detached を選べるようにする。
- 永続 background は v2.1 以降。

### project 配下 artifact 書き込みが拒否される

対策。

- user dir fallback を用意する。
- `Operation not permitted` は回避せずユーザーへ報告する。

### API が肥大化する

対策。

- schema normalizer で内部型を一本化する。
- alias tool は薄く保つ。
- README は「推奨 API」と「互換 API」を分ける。

### child に subagent tool が露出して再帰暴走する

対策。

- 現行の `PI_THIN_SUBAGENTS_CHILD` を維持する。
- default では `subagent` / `Agent` / `get_subagent_result` / `steer_subagent` を除外する。
- 明示的に `tools: subagent` が指定された agent だけ許可する設計は後続。

## README 更新方針

Phase ごとに README を更新する。

- reference-style API
- background / status / result
- agent frontmatter 一覧
- compatibility note
- limitations
- artifact 保存先
- project-local agent の信頼モデル

## 完了判定

v2.0 としては次を満たせば「薄すぎる」状態を脱したと判断する。

- `subagent_type` / `prompt` 形式で実行できる
- `Agent` 互換 tool がある
- background 実行できる
- status / result を取得できる
- child session または artifact が残る
- interrupt できる
- 現行 API も壊れていない
- `npm run check` が通る
- `pi -e .` で手動確認済み
