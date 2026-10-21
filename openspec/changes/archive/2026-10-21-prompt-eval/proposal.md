# Proposal

## Why

persona を何度も書き換えているが、変更でどう話すようになったかを確かめる手段が、実機で話しかけることしかない。初配信のログから場面を拾い、同じ入力に対する返事を persona の版ごとに並べて比べられるようにしたい。

## What Changes

- 評価ケース（初配信のログから選んだ場面）を `eval/cases.json` に置く。各ケースは、配信者の発言や沈黙時の合図など、相方への入力 1 つからなる
- `npm run eval` で、今の persona と比較用の persona（git の版を指定。既定は配信で使っていた版）に同じ入力を与え、実際の Gemini Live から返事を受け取る
- 返事をルールでチェックする（長さ、語尾の偏り、質問、サポート口調、共感の定型句、自己言及、呼び方）
- 結果を、ケースごとに返事を並べた Markdown の表と、チェックの集計として `eval/results/` に書き出す
- 実行には課金が発生し、結果も毎回変わるので、CI では実行しない（チェックの関数だけテストする）

## Capabilities

### New Capabilities

- `prompt-eval`: persona の版ごとに、同じ入力に対する相方の返事を集めて比べる

### Modified Capabilities

（なし）

## Impact

- 追加：`eval/cases.json`、`eval/run.js`、`eval/checks.js`、`test/eval-checks.test.js`、`package.json` の `eval` スクリプト
- `.gitignore` に `eval/results/` を追加（結果はローカルにだけ残す）
- 制約：ログに画面の画像が残っていないので、入力はテキストだけ（画面への反応は評価できない）
