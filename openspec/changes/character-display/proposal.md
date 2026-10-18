# Proposal

## Why

相方を、配信者の人工精霊「オルダ・ヴァール」として出す。声はナースロボ＿タイプＴにするが、その公式立ち絵は規約で「他のキャラクターとして扱うこと」が禁止されているため、別の立ち絵素材（H1N4「立ち絵素材No.1【白髪幸薄系少女】」私服版。配信での利用と、トリミング・色変更などの加工は可、再配布は不可）を使う。配信の邪魔にならないよう画面の左下に小さく出し、喋っていることは表情と明るさで伝える。

## What Changes

- **BREAKING** 口の開閉の 2 枚切り替え（`public/char/closed.png` / `open.png`）と、立ち絵がないときの仮表示（緑の丸）をやめる
- 画面の左下に、全身の立ち絵を置き、上半身が見えて下半身は画面の下端で見切れる位置に出す（枠で切り取らない）。喋っていない間は `default` の表情で少し暗く（明るさ 70%）、喋っている間は `smile` の表情になり、再生音量に合わせて明るくなる
- 立ち絵の画像はリポジトリに入れない（素材の再配布が禁止されているため）。設定 `CHARACTER_DIR` で指定したフォルダから、`default.png` と `smile.png` だけを配信する
- `CHARACTER_DIR` が未設定なら、立ち絵の代わりに「SOUND ONLY」の表示を出す（明るさの変化は同じ）
- 表示名（`COHOST_DISPLAY_NAME`、既定 `ORÐA-VÁR`）を立ち絵の下に小さく出す。画面がつながったときに、制御側から表示名と立ち絵の有無を送る
- 字幕は画面中央下の大きな表示をやめ、立ち絵の右に小さく出す
- 声の既定値をナースロボ＿タイプＴ ノーマル（VOICEVOX の話者 ID 47）に変える
- persona.md を、オルダ・ヴァール（配信者の人工精霊）の設定に書き換える（たたき台。配信者が手を入れる前提）
- 初回のスモークテストで未実施だった手順 7〜10 と、今回の表示の確認を行う

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `stream-overlay`: 口の開閉と仮表示を、立ち絵の表情・明るさの変化と SOUND ONLY 表示に置き換える。立ち絵フォルダからの配信と、表示名・立ち絵の有無の受け渡しを追加する
- `operator-controls`: 設定の既定値に、表示名と声の既定値の変更を反映する

## Impact

- `public/overlay.html`、`public/overlay.css`（新規）、`public/overlay-core.js`、`src/overlay.js`、`src/app.js`、`src/config.js`、`persona.md`、`.env.example`、`README.md`、`docs/smoke-test.md`
- テスト：`test/overlay-client.test.js`、`test/overlay-server.test.js`、`test/config.test.js`
- 配信の概要欄のクレジットに、VOICEVOX:ナースロボ＿タイプＴ と立ち絵の作者を書く
