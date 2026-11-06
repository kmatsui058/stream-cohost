# Proposal

## Why

聞く役に、召喚の言葉「オルダ」「ヴァール」を聞き取りやすい語（customVocabulary）として登録していた。そのため、似た音がこの 2 語に寄せられ、聞き間違いの召喚が増えた。登録語がなかった 2026-10-21（発話 483 件）には「ヴァール」が一度も書き起こされなかったが、登録後の 11/5（5,073 件）は 19 件、11/6（1,147 件）は 10 件出ており、「ヴァールモスがラスボス」（バラモス）など意味の通らない箇所が多かった。

## What Changes

- 聞き取りやすくする語に、召喚の言葉を自動で入れない。`CUSTOM_VOCABULARY` に書いた語だけを入れる（既定はなし）
- 登録する語がなければ、登録語の設定そのものを送らない
- 召喚の判定（書き起こしに召喚の言葉が入っていたら召喚）は変えない
- 次の配信のログで、聞き間違いの召喚と、呼ばれ損ねを数えて比べる

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `live-session`: セッションの設定（登録語）

## Impact

- `src/config.js`、`src/listener.js`、`.env.example`、README
- テスト：`test/config.test.js`、`test/listener.test.js`、`test/app.test.js`
