# Proposal

## Why

2026-10-21 の配信で、相方が呼ばれていないのに独り言に答えたり、不確かなことを断定して外したり、相手の言葉を言い直すだけの返事をしたりした。persona にはすでに「呼ばれたときだけ答える」「推測は推測と言う」「頼まれていない助言はしない」と書いてあるので、原因が Live のモデル（その場で即答する）にあるのか、プロンプトにあるのかを切り分けたい。そのために、同じ persona と同じケースを、考えてから答えるテキストのモデル（`gemini-3.8-flash`）でも評価できるようにする。

## What Changes

- 評価の条件に `api: "text"` を指定すると、Live ではなく通常の生成 API（`generateContent`）で返事を受け取る。考える量とツールの指定はそのまま使える
- 評価の条件ごとの「今日の配信」の情報を、ファイルで指定できるようにする（`--stream`）
- 2026-10-21 の配信のログから評価ケースを作る
- 本番のアプリは変えない

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `prompt-eval`: Live 以外のテキストのモデルでも評価できるようにする

## Impact

- `eval/run.js`、`eval/ask-text.js`（新規）、`eval/cases-1021.json`（新規）、`eval/stream-1021.json`（新規）、`eval/experiments/model-compare.json`（新規）
- テスト：`test/eval-ask-text.test.js`
