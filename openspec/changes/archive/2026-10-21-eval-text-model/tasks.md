# Tasks

## 1. テキストのモデルで評価する

- [ ] 1.1 `eval/ask-text.js` に、生成 API で返事を受け取る `askText` を作り、`eval/run.js` で `api: "text"` の条件に使う。確認：「テキストのモデルで評価する」の 2 シナリオのテストが通る
- [ ] 1.2 `eval/run.js` に `--stream`（今日の配信の情報のファイル）を足す
- [ ] 1.3 2026-10-21 の配信のログから評価ケース（`eval/cases-1021.json`）と、3 条件（3.8-live／3.8-live 思考あり／3.8-flash）の設定（`eval/experiments/model-compare.json`）を作る
- [ ] 1.4 マスターに確認してから評価を実行し、結果をそのまま見せる

## Workflow follow-up

- マージ後に、この変更をアーカイブする。
