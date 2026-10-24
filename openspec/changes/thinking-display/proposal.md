# Proposal

## Why

召喚してから返事が来るまでの数秒〜十数秒、画面に何の変化もなく、相方が止まっているように見える。検索しているかどうかはアプリには分からない（組み込みの検索は 1 回の問い合わせの中で完結する）ので、検索に限らず「問い合わせ中（考え中）」を画面に出したい。

## What Changes

- 答える役に問い合わせている間を「考え中」として画面に知らせる（召喚直後の問い合わせ、それ以降の問い合わせ、やり直しも含む）
- 考え中は、立ち絵の表情を考え中の画像に切り替える：召喚してから最初の返事が来るまでは `huse.png`、それ以降の問い合わせ中は `guruguru.png`（立ち絵フォルダ。なければ表情は変えない）。立ち絵の濃さ（召喚直後は 0.3）はこれまでどおり
- 考え中は、字幕の位置に「…」を点滅させて表示する（再生中の字幕があるときは出さない）
- 召喚直後の立ち絵の不透明度を設定 `SUMMON_OPACITY` にする（既定 1。以前の 0.3 にしたいときは 0.3）
- 返事が届いたら（または諦めたら）考え中をやめる

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `answering`: 問い合わせ中であることを知らせる
- `stream-overlay`: 考え中の表示、考え中の画像を配信する

## Impact

- `src/director.js`、`src/app.js`、`src/overlay.js`、`public/overlay-core.js`、`public/overlay.html`、`public/overlay.css`、README
- テスト：`test/director.test.js`、`test/overlay-server.test.js`、`test/overlay-client.test.js`
