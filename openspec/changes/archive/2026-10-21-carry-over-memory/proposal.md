# Proposal

## Why

相方の記憶はアプリが動いている間だけで、再起動すると毎回まっさらから始まる。配信をまたいで「前回の配信で何をしていたか」を覚えていてほしい。長期の記憶（配信者や常連について蓄積していくもの）は設計が大きいので、まずは前回の要約を引き継ぐところまでにする。

## What Changes

- 終了するとき（`q` / Ctrl+C）に要約を作り、「要約＋直近の発言」を保存する。要約を更新するたびにも保存する
- 次に起動したときに保存した内容を読み込み、「前回の配信の要約」として相方への指示に入れる
- 引き継がずに起動する方法（`npm run start:fresh`）を用意する。テストの会話を本番に持ち込まないため
- 長期の記憶は対象外（別の変更で検討する）

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `conversation-memory`: 記憶の保存と、起動時の読み込み、引き継がない起動の要件を追加する

## Impact

- `src/memory.js`、`src/app.js`、`src/main.js`、`package.json`、README
- テスト：`test/memory.test.js`、`test/app.test.js`
- 保存先：`logs/carryover.json`（git には入らない）
