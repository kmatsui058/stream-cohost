# Proposal

## Why

「なんか話のネタない？」と頼まれたときに、相方が新着情報を調べてから話せるとよい。Gemini Live には Google 検索のツールがあるが、`gemini-3.8-live` で使えるか、どれくらい遅くなるか、話の中身が良くなるかは試してみないと分からない。本番に入れる前に、評価で比べられるようにする。

## What Changes

- 評価の条件に、使わせるツール（Google 検索）を指定できるようにする
- 返事ごとに、実際に検索したかどうかを記録し、集計する
- 評価ケースのファイルを指定できるようにし、検索向けのケース（新着情報を頼むなど）を用意する
- 本番のアプリは変えない（評価の結果を見て、別の変更で入れるか決める）

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `prompt-eval`: 条件にツールを指定する要件と、検索したかを記録する要件を追加する

## Impact

- `eval/run.js`、`eval/cases-search.json`、`eval/experiments/search.json`、`eval/personas/search-hint.md`
