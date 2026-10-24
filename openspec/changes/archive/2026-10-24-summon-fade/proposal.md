# Proposal

## Why

召喚された直後から相方がはっきり表示されると、返事が来るまでの 5〜10 秒が「出ているのに黙っている」状態に見える。現れたばかりは薄く出し、話し始めるときにはっきりさせたい。

## What Changes

- 召喚された直後は、相方を不透明度 0.3 で表示する
- 最初の返事を話し始める直前に、不透明度 1 にする。その後は退去するまで 1 のまま
- 退去して再び召喚されたら、また 0.3 から始める

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `stream-overlay`: 「召喚中だけ相方を表示する」に、薄い表示からはっきりした表示への切り替えを加える

## Impact

- `public/overlay-core.js`、`public/overlay.css`
- テスト：`test/overlay-client.test.js`
