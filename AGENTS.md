# AGENTS.md

薄い Pi サブエージェント拡張パッケージ。`subagent` ツールの挙動を変える前に、まず `README.md` / `README.ja.md` と `src/index.ts` / `src/schemas.ts` / `src/agents.ts` を確認する。

## よく使うコマンド

```sh
npm run check
npm run test
npm run lint
npm run typecheck
```

- `npm run check`: 型チェック、Biome、Vitest をまとめて実行する。
- `npm run test`: Vitest のテストを実行する。
- `npm run lint`: Biome でチェックする。
- `npm run typecheck`: `tsc --noEmit` で型チェックする。
- `pi --list-models -e .`: ローカルパッケージとして Pi から読み込めるか確認するときに使う。

## 検証手順

- 変更後は最低限 `npm run check` を実行する。
- `subagent` ツールのパラメータ、表示、子 Pi 起動に関わる変更では、Pi に `-e .` でこの拡張を読み込ませて手動確認する。
- テスト可能な変更は TDD で進める。まず失敗するテストを追加し、実装後に `npm run test` と `npm run check` で確認する。

## 重要パス

- `package.json`: Pi パッケージ設定。`pi.extensions` で `./src/index.ts` を公開する。
- `src/index.ts`: `subagents` コマンドと `subagent` / 互換ツールの登録、実行モードの振り分け、UI 表示。
- `src/schemas.ts`: tool parameters、reference-style 互換、run 管理 action の正規化。
- `src/agents.ts`: 組み込み・ユーザー・プロジェクトエージェントの discovery と frontmatter 変換。
- `src/runner.ts`: 子 Pi 起動、引数生成、JSON イベント処理、一時プロンプトファイル cleanup。
- `src/jobs.ts` / `src/files.ts` / `src/status.ts`: background run、artifact、status/result 表示の管理。
- `README.md` / `README.ja.md`: 利用者向けの機能説明、インストール、エージェント定義例。

## コーディング / テスト規約

- 既存の TypeScript ESM スタイルに合わせる。import ではローカル TS ファイルに `.ts` 拡張子を付ける。
- コメントは処理内容ではなく Why を書く。既存コメントの粒度に合わせる。
- `subagent` の公開 API（tool parameters、frontmatter 名、README の例）を変える場合は、コードと `README.md` を同時に更新する。
- `prompt_mode` / `exclude_tools` のように snake_case と camelCase の両方を受ける項目は、互換性を壊さない。

## ワークフロー上の注意

- ユーザー定義エージェントは `~/.pi/agent/agents/*.md`、プロジェクト定義は `.pi/agents/*.md` から読む設計。
- プロジェクト定義エージェントはリポジトリ管理のプロンプトなので、確認なしに信頼する挙動へ変えない。
- 子 Pi では `PI_THIN_SUBAGENTS_CHILD` で拡張の再登録を止めている。再帰実行に関わる変更は慎重に確認する。
- `.pi/subagents/runs/` と `~/.pi/agent/subagents/<project-hash>/runs/` は実行 artifact。明示依頼がない限り編集・stage しない。
- 一時プロンプトファイルは実行後に削除する設計。失敗時の cleanup を壊さない。

## 実装の参考

- `subagent` ツールの設計・挙動を変更するときは、次の Pi subagent リポジトリも実装の参考にする。
  - <https://github.com/nicobailon/pi-subagents>
  - <https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents>
  - <https://github.com/tintinweb/pi-subagents>

## 追加ドキュメント

- 詳しい使い方と frontmatter 一覧は `README.md` を参照する。
