# Proposal

## Why

相方の声をナースロボ＿タイプＴに、キャラクターを配信者オリジナルの「オルダ・ヴァール」にする。ナースロボ＿タイプＴの公式立ち絵は、規約で「他のキャラクターとして扱うこと」と二次配布が禁止されているため、オルダ・ヴァールの姿としては使えない。そこで立ち絵は使わず、「SOUND ONLY」の表示で存在を示し、喋っていることは表示の明るさで伝える。配信の邪魔にならないよう、画面の左下に小さく出す。

## What Changes

- **BREAKING** 立ち絵と口パク（口の開閉の切り替え）、立ち絵がないときの仮表示をやめる
- 画面の左下に、「SOUND ONLY」と相方の表示名を小さく出す。喋っていない間は暗く、再生音量に合わせて明るくなる
- 字幕は画面中央下の大きな表示をやめ、SOUND ONLY 表示の右に小さく出す
- 相方の表示名を設定できるようにする（既定は `ORÐA-VÁR`）。画面がつながったときに、制御側から画面へ表示名を送る
- 声の既定値をナースロボ＿タイプＴ ノーマル（VOICEVOX の話者 ID 47）に変える
- persona.md を、オルダ・ヴァール（配信者の人工精霊）の設定に書き換える（たたき台。配信者が手を入れる前提）
- 初回のスモークテストで未実施だった手順 7〜10 と、今回の表示の確認を行う

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `stream-overlay`: 立ち絵と口パクを、SOUND ONLY 表示と明るさの変化に置き換える。表示名の受け渡しを追加する
- `operator-controls`: 設定の既定値に、表示名と声の既定値の変更を反映する

## Impact

- `public/overlay.html`、`public/overlay-core.js`、`src/overlay.js`、`src/app.js`、`src/config.js`、`persona.md`、`.env.example`、`README.md`
- テスト：`test/overlay-client.test.js`、`test/overlay-server.test.js`、`test/config.test.js`、`test/app.test.js`
- 配信の概要欄のクレジット表記が「VOICEVOX:ナースロボ＿タイプＴ」に変わる
