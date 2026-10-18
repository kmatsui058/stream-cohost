# Proposal

## Why

2026-10-18 の初回スモークテストで、OBS のブラウザソースをつなぐ前から、沈黙時の自発発話が約 40 秒おきに走り、誰にも聞こえない発言を 14 回していた。配信者には何も起きていないように見えるうえ、Gemini の利用量も無駄に消費する。

## What Changes

- 配信に重ねる画面（ブラウザソース）が 1 つも接続していない間は、相方から話しかける合図と、チャットの受け渡しを行わない。配信者からの話しかけへの返事は、これまでどおり行う。
- 画面がつながった時点を「最後に誰かが話した時刻」として扱い、つながった直後にいきなり話し始めないようにする。
- 自発発話を控えている状態に入ったときと抜けたときに、それぞれ 1 回だけログに記録する。

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `turn-taking`: 画面が未接続のときに自発発話とチャットの受け渡しを控える要件を追加する（既存の要件は変えない）

## Impact

- `src/director.js`、`src/overlay.js`、`src/app.js`
- テスト：`test/director.test.js`、`test/app.test.js`、`test/overlay-server.test.js`
