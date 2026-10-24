# Proposal

## Why

相方が喋っている間にマスターが少しでも話すと、相方の発話が止まってしまう。相づちや独り言でも止まるので、返事が最後まで聞けないことがある。かぶったときは止めずに声を小さくし、話し終えたら元に戻したい。止める・何もしないも、設定で選べるようにする。

## What Changes

- 割り込み時の動作を設定 `BARGE_IN` で選ぶ：`duck`（既定。声を小さくする）、`stop`（中断する。`1`・`true` も同じ）、`off`（何もしない。`0`・`false` も同じ）
- `duck` のとき：マスターが話している途中（聞く役の途中経過の文字起こし）で相方の声を `DUCK_VOLUME`（既定 0.3）まで下げる。発話が確定するか、途中経過が `DUCK_RELEASE_MS`（既定 1,000 ミリ秒）届かなければ元の音量に戻す
- 相方が喋り終えたら、次の発話は元の音量から始める

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `turn-taking`: 「配信者が話し始めたら黙る」を、設定で選べる割り込み時の動作にする
- `live-session`: 話している途中の文字起こしを伝える
- `speech-output`: 声を小さくする・戻す
- `stream-overlay`: 音量の指示を受けて再生音量を変える

## Impact

- `src/config.js`、`src/listener.js`、`src/director.js`、`src/speaker.js`、`src/app.js`、`public/overlay-core.js`、`.env.example`、README
- テスト：`test/config.test.js`、`test/listener.test.js`、`test/director.test.js`、`test/speaker.test.js`、`test/overlay-client.test.js`、`test/fakes/browser.js`
