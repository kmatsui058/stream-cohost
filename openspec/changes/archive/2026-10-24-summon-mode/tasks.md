# Tasks

## 1. 聞く

- [x] 1.1 `src/listener.js`：文字起こし専用のセッション（設定、音声の送信、確定した発話を伝える、切断予告と予期しない切断からの回復）。`src/gemini.js` を置き換える。確認：live-session のシナリオのテストが通る

## 2. 答える

- [x] 2.1 `src/responder.js`：答える役への問い合わせ（指示・記録・画面、時間切れ）。確認：answering のシナリオのテストが通る
- [x] 2.2 `src/director.js`：召喚・会話・退去、問い合わせを 1 つずつ、割り込み、一時停止。確認：turn-taking と answering のシナリオのテストが通る

## 3. 記憶と画面

- [x] 3.1 `src/memory.js`：1 件ずつ記録、たまったら要約、要約の作り方（3.8-flash・4,000 字）、問い合わせの材料。確認：conversation-memory のシナリオのテストが通る
- [x] 3.2 直近の画面を持っておく（`src/app.js`）。確認：screen-capture のシナリオのテストが通る

## 4. 表示・操作・設定

- [x] 4.1 召喚中だけ相方を表示する（`src/overlay.js`、`public/overlay-core.js`、`public/overlay.css`）。確認：stream-overlay のシナリオのテストが通る
- [x] 4.2 `src/config.js`、`src/app.js`（配線とコンソール操作）、`.env.example`、README、`persona.md`。確認：operator-controls のシナリオのテストが通る

## 5. 実機

- [x] 5.1 マスターが `npm start` で実際に召喚・会話・退去を試す（課金が発生するので、マスターが実施する）

## Workflow follow-up

- マージ後に、この変更をアーカイブする。
