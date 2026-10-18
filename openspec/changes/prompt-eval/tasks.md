# Tasks

## 1. チェックとケース

- [x] 1.1 `eval/checks.js` に、返事のチェック（長さ、疑問、「ですね」、サポート口調、共感の定型句、自己言及、呼び方）と集計を実装する。確認：`test/eval-checks.test.js` の「返事をルールでチェックする」のテストが通る
- [x] 1.2 `eval/cases.json` に、初配信のログから選んだ 15 ケースを置く。確認：ケースのファイルを読み込むテストが通る

## 2. 実行と書き出し

- [x] 2.1 `eval/run.js` で、今の persona と比較用の persona（`--baseline <git の版>`、既定は配信で使っていた版）でケースを実行し、Markdown に書き出す。`npm run eval` を追加し、`eval/results/` を git の対象外にする。確認：実際に実行して、結果のファイルができる

## Workflow follow-up

- 結果を配信者と一緒に見て、persona の次の変更を決める。
- マージ後に、この変更をアーカイブする。
