# Proposal

## Why

persona に RO とセージの話が直接書かれていて、RO 以外の配信では使い回せない。配信ごとの内容（何のゲームか、今日は何をするか）は、配信のタイトルと概要欄に書かれているので、それを相方のコンテキストに載せれば、persona はゲームを問わない内容にできる。

## What Changes

- チャットの読み取りを始めるとき（`.env` の `YOUTUBE_VIDEO_ID` または `v` コマンド）に、同じ API 呼び出しで配信のタイトルと概要欄も受け取る（追加の API 消費なし）
- 受け取ったタイトルと概要欄を、相方への指示に「今日の配信」として入れる。概要欄は長すぎる場合に切り詰める
- セッションの途中で受け取った場合や、対象の配信が変わった場合は、張り直して反映する
- persona.md から RO とセージの記述を外し、ゲームを問わない書き方にする。発言の例も、どのゲームでも通じる場面にする

## Capabilities

### New Capabilities

- `stream-info`: 配信のタイトルと概要欄を取得し、相方のコンテキストに載せる

### Modified Capabilities

（なし。既存の要件は変えない）

## Impact

- `src/youtube.js`、`src/memory.js`、`src/app.js`、`persona.md`、README
- テスト：`test/youtube.test.js`、`test/memory.test.js`、`test/app.test.js`
