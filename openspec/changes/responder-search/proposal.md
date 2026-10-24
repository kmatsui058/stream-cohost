# Proposal

## Why

配信中に「Web 検索できる？」と聞いたら「そんな機能はない」と答えた。答える役（gemini-4-argon）には検索を付けていなかった。2026-10-24 に 1 回試したところ、Argon に Google 検索を付けると、検索して出典つきで答えた（9.7 秒）。

## What Changes

- 答える役への問い合わせに Google 検索を付ける。設定 `RESPONDER_SEARCH`（既定は有効。`0` で無効）
- 検索したときは、検索した言葉をログに記録する
- persona：最新の情報や、確かでない仕様は、検索して確かめてから答える

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `answering`: 検索を使えるようにする

## Impact

- `src/responder.js`、`src/config.js`、`persona.md`、`.env.example`、README
- テスト：`test/responder.test.js`、`test/config.test.js`
- 遅延：検索したときは返事が数秒遅くなる（試した 1 回は 9.7 秒）
- 費用：検索 1 回ごとに課金される（無料枠を超えた分）
