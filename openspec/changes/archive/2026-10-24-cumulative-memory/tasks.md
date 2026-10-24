# Tasks

## 1. 積み上げる記憶

- [x] 1.1 `src/memory.js`：要約で動作確認を残さない・「（なし）」、保存の形式（累積・今回・直近・まとめ直し済みか）、読み込み（以前の形式も）、終了時のまとめ直しと履歴ファイル。確認：conversation-memory のシナリオのテストが通る
- [x] 1.2 `src/config.js`：`LONG_SUMMARY_MAX_CHARS`（既定 20,000）。`.env.example`、README。確認：設定のテストが通る
- [x] 1.3 ログから 10/18・10/21 の最終要約を取り出し、最初の累積の要約を作る（gemini-3.8-flash を 1 回呼ぶ。実行前にマスターに確認する）

## Workflow follow-up

- マージ後に、この変更をアーカイブする。
