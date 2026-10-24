# Proposal

## Why

2026-10-24 の配信前テストで、召喚した直後の最初の問い合わせが 2 回とも返ってこず、60 秒で時間切れになった（2 回目以降は 4〜17 秒で返る）。時間切れのあとは、配信者が何か話すまで次の問い合わせが起きないので、相方が黙ったままになった。原因はログからは特定できなかった。

## What Changes

- 1 回の問い合わせの待ち時間を 60 秒から 30 秒にする（`RESPONDER_TIMEOUT_MS`）
- 問い合わせが時間切れかエラーになったら、自動で 1 回だけやり直す。やり直しも失敗したら、これまでどおりエラーを記録して次の発話を待つ
- 問い合わせを始めるときに、送る量（画面の枚数、指示と記録の文字数）をログに記録する（最初の 1 回だけ返らない原因を調べるため）

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `answering`: 問い合わせの失敗で止まらない

## Impact

- `src/director.js`、`src/responder.js`、`src/config.js`、`.env.example`
- テスト：`test/director.test.js`、`test/responder.test.js`、`test/config.test.js`
