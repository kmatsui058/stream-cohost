# Proposal

## Why

`logs/summary.txt` は「今回の要約」を確認用に上書きしているだけで、アプリは読まない。累積の要約（`logs/carryover.json`）と各回の要約（`logs/sessions/`）ができたので、3 か所目の確認用ファイルは紛らわしい。

## What Changes

- 要約を更新しても `logs/summary.txt` を書き出さない。要約の内容は、これまでどおりログに記録する
- 記憶の確認は `logs/carryover.json`、`logs/sessions/`、配信中はコンソールの `m` で行う

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `conversation-memory`: 要約を確認できるようにする

## Impact

- `src/memory.js`、`src/app.js`、README
- テスト：`test/memory.test.js`
