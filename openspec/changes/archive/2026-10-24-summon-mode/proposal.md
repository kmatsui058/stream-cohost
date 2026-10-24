# Proposal

## Why

2026-10-21 の配信で、相方（gemini-3.8-live）が呼ばれていないのに独り言に答え、不確かなことを断定し、相手の言葉を言い直すだけの返事を繰り返した。同じ場面を評価した結果、考えてから答えるテキストのモデル（gemini-4-argon）のほうが答えの中身がよかった。遅延（5〜6 秒）は許容できる。ただし Argon は Live API に対応していないので、「聞く」と「答える」を分ける。

また、Live の接続の都合で 7〜10 分ごとに要約して張り直していたため、要約が短く（600〜760 字）細部が落ちていた。

## What Changes

- **聞く**：Live API は文字起こし専用のモデル（`gemini-3.5-transcribe-live`）だけに使う。日本語に固定し、相方の名前や用語を聞き取りやすい語として登録する。無音で区切られた発話を 1 件ずつ受け取る。相方の返事は生成させない
- **召喚と退去**：待機中は何も答えない。発話（またはチャット）に相方の名前（既定「オルダ」「ヴァール」）が入ったら召喚され、会話モードに入る。会話モードの間は、区切られた発話ごとに答える役に問い合わせる。相方が会話は終わったと判断したら、返事に退去の合図（【退去】）を付けて待機に戻る。安全策の自動退去は設けない
- **答える**：答える役は通常の生成 API のモデル（既定 `gemini-4-argon`）。渡すのは、ペルソナ・今日の配信・前回の配信・ここまでの要約（指示）と、要約以降の記録すべて・直近の配信画面の静止画（既定 3 枚）。返事は文に区切って読み上げる。「スルー」だけなら読み上げない
- **記憶**：要約はセッションの張り直しと切り離し、要約していない記録が一定量（既定 12,000 字）たまったら作る。要約のモデルを `gemini-3.8-flash`、上限を 4,000 字に上げ、残すものを細かく指示する
- **画面**：取り込んだ画面は AI に流し続けず、直近の数枚を手元に持っておき、問い合わせのときに添える
- **立ち絵**：召喚中だけ表示し、退去すると消える
- **廃止**：沈黙時に相方から話しかける機能、場が空いたときにチャットを渡す仕組み、コンテキストの大きさによる張り直し、配信の情報が変わったときの張り直し

## Capabilities

### New Capabilities

- `answering`: 召喚中の発話に、答える役のモデルで返事をする

### Modified Capabilities

- `live-session`: 文字起こし専用のセッションにする
- `turn-taking`: 召喚・会話・退去のライフサイクルにする
- `conversation-memory`: 要約の時機・分量・モデル、問い合わせの材料の組み立て
- `screen-capture`: 直近の画面を持っておく
- `stream-overlay`: 召喚中だけ立ち絵を表示する
- `stream-info`: 配信の情報が変わっても張り直さない（問い合わせのたびに最新を使う）
- `operator-controls`: コンソールの操作と設定の既定値

## Impact

- `src/listener.js`（新規、`src/gemini.js` を置き換え）、`src/responder.js`（新規）、`src/director.js`、`src/memory.js`、`src/app.js`、`src/config.js`、`src/overlay.js`、`public/overlay-core.js`、`public/overlay.css`、`persona.md`、`.env.example`、README
- テスト：`test/listener.test.js`（新規）、`test/responder.test.js`（新規）、`test/director.test.js`、`test/memory.test.js`、`test/app.test.js`、`test/config.test.js`、`test/overlay-*.test.js`
- 費用：聞く役は 1 分あたり約 $0.009。答える役は召喚中の発話 1 件あたり数セント
