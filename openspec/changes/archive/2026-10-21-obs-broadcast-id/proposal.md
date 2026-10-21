# Proposal

## Why

チャットの読み取りと配信情報（タイトル・概要欄）の取得には、配信の動画 ID が必要で、今は起動後に `v <動画ID>` を入力するか `.env` に書く必要がある。初配信では入力を忘れて、チャットを一度も読まなかった。OBS で配信枠を選んでいれば、OBS の配信設定に動画 ID（`broadcast_id`）が入るので、それを読めば手入力が要らなくなる。

## What Changes

- OBS につながったとき、配信の開始・停止のとき、15 秒おきに、OBS の配信設定から配信枠の動画 ID を読む
- 動画 ID が前回読んだものから変わっていたら、チャットの読み取り先と配信情報を、その配信に切り替える
- 動画 ID の指定は、`.env`・`v` コマンド・OBS のうち、最後に起きたものを使う。同じ ID への切り替えは行わない

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `live-chat`: OBS で選んだ配信枠の読み取りと、対象の配信の決め方の要件を追加する（既存の要件は変えない）

## Impact

- `src/obs.js`、`src/youtube.js`、`src/app.js`、README
- テスト：`test/obs.test.js`、`test/youtube.test.js`、`test/app.test.js`
- YouTube API の消費は増えない（OBS への問い合わせは PC 内で完結する）
